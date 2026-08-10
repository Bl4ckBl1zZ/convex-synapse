package docker

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/Iann29/synapse/internal/sshprov"
)

// RemoteClient implements the api.Provisioner surface against a remote
// host reached over SSH. Phase 4 (provisioner/worker.go routing) will
// construct one of these per provision job whenever hosts.is_remote is
// TRUE; the local *Client stays the codepath for self-host deployments.
//
// All Docker commands flow through the synapse-deployer-exec wrapper on
// the host (installer-agent/templates/synapse-deployer-exec), which
// enforces the {run,stop,rm,start,restart,inspect,ps,logs,version}
// subcommand whitelist. Container names + labels follow the same
// conventions as the local Client (convex-<name>, synapse.managed=true).
//
// v1.18 MVP: only Provision / Destroy / Status / Restart are
// implemented. HA replicas (Recreate* / RestartReplica) and admin-key
// generation are deferred — see the stub method bodies for the why.
type RemoteClient struct {
	ssh     *sshprov.Client
	target  sshprov.Target // host this client is bound to
	image   string         // backend image pin (mirrors local Client.BackendImage)
	network string         // docker network on the remote host (currently unused; reserved for future cross-container DNS)
}

// NewRemoteClient binds a RemoteClient to a single host. Construct one
// per provision job; the *sshprov.Client itself is process-global and
// pools connections across hosts.
func NewRemoteClient(ssh *sshprov.Client, t sshprov.Target, image, network string) *RemoteClient {
	return &RemoteClient{ssh: ssh, target: t, image: image, network: network}
}

// buildEnv mirrors the env slice that Client.Provision constructs.
// Kept inline (not exported on DeploymentSpec) so the local provisioner
// stays the authoritative reference; remote duplicates the small list of
// fields we know the v1.18 path uses.
func (r *RemoteClient) buildEnv(spec DeploymentSpec) []string {
	// Container-internal origin, not the published host port — see the
	// publicOrigin comment in Client.Provision. The host binding is not
	// present in the container's network namespace, so advertising it
	// breaks every "use node" action callback.
	publicOrigin := ContainerLoopbackOrigin
	if spec.PublicURL != "" {
		publicOrigin = spec.PublicURL
	}
	siteOrigin := SiteOriginFallback(publicOrigin)
	if spec.SiteURL != "" {
		siteOrigin = spec.SiteURL
	}
	env := []string{
		"INSTANCE_NAME=" + spec.Name,
		"INSTANCE_SECRET=" + spec.InstanceSecret,
		"CONVEX_CLOUD_ORIGIN=" + publicOrigin,
		"CONVEX_SITE_ORIGIN=" + siteOrigin,
	}
	if spec.Storage != nil {
		s := spec.Storage
		env = append(env,
			"POSTGRES_URL="+s.PostgresURL,
			"S3_ENDPOINT_URL="+s.S3Endpoint,
			"AWS_REGION="+s.S3Region,
			"AWS_ACCESS_KEY_ID="+s.S3AccessKey,
			"AWS_SECRET_ACCESS_KEY="+s.S3SecretKey,
			"S3_STORAGE_FILES_BUCKET="+s.BucketFiles,
			"S3_STORAGE_MODULES_BUCKET="+s.BucketModules,
			"S3_STORAGE_SEARCH_BUCKET="+s.BucketSearch,
			"S3_STORAGE_EXPORTS_BUCKET="+s.BucketExports,
			"S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET="+s.BucketSnapshots,
		)
		if s.DoNotRequireSSL {
			env = append(env, "DO_NOT_REQUIRE_SSL=true")
		}
	}
	for k, v := range spec.EnvVars {
		env = append(env, k+"="+v)
	}
	return env
}

func (r *RemoteClient) Provision(ctx context.Context, spec DeploymentSpec) (*DeploymentInfo, error) {
	if spec.Name == "" || spec.InstanceSecret == "" || spec.HostPort == 0 {
		return nil, errors.New("remote provision: name, instance secret, and host port required")
	}
	if spec.HAReplica {
		return nil, errors.New("remote: HA replicas not supported on remote hosts in v1.18 — use single-replica path")
	}

	cName := ContainerName(spec.Name, spec.ReplicaIndex, spec.HAReplica)
	vName := VolumeName(spec.Name, spec.ReplicaIndex, spec.HAReplica)

	// 1. Ensure the volume exists. `docker volume create` is idempotent
	//    (no-op when present), so we don't need a precheck.
	if _, err := r.ssh.Run(ctx, r.target, nil, "docker", "volume", "create", vName); err != nil {
		return nil, fmt.Errorf("remote: volume create: %w", err)
	}

	// 2. docker run — bind to the host's tailnet IP only so the container
	//    is reachable by Synapse central via the tailnet, NOT by the
	//    public internet on this VPS. The proxy upstream will be
	//    "<tailnet-ip>:<host-port>".
	portBinding := fmt.Sprintf("%s:%d:3210", r.target.TailnetAddr, spec.HostPort)
	argv := []string{
		"docker", "run", "-d",
		"--name", cName,
		"--restart", "unless-stopped",
		"--label", "synapse.managed=true",
		"--label", "synapse.deployment=" + spec.Name,
	}
	if spec.DeploymentID != "" {
		argv = append(argv, "--label", "synapse.deployment_id="+spec.DeploymentID)
	}
	if spec.ProjectID != "" {
		argv = append(argv, "--label", "synapse.project_id="+spec.ProjectID)
	}
	// SQLite path → bind a per-deployment data volume. Postgres+S3 mode
	// (Storage != nil) keeps everything in shared storage — no volume.
	if spec.Storage == nil {
		argv = append(argv, "--volume", vName+":/convex/data")
	}
	argv = append(argv, "--publish", portBinding)
	for _, e := range r.buildEnv(spec) {
		argv = append(argv, "-e", e)
	}
	argv = append(argv, r.image)

	if _, err := r.ssh.Run(ctx, r.target, nil, argv...); err != nil {
		return nil, fmt.Errorf("remote: docker run: %w", err)
	}

	// 3. Inspect to read back the container ID for the deployment row.
	res, err := r.ssh.Run(ctx, r.target, nil, "docker", "inspect", "--format", "{{.Id}}", cName)
	if err != nil {
		return nil, fmt.Errorf("remote: inspect after run: %w", err)
	}
	containerID := strings.TrimSpace(string(res.Stdout))

	return &DeploymentInfo{
		ContainerID:   containerID,
		HostPort:      spec.HostPort,
		DeploymentURL: "http://" + r.target.TailnetAddr + ":" + strconv.Itoa(spec.HostPort),
		HostAddr:      r.target.TailnetAddr,
	}, nil
}

func (r *RemoteClient) Destroy(ctx context.Context, deploymentName string) error {
	cName := containerName(deploymentName)
	vName := volumeName(deploymentName)

	// docker rm -f tolerates a missing container — surface stderr only
	// when the message isn't the expected "No such container".
	res, err := r.ssh.Run(ctx, r.target, nil, "docker", "rm", "-f", cName)
	if err != nil && !isNoSuchContainerRemote(res.Stderr) {
		return fmt.Errorf("remote: docker rm: %w", err)
	}
	res, err = r.ssh.Run(ctx, r.target, nil, "docker", "volume", "rm", vName)
	if err != nil && !isNoSuchVolumeRemote(res.Stderr) {
		return fmt.Errorf("remote: docker volume rm: %w", err)
	}
	return nil
}

func (r *RemoteClient) Status(ctx context.Context, deploymentName string) (string, error) {
	cName := containerName(deploymentName)
	res, err := r.ssh.Run(ctx, r.target, nil, "docker", "inspect", "--format", "{{.State.Status}}", cName)
	if err != nil {
		if isNoSuchContainerRemote(res.Stderr) {
			// Mirror local Client.status() which returns ("", nil) for
			// missing containers. Phase 4 callers translate that into
			// the "failed" deployment row.
			return "", nil
		}
		return "", fmt.Errorf("remote: inspect: %w", err)
	}
	return strings.TrimSpace(string(res.Stdout)), nil
}

func (r *RemoteClient) Restart(ctx context.Context, deploymentName string) error {
	cName := containerName(deploymentName)
	res, err := r.ssh.Run(ctx, r.target, nil, "docker", "restart", cName)
	if err != nil {
		if isNoSuchContainerRemote(res.Stderr) {
			return ErrContainerNotFound
		}
		return fmt.Errorf("remote: restart: %w", err)
	}
	return nil
}

// GenerateAdminKey: the convex-backend `generate_key` binary signs a
// short-lived admin token using INSTANCE_SECRET, which Synapse central
// already knows (it persisted the secret before provisioning). Phase 4
// will run this LOCALLY on Synapse central — there is no reason to
// involve the remote host. Until that wiring lands, callers asking a
// RemoteClient for an admin key get a clear error.
func (r *RemoteClient) GenerateAdminKey(ctx context.Context, instanceName, instanceSecret string) (string, error) {
	return "", errors.New("remote: GenerateAdminKey should run on synapse-central, not via SSH; Phase 4 handles the wiring")
}

// Recreate / RecreateReplica / RestartReplica: deferred to v1.19. The
// custom-domains rebuild path that calls Recreate is single-host today
// (it edits CORS_ALLOWED_ORIGINS without touching state); HA on remote
// hosts is its own multi-replica orchestration problem.
func (r *RemoteClient) Recreate(ctx context.Context, spec DeploymentSpec) (*DeploymentInfo, error) {
	return nil, errors.New("remote: Recreate not implemented in v1.18 — Phase 4 uses destroy+provision instead")
}

func (r *RemoteClient) RecreateReplica(ctx context.Context, spec DeploymentSpec) (*DeploymentInfo, error) {
	return nil, errors.New("remote: HA replicas not supported on remote hosts in v1.18")
}

func (r *RemoteClient) RestartReplica(ctx context.Context, deploymentName string, replicaIndex int) error {
	return errors.New("remote: HA replicas not supported on remote hosts in v1.18")
}

func isNoSuchContainerRemote(stderr []byte) bool {
	return strings.Contains(string(stderr), "No such container")
}

func isNoSuchVolumeRemote(stderr []byte) bool {
	s := string(stderr)
	return strings.Contains(s, "No such volume") || strings.Contains(s, "no such volume")
}
