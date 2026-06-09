package api

import (
	"context"
	"testing"

	dockerprov "github.com/Iann29/synapse/internal/docker"
	"github.com/Iann29/synapse/internal/models"
)

// dockerForFakeLocal satisfies api.Provisioner without a Docker daemon.
// It records Destroy/Restart so a test can prove the LOCAL client was
// (or wasn't) the dispatch target.
type dockerForFakeLocal struct {
	destroyed []string
	restarted []string
}

func (f *dockerForFakeLocal) Provision(context.Context, dockerprov.DeploymentSpec) (*dockerprov.DeploymentInfo, error) {
	return nil, nil
}
func (f *dockerForFakeLocal) Destroy(_ context.Context, name string) error {
	f.destroyed = append(f.destroyed, name)
	return nil
}
func (f *dockerForFakeLocal) Status(context.Context, string) (string, error) { return "", nil }
func (f *dockerForFakeLocal) GenerateAdminKey(context.Context, string, string) (string, error) {
	return "", nil
}
func (f *dockerForFakeLocal) Recreate(context.Context, dockerprov.DeploymentSpec) (*dockerprov.DeploymentInfo, error) {
	return nil, nil
}
func (f *dockerForFakeLocal) RecreateReplica(context.Context, dockerprov.DeploymentSpec) (*dockerprov.DeploymentInfo, error) {
	return nil, nil
}
func (f *dockerForFakeLocal) Restart(_ context.Context, name string) error {
	f.restarted = append(f.restarted, name)
	return nil
}
func (f *dockerForFakeLocal) RestartReplica(context.Context, string, int) error { return nil }
func (f *dockerForFakeLocal) DestroyReplica(_ context.Context, name string, _ int, _ bool) error {
	f.destroyed = append(f.destroyed, name)
	return nil
}

// dockerForFakeRemote is what the RemoteDocker factory returns in tests.
type dockerForFakeRemote struct {
	destroyed []string
	restarted []string
}

func (f *dockerForFakeRemote) Destroy(_ context.Context, name string) error {
	f.destroyed = append(f.destroyed, name)
	return nil
}
func (f *dockerForFakeRemote) Restart(_ context.Context, name string) error {
	f.restarted = append(f.restarted, name)
	return nil
}

func TestDockerFor_LocalDeployment_UsesLocalDocker(t *testing.T) {
	local := &dockerForFakeLocal{}
	factoryCalled := false
	h := &DeploymentsHandler{
		Docker: local,
		RemoteDocker: func(RemoteTarget) RemoteDeployer {
			factoryCalled = true
			return &dockerForFakeRemote{}
		},
	}
	got, err := h.dockerFor(&models.Deployment{Name: "happy-cat-1234", HostIsRemote: false})
	if err != nil {
		t.Fatalf("dockerFor(local) err = %v", err)
	}
	if fp, ok := got.(*dockerForFakeLocal); !ok || fp != local {
		t.Fatalf("dockerFor(local) = %T, want the local Docker client", got)
	}
	if factoryCalled {
		t.Fatal("RemoteDocker factory must NOT be invoked for a self-host deployment")
	}
}

func TestDockerFor_RemoteDeployment_BindsHostTarget(t *testing.T) {
	local := &dockerForFakeLocal{}
	remote := &dockerForFakeRemote{}
	var gotTarget RemoteTarget
	h := &DeploymentsHandler{
		Docker: local,
		RemoteDocker: func(tg RemoteTarget) RemoteDeployer {
			gotTarget = tg
			return remote
		},
	}
	d := &models.Deployment{
		Name:            "happy-cat-1234",
		HostIsRemote:    true,
		HostID:          "host-1",
		HostTailnetAddr: "100.64.0.1",
		HostSSHUser:     "synapse-deployer",
		HostSSHPort:     2222,
	}
	got, err := h.dockerFor(d)
	if err != nil {
		t.Fatalf("dockerFor(remote) err = %v", err)
	}
	if rd, ok := got.(*dockerForFakeRemote); !ok || rd != remote {
		t.Fatalf("dockerFor(remote) = %T, want the remote dispatcher", got)
	}
	want := RemoteTarget{HostID: "host-1", TailnetAddr: "100.64.0.1", SSHUser: "synapse-deployer", SSHPort: 2222}
	if gotTarget != want {
		t.Fatalf("RemoteDocker target = %+v, want %+v", gotTarget, want)
	}
	// The local daemon must stay untouched — that's the whole bug fix:
	// a remote teardown that runs locally silently leaks the remote
	// container+volume.
	if len(local.destroyed) != 0 || len(local.restarted) != 0 {
		t.Fatalf("local Docker was used for a remote deployment: destroyed=%v restarted=%v",
			local.destroyed, local.restarted)
	}
}

func TestDockerFor_RemoteWithoutFactory_Errors(t *testing.T) {
	// Remote Hosts disabled (RemoteDocker nil) but a deployment row
	// claims a remote host: refuse loudly instead of silently running
	// the teardown against the local daemon.
	h := &DeploymentsHandler{Docker: &dockerForFakeLocal{}}
	if _, err := h.dockerFor(&models.Deployment{
		Name: "happy-cat-1234", HostIsRemote: true, HostTailnetAddr: "100.64.0.1",
	}); err == nil {
		t.Fatal("dockerFor(remote, nil factory) should error, got nil")
	}
}

func TestDockerFor_RemoteWithoutTailnet_Errors(t *testing.T) {
	h := &DeploymentsHandler{
		Docker:       &dockerForFakeLocal{},
		RemoteDocker: func(RemoteTarget) RemoteDeployer { return &dockerForFakeRemote{} },
	}
	if _, err := h.dockerFor(&models.Deployment{
		Name: "happy-cat-1234", HostIsRemote: true, HostTailnetAddr: "",
	}); err == nil {
		t.Fatal("dockerFor(remote, no tailnet) should error, got nil")
	}
}
