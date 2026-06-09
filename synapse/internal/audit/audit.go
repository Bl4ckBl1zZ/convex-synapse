// Package audit is a small, best-effort writer for the audit_events table.
//
// Design choice: audit logging MUST NOT be a failure mode for the user's
// request. If we can't write the row (transient DB error, network glitch),
// we log via slog and return — callers don't need to handle the error.
// That trade-off is fine because audit events are observability, not a
// transactional guarantee — losing one in 10,000 to a flaky network is
// preferable to surfacing 500s on the user-visible mutation that triggered
// it.
//
// Action names mirror Convex Cloud's vocabulary where it exists (see
// dashboard-management-openapi.json's auditLogActions). For names that have
// no Cloud counterpart we pick a verb that matches the existing pattern
// (camelCase, verb+noun).
package audit

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Action names. Stable strings stored in the DB; do not rename without a
// migration that rewrites historical rows.
const (
	// Auth.
	ActionLogin = "login"

	// Teams.
	ActionCreateTeam       = "createTeam"
	ActionUpdateTeam       = "updateTeam"
	ActionDeleteTeam       = "deleteTeam"
	ActionInviteTeamMember = "inviteTeamMember"
	ActionCancelInvite     = "cancelInvite"
	ActionAcceptInvite     = "acceptInvite"
	ActionUpdateMemberRole = "updateMemberRole"
	ActionRemoveMember     = "removeMember"

	// Project-level RBAC (v1.0+, migration 000008). Project member
	// actions live alongside team-member actions because they share
	// the same audit_events shape; the metadata.scope field
	// distinguishes "team" vs "project".
	ActionAddProjectMember        = "addProjectMember"
	ActionUpdateProjectMemberRole = "updateProjectMemberRole"
	ActionRemoveProjectMember     = "removeProjectMember"

	// Profile (account-scoped, no team).
	ActionUpdateProfileName = "updateProfileName"
	ActionDeleteAccount     = "deleteAccount"

	// Projects.
	ActionCreateProject   = "createProject"
	ActionDeleteProject   = "deleteProject"
	ActionRenameProject   = "renameProject"
	ActionUpdateProject   = "updateProject"
	ActionTransferProject = "transferProject"
	ActionUpdateEnvVars   = "updateProjectEnvVars"
	// v1.9.2+: explicit operator action that recreates every running
	// deployment of a project so they pick up the current
	// project_env_vars values. Distinct from updateProjectEnvVars
	// (which only writes the table); used by the "Apply to existing
	// deployments" button in the dashboard.
	ActionSyncEnvToDeployments = "syncEnvToDeployments"
	// v1.17+: when project_env_vars are pushed into the Convex backend's
	// function runtime env store (the one functions actually read via
	// process.env). Distinct from updateProjectEnvVars (which only writes
	// the project_env_vars table) and from syncEnvToDeployments (which
	// is the operator-triggered fan-out). Emitted from the auto-sync
	// path on updateEnvVars + from the per-deployment seed at provision
	// time. Metadata: {deploymentName, applied, dropped}.
	ActionUpdateFunctionEnvVars = "updateFunctionEnvVars"

	// Deployments.
	ActionCreateDeployment  = "createDeployment"
	ActionDeleteDeployment  = "deleteDeployment"
	ActionRestartDeployment = "restartDeployment"
	// Adopted = registered an existing external Convex backend rather than
	// provisioning a new one. Synapse-original; no Cloud equivalent.
	ActionAdoptDeployment = "adoptDeployment"
	// Upgrade = converted an existing single-replica deployment to HA.
	// Synapse-original; emitted at endpoint-enqueue time. The worker
	// emits no separate audit event today — operators trace progress via
	// provisioning_jobs.status.
	ActionUpgradeToHA = "upgradeToHA"

	// Personal access tokens. Cloud has no equivalent (it uses OAuth flows),
	// so these names are Synapse-original; verbs follow the existing
	// "<verb><Noun>" convention.
	ActionCreatePersonalAccessToken = "createPersonalAccessToken"
	ActionDeletePersonalAccessToken = "deletePersonalAccessToken"

	// Deploy keys (per-deployment, named, used by CI). The names mirror
	// Convex Cloud's /api/dashboard/team/<id>/deploy_keys vocabulary.
	ActionCreateDeployKey = "createDeployKey"
	ActionRevokeDeployKey = "revokeDeployKey"

	// Reissue admin key (v1.7+). Re-mints deployments.admin_key from the
	// existing instance_secret WITHOUT rotating the secret. Operator
	// escape hatch when the stored key drifted out of sync with the
	// running container (rare; usually after manual interventions or a
	// half-applied revoke). Distinct from createDeployKey because the
	// target is the deployment row itself, not a named row in deploy_keys.
	ActionReissueAdminKey = "reissueAdminKey"

	// Per-deployment custom domains (v1.1+, migration 000012).
	// Synapse-original; Convex Cloud manages domains at the project
	// level. Matches the existing "<verb><Noun>" pattern with a
	// concrete noun ("Domain") so audit_events queries can pick out
	// the resource without joining target_id.
	ActionAddDomain    = "domain.added"
	ActionRemoveDomain = "domain.removed"
	ActionVerifyDomain = "domain.verified"
	// Cloudflare DNS auto-configure (v1.5+, migration 000015).
	// Emitted when an operator clicks "auto-configure" on a domain
	// row and Synapse mints/updates the A record on their behalf.
	ActionAutoConfigureDomain = "domain.auto_configured"

	// DNS-provider credentials (v1.5+, migration 000015). Stored at
	// the instance level (gated to instance_admin); the metadata
	// scope identifies the provider so audit queries can filter by
	// "all cloudflare credential changes" cheaply.
	ActionAddDNSCredential    = "dns_credential.added"
	ActionRemoveDNSCredential = "dns_credential.removed"

	// Project-scoped DNS-provider credentials (v1.6.4+, migration 000016).
	// Distinct from the instance-wide actions above so a team's audit
	// feed only carries credential events for that team's projects.
	// Metadata.projectId is always set for these rows.
	ActionAddProjectDNSCredential    = "project_dns_credential.added"
	ActionRemoveProjectDNSCredential = "project_dns_credential.removed"

	// Instance email settings (v1.22+, migration 000028). The Resend
	// API key is set/cleared from the dashboard's admin area; metadata
	// carries {provider, fromAddress} — never the key itself.
	ActionUpdateEmailSettings = "email_settings.updated"
	ActionClearEmailSettings  = "email_settings.cleared"

	// ActionUpdateApplySettings records a dashboard toggle of CCP apply
	// (Bloco 10). Metadata carries {applyEnabled, applyDangerous}.
	ActionUpdateApplySettings = "apply_settings.updated"

	// Instance-level upgrade flow (v1.1.0+). Synapse-original — Cloud has
	// no per-customer upgrade because Cloud is the platform.
	ActionUpgradeStarted = "upgradeStarted"

	// Host-domain reconfigure flow (v1.4+). Emitted on a successful POST
	// /v1/admin/host_domain — the actual setup.sh --reconfigure run is
	// asynchronous, so this captures "operator clicked apply" not
	// "reconfigure succeeded". Pair with /v1/admin/host_domain/status/<id>
	// for outcome.
	ActionHostDomainChangeInitiated = "host_domain.change_initiated"

	// Headscale / Remote Hosts configuration flow (v1.19+). Emitted on
	// a successful POST /v1/admin/headscale/configure — the actual
	// setup.sh --configure-headscale run is asynchronous, so this captures
	// "operator clicked apply" not "configure succeeded". Pair with
	// /v1/admin/headscale/status/<id> for outcome. Metadata carries the
	// requested Headscale domain only; API keys + pre-auth keys NEVER
	// appear in audit metadata.
	ActionHeadscaleConfigureInitiated = "headscale.configure_initiated"

	// Cell Control Plane (feat/cell-control-plane). Synapse-original; verbs
	// follow the existing "<verb><Noun>" convention. Host actions are
	// instance-level (TeamID stays empty); Cell actions carry TeamID so they
	// surface in the owning team's audit feed.
	ActionCreateHost              = "createHost"
	ActionUpdateHost              = "updateHost"
	ActionDrainHost               = "drainHost"
	ActionDeleteHost              = "deleteHost"
	ActionCreateHostAdoptionToken = "createHostAdoptionToken"
	// Remote Hosts (v1.18+). Bundle action emitted when the dashboard's
	// "Setup remote install" button mints an adoption token + a Headscale
	// pre-auth key in one shot. The plaintext token/key never appear in
	// metadata — only the host id/name + the shared expiry.
	ActionMintRemoteSetup        = "mintRemoteSetup"
	ActionCreateCell             = "createCell"
	ActionUpdateCell             = "updateCell"
	ActionDrainCell              = "drainCell"
	ActionDeleteCell             = "deleteCell"
	ActionAttachDeploymentToCell = "attachDeploymentToCell"
	// Agent lifecycle (Bloco 6.5).
	ActionRevokeHostAgent      = "revokeHostAgent"
	ActionRotateHostAgentToken = "rotateHostAgentToken"
	// Cell links + service tokens (Bloco 7).
	ActionCreateCellLink     = "createCellLink"
	ActionUpdateCellLink     = "updateCellLink"
	ActionDisableCellLink    = "disableCellLink"
	ActionCreateServiceToken = "createServiceToken"
	ActionRevokeServiceToken = "revokeServiceToken"
	// Cell Control Plane observe/plan (v1.12+). Diagnostic side of the
	// surface — no apply action exists by design (see
	// docs/SAFETY_INVARIANTS.md). Sync rebuilds desired_state from
	// deployment_placements; ComputeDrift compares desired vs observed;
	// ReconcileDryRun produces the planned-but-not-executed step list.
	ActionSyncDesiredFromPlacements = "syncDesiredFromPlacements"
	ActionComputeDrift              = "computeDrift"
	ActionReconcileDryRun           = "reconcileDryRun"
)

// Target type names.
const (
	TargetTeam        = "team"
	TargetProject     = "project"
	TargetDeployment  = "deployment"
	TargetInvite      = "invite"
	TargetAccessToken = "accessToken"
	TargetUser        = "user"
	TargetDeployKey   = "deployKey"
	// TargetDomain is a deployment_domains row — used by domain.added /
	// domain.removed / domain.verified events.
	TargetDomain = "domain"
	// TargetSynapse is the instance itself — used by upgrade events.
	TargetSynapse = "synapse"
	// TargetDNSCredential is a dns_credentials row.
	TargetDNSCredential = "dnsCredential"
	// TargetEmailSettings is the instance email_settings singleton row.
	TargetEmailSettings = "emailSettings"
	// TargetApplySettings is the instance apply_settings singleton row.
	TargetApplySettings = "applySettings"
	// Cell Control Plane (feat/cell-control-plane).
	TargetHost         = "host"
	TargetCell         = "cell"
	TargetHostAgent    = "hostAgent"
	TargetCellLink     = "cellLink"
	TargetServiceToken = "serviceToken"
)

// Options collects the optional fields of an audit event. Empty strings are
// treated as "not set" and stored as NULL.
type Options struct {
	TeamID     string         // optional UUID; empty for account-wide events
	ActorID    string         // optional UUID of the user that did the action
	Action     string         // required: e.g. "createProject"
	TargetType string         // optional: "team" | "project" | …
	TargetID   string         // optional UUID
	Metadata   map[string]any // optional, marshalled to JSONB
}

// Record writes a single audit event. Best-effort: any error is logged to
// slog at WARN and swallowed so the caller can ignore the return value.
//
// The signature still returns error for callers who want to assert in tests,
// but production code should treat the return as advisory.
func Record(ctx context.Context, db *pgxpool.Pool, opts Options) error {
	if opts.Action == "" {
		// A row without an action is meaningless — treat as a programmer
		// error but don't crash. Drop on the floor.
		slog.Default().Warn("audit.Record called without Action; dropping",
			"actor_id", opts.ActorID, "team_id", opts.TeamID)
		return nil
	}

	var teamID, actorID, targetType, targetID *string
	if opts.TeamID != "" {
		teamID = &opts.TeamID
	}
	if opts.ActorID != "" {
		actorID = &opts.ActorID
	}
	if opts.TargetType != "" {
		targetType = &opts.TargetType
	}
	if opts.TargetID != "" {
		targetID = &opts.TargetID
	}

	// Marshal metadata to JSON. nil/empty stays NULL so JSONB queries can
	// distinguish "no metadata" from "{}".
	var metadata []byte
	if len(opts.Metadata) > 0 {
		raw, err := json.Marshal(opts.Metadata)
		if err != nil {
			slog.Default().Warn("audit: marshal metadata failed",
				"err", err, "action", opts.Action)
			// Continue without metadata rather than dropping the whole event.
		} else {
			metadata = raw
		}
	}

	_, err := db.Exec(ctx, `
		INSERT INTO audit_events (team_id, actor_id, action, target_type, target_id, metadata)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, teamID, actorID, opts.Action, targetType, targetID, metadata)
	if err != nil {
		slog.Default().Warn("audit: insert failed",
			"err", err,
			"action", opts.Action,
			"team_id", opts.TeamID,
			"actor_id", opts.ActorID)
		return err
	}
	return nil
}
