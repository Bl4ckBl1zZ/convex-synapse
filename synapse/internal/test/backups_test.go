package synapsetest

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/backups"
	dockerprov "github.com/Iann29/synapse/internal/docker"
)

// Per-deployment snapshot backups (v1.25+). The export/import containers
// are faked (FakeDocker.Export/ImportBackupFn); the queue, row lifecycle,
// retention sweep, download streaming, and gates are real.

type backupResp struct {
	ID           string  `json:"id"`
	DeploymentID string  `json:"deploymentId"`
	Status       string  `json:"status"`
	SizeBytes    *int64  `json:"sizeBytes,omitempty"`
	Error        string  `json:"error,omitempty"`
	RequestedBy  string  `json:"requestedBy,omitempty"`
	CreateTime   string  `json:"createTime"`
	CompletedAt  *string `json:"completedAt,omitempty"`
	RestoredAt   *string `json:"restoredAt,omitempty"`
}

// fakeArchiveExporter makes the FakeDocker write a real file at the
// spec's RelPath so the worker's stat + the download handler have
// something to chew on.
func fakeArchiveExporter(dir string, payload []byte) func(context.Context, dockerprov.BackupExportSpec) error {
	return func(_ context.Context, spec dockerprov.BackupExportSpec) error {
		full := filepath.Join(dir, spec.RelPath)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		return os.WriteFile(full, payload, 0o644)
	}
}

func waitForBackupStatus(t *testing.T, h *Harness, bearer, deployment, backupID, want string) backupResp {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last backupResp
	for time.Now().Before(deadline) {
		var list []backupResp
		h.DoJSON(http.MethodGet, "/v1/deployments/"+deployment+"/backups", bearer, nil, http.StatusOK, &list)
		for _, b := range list {
			if b.ID == backupID {
				last = b
				if b.Status == want {
					return b
				}
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("backup %s never reached %q (last: %+v)", backupID, want, last)
	return last
}

// Happy path: request → worker exports via the fake → complete with size
// → download streams the exact bytes with attachment headers.
func TestBackups_RequestCompleteDownload(t *testing.T) {
	dir := t.TempDir()
	h := SetupWithOpts(t, SetupOpts{BackupDir: dir})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Backup Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	h.SeedDeployment(proj.ID, "bk-cat-1234", "dev", "running", false, owner.ID, 4300, "k")

	payload := []byte("PK\x03\x04 fake zip payload for backup test")
	h.Docker.ExportBackupFn = fakeArchiveExporter(dir, payload)

	var created backupResp
	h.DoJSON(http.MethodPost, "/v1/deployments/bk-cat-1234/backups",
		owner.AccessToken, map[string]any{}, http.StatusAccepted, &created)
	if created.Status != "pending" || created.RequestedBy != owner.ID {
		t.Fatalf("created: %+v", created)
	}

	done := waitForBackupStatus(t, h, owner.AccessToken, "bk-cat-1234", created.ID, "complete")
	if done.SizeBytes == nil || *done.SizeBytes != int64(len(payload)) {
		t.Errorf("sizeBytes = %v, want %d", done.SizeBytes, len(payload))
	}
	specs := h.Docker.ExportedSpecs()
	if len(specs) != 1 || specs[0].SourceURL != "http://convex-bk-cat-1234:3210" {
		t.Errorf("export specs: %+v", specs)
	}
	if specs[0].AdminKey != "k" {
		t.Errorf("export admin key = %q, want the deployment's", specs[0].AdminKey)
	}

	resp := h.Do(http.MethodGet, "/v1/deployments/bk-cat-1234/backups/"+created.ID+"/download",
		owner.AccessToken, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("download status = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/zip" {
		t.Errorf("Content-Type = %q", ct)
	}
	if cd := resp.Header.Get("Content-Disposition"); !strings.Contains(cd, "attachment") || !strings.Contains(cd, "bk-cat-1234") {
		t.Errorf("Content-Disposition = %q", cd)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != string(payload) {
		t.Errorf("downloaded %d bytes != uploaded %d", len(body), len(payload))
	}
}

// A failing export marks the backup failed with the error — and never
// touches the deployment's own status.
func TestBackups_ExportFailureMarksFailed(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "BackupFail Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	id := h.SeedDeployment(proj.ID, "bk-fail-1234", "dev", "running", false, owner.ID, 4301, "k")

	// Default fake export writes NO file → the worker's stat check fails.
	var created backupResp
	h.DoJSON(http.MethodPost, "/v1/deployments/bk-fail-1234/backups",
		owner.AccessToken, map[string]any{}, http.StatusAccepted, &created)
	failed := waitForBackupStatus(t, h, owner.AccessToken, "bk-fail-1234", created.ID, "failed")
	if !strings.Contains(failed.Error, "archive missing") {
		t.Errorf("error = %q, want the missing-archive explanation", failed.Error)
	}

	var depStatus string
	if err := h.DB.QueryRow(context.Background(),
		`SELECT status FROM deployments WHERE id = $1`, id).Scan(&depStatus); err != nil {
		t.Fatalf("read deployment: %v", err)
	}
	if depStatus != "running" {
		t.Errorf("deployment status = %q after backup failure, want running (never clobbered)", depStatus)
	}
}

// Restore: enqueues an import with the archive path + live target, stamps
// restoredAt. Admin-only (member 403); the backup row stays complete.
func TestBackups_RestoreFlowAndGate(t *testing.T) {
	dir := t.TempDir()
	h := SetupWithOpts(t, SetupOpts{BackupDir: dir})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Restore Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	h.SeedDeployment(proj.ID, "bk-rest-1234", "dev", "running", false, owner.ID, 4302, "k")
	h.Docker.ExportBackupFn = fakeArchiveExporter(dir, []byte("zipzip"))

	var created backupResp
	h.DoJSON(http.MethodPost, "/v1/deployments/bk-rest-1234/backups",
		owner.AccessToken, map[string]any{}, http.StatusAccepted, &created)
	waitForBackupStatus(t, h, owner.AccessToken, "bk-rest-1234", created.ID, "complete")

	// Plain team member = project member → can back up, can NOT restore.
	member := h.RegisterRandomUser()
	addTeamMember(t, h, team.ID, member.ID, "member")
	h.AssertStatus(http.MethodPost,
		"/v1/deployments/bk-rest-1234/backups/"+created.ID+"/restore",
		member.AccessToken, map[string]any{}, http.StatusForbidden)

	h.DoJSON(http.MethodPost,
		"/v1/deployments/bk-rest-1234/backups/"+created.ID+"/restore",
		owner.AccessToken, map[string]any{}, http.StatusAccepted, &struct {
			OK       bool   `json:"ok"`
			BackupID string `json:"backupId"`
		}{})

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(h.Docker.ImportedSpecs()) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	imports := h.Docker.ImportedSpecs()
	if len(imports) != 1 {
		t.Fatalf("imports = %d, want 1", len(imports))
	}
	if imports[0].RelPath == "" || !strings.HasSuffix(imports[0].RelPath, created.ID+".zip") {
		t.Errorf("import RelPath = %q", imports[0].RelPath)
	}
	if len(imports[0].TargetURLs) != 1 || imports[0].TargetURLs[0] != "http://convex-bk-rest-1234:3210" {
		t.Errorf("import targets = %v", imports[0].TargetURLs)
	}

	// restoredAt lands on the row; status stays complete.
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var list []backupResp
		h.DoJSON(http.MethodGet, "/v1/deployments/bk-rest-1234/backups",
			owner.AccessToken, nil, http.StatusOK, &list)
		if len(list) == 1 && list[0].RestoredAt != nil {
			if list[0].Status != "complete" {
				t.Errorf("status after restore = %q, want complete", list[0].Status)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("restoredAt never stamped")
}

// Gates on request: adopted / remote / stopped refused with stable codes;
// a second request while one is in flight is 409.
func TestBackups_RequestGates(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "BG Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")

	h.SeedDeployment(proj.ID, "bg-adopt-1234", "dev", "running", false, owner.ID, 4303, "k")
	if _, err := h.DB.Exec(context.Background(),
		`UPDATE deployments SET adopted = true WHERE name = 'bg-adopt-1234'`); err != nil {
		t.Fatal(err)
	}
	env := h.AssertStatus(http.MethodPost, "/v1/deployments/bg-adopt-1234/backups",
		owner.AccessToken, map[string]any{}, http.StatusConflict)
	if env.Code != "cannot_backup_adopted" {
		t.Errorf("adopted: code = %q", env.Code)
	}

	_, _ = h.SeedRemoteDeployment(proj.ID, "bg-rem-1234", "dev", "running", owner.ID, 4304, "k", "")
	env = h.AssertStatus(http.MethodPost, "/v1/deployments/bg-rem-1234/backups",
		owner.AccessToken, map[string]any{}, http.StatusConflict)
	if env.Code != "remote_backup_not_supported" {
		t.Errorf("remote: code = %q", env.Code)
	}

	h.SeedDeployment(proj.ID, "bg-stop-1234", "dev", "stopped", false, owner.ID, 4305, "k")
	env = h.AssertStatus(http.MethodPost, "/v1/deployments/bg-stop-1234/backups",
		owner.AccessToken, map[string]any{}, http.StatusConflict)
	if env.Code != "deployment_not_running" {
		t.Errorf("stopped: code = %q", env.Code)
	}

	// In-flight cap: seed a pending row directly, second request 409s.
	h.SeedDeployment(proj.ID, "bg-busy-1234", "dev", "running", false, owner.ID, 4306, "k")
	var depID string
	_ = h.DB.QueryRow(context.Background(),
		`SELECT id FROM deployments WHERE name = 'bg-busy-1234'`).Scan(&depID)
	if _, err := h.DB.Exec(context.Background(),
		`INSERT INTO deployment_backups (deployment_id, status, file_path) VALUES ($1, 'running', 'x/y.zip')`,
		depID); err != nil {
		t.Fatal(err)
	}
	env = h.AssertStatus(http.MethodPost, "/v1/deployments/bg-busy-1234/backups",
		owner.AccessToken, map[string]any{}, http.StatusConflict)
	if env.Code != "backup_in_progress" {
		t.Errorf("busy: code = %q", env.Code)
	}
}

// Delete removes the row AND the archive; in-flight rows are protected.
func TestBackups_DeleteRemovesRowAndFile(t *testing.T) {
	dir := t.TempDir()
	h := SetupWithOpts(t, SetupOpts{BackupDir: dir})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "BD Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	h.SeedDeployment(proj.ID, "bd-owl-1234", "dev", "running", false, owner.ID, 4307, "k")
	h.Docker.ExportBackupFn = fakeArchiveExporter(dir, []byte("zip"))

	var created backupResp
	h.DoJSON(http.MethodPost, "/v1/deployments/bd-owl-1234/backups",
		owner.AccessToken, map[string]any{}, http.StatusAccepted, &created)
	waitForBackupStatus(t, h, owner.AccessToken, "bd-owl-1234", created.ID, "complete")

	var depID string
	_ = h.DB.QueryRow(context.Background(),
		`SELECT deployment_id FROM deployment_backups WHERE id::text = $1`, created.ID).Scan(&depID)
	archive := filepath.Join(dir, depID+"/"+created.ID+".zip")
	if _, err := os.Stat(archive); err != nil {
		t.Fatalf("archive should exist before delete: %v", err)
	}

	h.DoJSON(http.MethodPost, "/v1/deployments/bd-owl-1234/backups/"+created.ID+"/delete",
		owner.AccessToken, map[string]any{}, http.StatusOK, &struct {
			OK bool `json:"ok"`
		}{})
	if _, err := os.Stat(archive); !os.IsNotExist(err) {
		t.Errorf("archive still on disk after delete: %v", err)
	}
	var list []backupResp
	h.DoJSON(http.MethodGet, "/v1/deployments/bd-owl-1234/backups",
		owner.AccessToken, nil, http.StatusOK, &list)
	if len(list) != 0 {
		t.Errorf("list after delete = %+v, want empty", list)
	}
}

// backup_settings: validation + persisted on the deployment row.
func TestBackups_Settings(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "BS Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	h.SeedDeployment(proj.ID, "bs-elk-1234", "dev", "running", false, owner.ID, 4308, "k")

	var got struct {
		BackupSchedule  string `json:"backupSchedule"`
		BackupRetention int    `json:"backupRetention"`
	}
	h.DoJSON(http.MethodPost, "/v1/deployments/bs-elk-1234/backup_settings",
		owner.AccessToken, map[string]any{"schedule": "daily", "retention": 5},
		http.StatusOK, &got)
	if got.BackupSchedule != "daily" || got.BackupRetention != 5 {
		t.Errorf("settings resp: %+v", got)
	}

	var dep deploymentResp
	h.DoJSON(http.MethodGet, "/v1/deployments/bs-elk-1234", owner.AccessToken, nil, http.StatusOK, &dep)
	if dep.BackupSchedule != "daily" || dep.BackupRetention != 5 {
		t.Errorf("GET deployment: schedule=%q retention=%d", dep.BackupSchedule, dep.BackupRetention)
	}

	for _, bad := range []map[string]any{
		{"schedule": "weekly", "retention": 5},
		{"schedule": "daily", "retention": 0},
		{"schedule": "daily", "retention": 91},
	} {
		h.AssertStatus(http.MethodPost, "/v1/deployments/bs-elk-1234/backup_settings",
			owner.AccessToken, bad, http.StatusBadRequest)
	}
}

// The sweeper: a schedule='daily' deployment with no recent backup gets
// exactly one job per tick window; retention prunes the oldest complete
// rows and their files.
func TestBackups_SweeperScheduleAndRetention(t *testing.T) {
	dir := t.TempDir()
	h := SetupWithOpts(t, SetupOpts{BackupDir: dir})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Sweep Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	h.SeedDeployment(proj.ID, "sw-fox-1234", "dev", "running", false, owner.ID, 4309, "k")
	h.Docker.ExportBackupFn = fakeArchiveExporter(dir, []byte("zip"))

	h.DoJSON(http.MethodPost, "/v1/deployments/sw-fox-1234/backup_settings",
		owner.AccessToken, map[string]any{"schedule": "daily", "retention": 2},
		http.StatusOK, &struct {
			BackupSchedule  string `json:"backupSchedule"`
			BackupRetention int    `json:"backupRetention"`
		}{})

	sweeper := &backups.Sweeper{DB: h.DB, BackupDir: dir}
	sweeper.Tick(context.Background())

	// One backup enqueued; the harness worker completes it via the fake.
	var list []backupResp
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.DoJSON(http.MethodGet, "/v1/deployments/sw-fox-1234/backups",
			owner.AccessToken, nil, http.StatusOK, &list)
		if len(list) == 1 && list[0].Status == "complete" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(list) != 1 || list[0].Status != "complete" {
		t.Fatalf("after first tick: %+v", list)
	}
	if list[0].RequestedBy != "" {
		t.Errorf("scheduler backup should have empty requestedBy, got %q", list[0].RequestedBy)
	}

	// Second tick inside the 24h window: nothing new.
	sweeper.Tick(context.Background())
	time.Sleep(300 * time.Millisecond)
	h.DoJSON(http.MethodGet, "/v1/deployments/sw-fox-1234/backups",
		owner.AccessToken, nil, http.StatusOK, &list)
	if len(list) != 1 {
		t.Fatalf("second tick minted a duplicate: %+v", list)
	}

	// Retention: backdate the fresh backup + seed two older complete rows
	// with real files → retention=2 keeps the 2 newest, prunes the oldest.
	var depID string
	_ = h.DB.QueryRow(context.Background(),
		`SELECT id FROM deployments WHERE name = 'sw-fox-1234'`).Scan(&depID)
	mkArchive := func(rel string) {
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("old"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var oldestID string
	for i, age := range []string{"72 hours", "48 hours"} {
		var id string
		if err := h.DB.QueryRow(context.Background(), `
			INSERT INTO deployment_backups (deployment_id, status, created_at, completed_at)
			VALUES ($1, 'complete', now() - $2::interval, now() - $2::interval)
			RETURNING id
		`, depID, age).Scan(&id); err != nil {
			t.Fatal(err)
		}
		rel := depID + "/" + id + ".zip"
		if _, err := h.DB.Exec(context.Background(),
			`UPDATE deployment_backups SET file_path = $1 WHERE id = $2`, rel, id); err != nil {
			t.Fatal(err)
		}
		mkArchive(rel)
		if i == 0 {
			oldestID = id
		}
	}

	sweeper.Tick(context.Background())
	h.DoJSON(http.MethodGet, "/v1/deployments/sw-fox-1234/backups",
		owner.AccessToken, nil, http.StatusOK, &list)
	if len(list) != 2 {
		t.Fatalf("after retention tick: %d rows, want 2 (%+v)", len(list), list)
	}
	for _, b := range list {
		if b.ID == oldestID {
			t.Errorf("oldest backup survived retention")
		}
	}
	if _, err := os.Stat(filepath.Join(dir, depID+"/"+oldestID+".zip")); !os.IsNotExist(err) {
		t.Errorf("pruned backup's archive still on disk: %v", err)
	}
}

// Strangers see nothing; viewers can list but not download.
func TestBackups_RBAC(t *testing.T) {
	dir := t.TempDir()
	h := SetupWithOpts(t, SetupOpts{BackupDir: dir})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "BR Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	h.SeedDeployment(proj.ID, "br-bat-1234", "dev", "running", false, owner.ID, 4310, "k")
	h.Docker.ExportBackupFn = fakeArchiveExporter(dir, []byte("zip"))

	var created backupResp
	h.DoJSON(http.MethodPost, "/v1/deployments/br-bat-1234/backups",
		owner.AccessToken, map[string]any{}, http.StatusAccepted, &created)
	waitForBackupStatus(t, h, owner.AccessToken, "br-bat-1234", created.ID, "complete")

	stranger := h.RegisterRandomUser()
	h.AssertStatus(http.MethodGet, "/v1/deployments/br-bat-1234/backups",
		stranger.AccessToken, nil, http.StatusForbidden)

	viewer := h.RegisterRandomUser()
	addTeamMember(t, h, team.ID, viewer.ID, "member")
	if _, err := h.DB.Exec(context.Background(),
		`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')`,
		proj.ID, viewer.ID); err != nil {
		t.Fatal(err)
	}
	var list []backupResp
	h.DoJSON(http.MethodGet, "/v1/deployments/br-bat-1234/backups",
		viewer.AccessToken, nil, http.StatusOK, &list)
	if len(list) != 1 {
		t.Errorf("viewer list = %d rows, want 1", len(list))
	}
	h.AssertStatus(http.MethodGet,
		"/v1/deployments/br-bat-1234/backups/"+created.ID+"/download",
		viewer.AccessToken, nil, http.StatusForbidden)
	h.AssertStatus(http.MethodPost, "/v1/deployments/br-bat-1234/backups",
		viewer.AccessToken, map[string]any{}, http.StatusForbidden)
}
