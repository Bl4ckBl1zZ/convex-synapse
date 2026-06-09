package docker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/pkg/stdcopy"
)

// BackupsVolume is the named Docker volume that holds per-deployment
// snapshot archives. It is shared between two mounts of the same volume:
// the synapse-api container (compose mounts it at SYNAPSE_BACKUP_DIR,
// default /backups, so the API can stream downloads and prune files) and
// the short-lived CLI containers below (which write/read the archives).
// Docker auto-creates the volume on first bind; the fixed name keeps it
// stable across compose projects and upgrades.
const BackupsVolume = "synapse-backups"

// backupCLIImage runs the official Convex CLI for export/import — the
// same throwaway-Node approach MigrateSnapshot uses (Synapse's own image
// is distroless, no node/npm).
const backupCLIImage = "node:22-alpine"

// BackupExportSpec drives one snapshot export: hit the deployment's
// backend with the admin key, produce a zip, land it at RelPath inside
// the backups volume.
type BackupExportSpec struct {
	DeploymentName string
	// DeploymentID / ProjectID label the transient container for
	// traceability, like the migration container. Empty → omitted.
	DeploymentID string
	ProjectID    string
	SourceURL    string
	AdminKey     string
	// RelPath is where the archive must land, RELATIVE to the backups
	// volume root (e.g. "<deploymentID>/<backupID>.zip"). Relative so the
	// API container and the CLI container can mount the volume at
	// different paths and still agree.
	RelPath string
}

// BackupImportSpec drives one snapshot restore: feed the stored zip back
// into the deployment with `convex import --replace` (destructive — the
// deployment's current data is replaced wholesale). TargetURLs lists the
// replica endpoints; importing into ANY live replica suffices because HA
// replicas share Postgres+S3 state, mirroring MigrateSnapshot.
type BackupImportSpec struct {
	DeploymentName string
	DeploymentID   string
	ProjectID      string
	TargetURLs     []string
	AdminKey       string
	RelPath        string
}

// ExportBackup runs `npx convex export` against the deployment and moves
// the resulting zip to spec.RelPath on the backups volume. Blocking —
// callers run it from the provisioner job queue, never a request handler.
func (c *Client) ExportBackup(ctx context.Context, spec BackupExportSpec) error {
	if spec.SourceURL == "" || spec.AdminKey == "" || spec.RelPath == "" {
		return errors.New("backup export: missing source url, admin key, or path")
	}
	if err := validateBackupRelPath(spec.RelPath); err != nil {
		return err
	}
	if err := c.ensureImage(ctx, backupCLIImage); err != nil {
		return err
	}

	// The export lands in a per-run scratch dir first (the CLI names the
	// zip itself), then moves atomically-enough to the final RelPath.
	// The convex CLI refuses to run outside "a Convex app": it wants a
	// package.json with convex in dependencies in the cwd — a minimal
	// stub satisfies it (verified against convex@latest).
	script := `
set -eu
mkdir -p /work && cd /work
printf '{"dependencies":{"convex":"*"}}' > package.json
scratch="/backups/.export-$$"
mkdir -p "$scratch"
trap 'rm -rf "$scratch"' EXIT
CONVEX_SELF_HOSTED_URL="$SOURCE_CONVEX_SELF_HOSTED_URL" \
CONVEX_SELF_HOSTED_ADMIN_KEY="$SOURCE_CONVEX_SELF_HOSTED_ADMIN_KEY" \
  npx --yes convex@latest export --path "$scratch"
archive="$(find "$scratch" -maxdepth 1 -type f -name '*.zip' | sort | tail -n 1)"
if [ -z "$archive" ]; then
  echo "convex export completed without producing a zip archive" >&2
  exit 1
fi
mkdir -p "$(dirname "/backups/$BACKUP_REL_PATH")"
mv "$archive" "/backups/$BACKUP_REL_PATH"
`
	env := []string{
		"SOURCE_CONVEX_SELF_HOSTED_URL=" + spec.SourceURL,
		"SOURCE_CONVEX_SELF_HOSTED_ADMIN_KEY=" + spec.AdminKey,
		"BACKUP_REL_PATH=" + spec.RelPath,
		"CONVEX_DISABLE_ANALYTICS=1",
	}
	return c.runBackupContainer(ctx, "backup", spec.DeploymentName, spec.DeploymentID, spec.ProjectID, script, env, spec.AdminKey)
}

// ImportBackup feeds a stored archive back into the deployment. The first
// target that accepts the import wins (shared-state HA semantics, same as
// MigrateSnapshot).
func (c *Client) ImportBackup(ctx context.Context, spec BackupImportSpec) error {
	targets := make([]string, 0, len(spec.TargetURLs))
	for _, t := range spec.TargetURLs {
		if strings.TrimSpace(t) != "" {
			targets = append(targets, strings.TrimSpace(t))
		}
	}
	if len(targets) == 0 || spec.AdminKey == "" || spec.RelPath == "" {
		return errors.New("backup import: missing target urls, admin key, or path")
	}
	if err := validateBackupRelPath(spec.RelPath); err != nil {
		return err
	}
	if err := c.ensureImage(ctx, backupCLIImage); err != nil {
		return err
	}

	script := `
set -eu
mkdir -p /work && cd /work
printf '{"dependencies":{"convex":"*"}}' > package.json
if [ ! -f "/backups/$BACKUP_REL_PATH" ]; then
  echo "backup archive not found on the backups volume" >&2
  exit 1
fi
import_ok=0
while IFS= read -r target; do
  [ -n "$target" ] || continue
  if CONVEX_SELF_HOSTED_URL="$target" \
     CONVEX_SELF_HOSTED_ADMIN_KEY="$TARGET_CONVEX_SELF_HOSTED_ADMIN_KEY" \
       npx --yes convex@latest import --replace "/backups/$BACKUP_REL_PATH"; then
    import_ok=1
    break
  fi
done <<'TARGET_URLS_EOF'
` + strings.Join(targets, "\n") + `
TARGET_URLS_EOF
if [ "$import_ok" != "1" ]; then
  echo "convex import failed for every target replica" >&2
  exit 1
fi
`
	env := []string{
		"TARGET_CONVEX_SELF_HOSTED_ADMIN_KEY=" + spec.AdminKey,
		"BACKUP_REL_PATH=" + spec.RelPath,
		"CONVEX_DISABLE_ANALYTICS=1",
	}
	return c.runBackupContainer(ctx, "restore", spec.DeploymentName, spec.DeploymentID, spec.ProjectID, script, env, spec.AdminKey)
}

// validateBackupRelPath rejects anything that could escape the backups
// volume root when the script interpolates "/backups/$BACKUP_REL_PATH".
// The path is server-generated (uuid/uuid.zip) so this is a backstop, not
// an input filter.
func validateBackupRelPath(rel string) error {
	if strings.Contains(rel, "..") || strings.HasPrefix(rel, "/") || path.Clean(rel) != rel {
		return fmt.Errorf("backup: unsafe archive path %q", rel)
	}
	return nil
}

// runBackupContainer is the shared transient-container runner for
// export/import: attach to the deployments network, bind the backups
// volume, wait for exit, surface redacted logs on failure. Mirrors
// MigrateSnapshot's lifecycle exactly.
func (c *Client) runBackupContainer(ctx context.Context, task, deploymentName, deploymentID, projectID, script string, env []string, adminKey string) error {
	containerName := fmt.Sprintf("synapse-%s-%s-%d", task, deploymentName, time.Now().UnixNano())
	resp, err := c.api.ContainerCreate(ctx, &container.Config{
		Image: backupCLIImage,
		Cmd:   []string{"sh", "-lc", script},
		Env:   env,
		Labels: mergeLabels(map[string]string{
			"synapse.managed":    "true",
			"synapse.task":       task,
			"synapse.deployment": deploymentName,
		}, deploymentID, projectID),
	}, &container.HostConfig{
		Binds: []string{BackupsVolume + ":/backups"},
	}, &network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{
			c.Network: {},
		},
	}, nil, containerName)
	if err != nil {
		return fmt.Errorf("create %s container: %w", task, err)
	}
	defer func() {
		_ = c.api.ContainerRemove(context.Background(), resp.ID, container.RemoveOptions{Force: true})
	}()

	if err := c.api.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return fmt.Errorf("start %s container: %w", task, err)
	}

	statusCh, errCh := c.api.ContainerWait(ctx, resp.ID, container.WaitConditionNotRunning)
	select {
	case err := <-errCh:
		if err != nil {
			return fmt.Errorf("wait %s container: %w", task, err)
		}
	case status := <-statusCh:
		if status.StatusCode != 0 {
			return fmt.Errorf("%s failed: %s", task, c.backupLogs(ctx, resp.ID, adminKey))
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

func (c *Client) backupLogs(ctx context.Context, containerID, adminKey string) string {
	rc, err := c.api.ContainerLogs(ctx, containerID, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Tail:       "80",
	})
	if err != nil {
		return "could not read logs: " + err.Error()
	}
	defer rc.Close()
	// The log stream is stdcopy-multiplexed (8-byte binary frame headers
	// with NUL bytes). Demux instead of raw-copying — the result lands in
	// a Postgres TEXT column, which rejects 0x00 outright.
	var stdout, stderr bytes.Buffer
	_, _ = stdcopy.StdCopy(&stdout, &stderr, rc)
	out := stdout.String()
	if stderr.Len() > 0 {
		out += "\n" + stderr.String()
	}
	out = strings.ReplaceAll(out, adminKey, "[redacted]")
	out = strings.ToValidUTF8(strings.ReplaceAll(out, "\x00", ""), "")
	if len(out) > 4000 {
		out = out[len(out)-4000:]
	}
	return strings.TrimSpace(out)
}
