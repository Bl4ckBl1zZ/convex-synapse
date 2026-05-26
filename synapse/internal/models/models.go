// Package models holds the domain types persisted by Synapse.
//
// Field names match the OpenAPI v1 platform schema where applicable so that
// JSON marshalling produces wire-compatible responses; Go-side fields use
// idiomatic naming and conversions happen in the api/ layer when needed.
package models

import "time"

type User struct {
	ID              string    `json:"id"`
	Email           string    `json:"email"`
	Name            string    `json:"name"`
	IsInstanceAdmin bool      `json:"isInstanceAdmin,omitempty"`
	PasswordHash    string    `json:"-"`
	CreatedAt       time.Time `json:"createTime"`
	UpdatedAt       time.Time `json:"updateTime"`
}

type Team struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Slug          string    `json:"slug"`
	CreatorUserID string    `json:"creator"`
	DefaultRegion string    `json:"defaultRegion"`
	Suspended     bool      `json:"suspended"`
	CreatedAt     time.Time `json:"createTime"`
}

type TeamMember struct {
	TeamID    string    `json:"teamId"`
	UserID    string    `json:"id"`
	Role      string    `json:"role"`
	Email     string    `json:"email,omitempty"`
	Name      string    `json:"name,omitempty"`
	CreatedAt time.Time `json:"createTime"`
}

type Project struct {
	ID        string    `json:"id"`
	TeamID    string    `json:"teamId"`
	TeamSlug  string    `json:"teamSlug,omitempty"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	IsDemo    bool      `json:"isDemo"`
	CreatedAt time.Time `json:"createTime"`
}

type ProjectEnvVar struct {
	ID              string    `json:"id"`
	ProjectID       string    `json:"projectId"`
	Name            string    `json:"name"`
	Value           string    `json:"value"`
	DeploymentTypes []string  `json:"deploymentTypes"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

const (
	DeploymentTypeDev     = "dev"
	DeploymentTypeProd    = "prod"
	DeploymentTypePreview = "preview"
	DeploymentTypeCustom  = "custom"

	DeploymentStatusProvisioning = "provisioning"
	DeploymentStatusRunning      = "running"
	DeploymentStatusStopped      = "stopped"
	DeploymentStatusFailed       = "failed"
	DeploymentStatusDeleted      = "deleted"
)

// Deployment is the metadata Synapse persists for a provisioned Convex backend.
// Fields like AdminKey/InstanceSecret never leave the server unless explicitly
// requested via a privileged endpoint (e.g. dashboard auth).
//
// Optional timestamps use *time.Time so JSON marshalling emits null instead
// of the Go zero value ("0001-01-01T00:00:00Z").
type Deployment struct {
	ID             string `json:"id"`
	ProjectID      string `json:"projectId"`
	Name           string `json:"name"`
	DeploymentType string `json:"deploymentType"`
	Status         string `json:"status"`
	ContainerID    string `json:"-"`
	HostPort       int    `json:"-"`
	DeploymentURL  string `json:"deploymentUrl,omitempty"`
	// SiteURL is the deployment's site-proxy URL (Convex port 3211),
	// where HTTP actions are served at their natural paths (Better Auth
	// /api/auth/*, webhooks, /engine/*). Distinct from DeploymentURL
	// (the cloud origin, port 3210). Empty when no base domain and no
	// role='site' custom domain apply. See docs/CONVEX_SITE_ORIGIN.md.
	SiteURL        string `json:"siteUrl,omitempty"`
	AdminKey       string `json:"-"`
	InstanceSecret string `json:"-"`
	IsDefault      bool   `json:"isDefault"`
	Reference      string `json:"reference,omitempty"`
	CreatorUserID  string `json:"creator,omitempty"`
	// Adopted deployments are external backends registered into Synapse
	// (rather than provisioned by it). Lifecycle hooks like delete skip
	// Docker calls for these rows; the operator manages the container.
	Adopted bool `json:"adopted,omitempty"`
	// HA flags (v0.5+). HAEnabled=false + ReplicaCount=1 is the default
	// and matches every deployment that existed before v0.5. The fields
	// are exposed in API responses so dashboard / CLI tooling can render
	// "ha (2 replicas)" badges without a second round-trip.
	HAEnabled    bool       `json:"haEnabled,omitempty"`
	ReplicaCount int        `json:"replicaCount,omitempty"`
	CreatedAt    time.Time  `json:"createTime"`
	LastDeployAt *time.Time `json:"lastDeployTime,omitempty"`
	ExpiresAt    *time.Time `json:"expiresAt,omitempty"`
}

// DeploymentReplicaStatus enumerates the per-replica lifecycle states.
// Distinct from the deployment-level status: a deployment is
// `status=running` as long as at least one replica is `running`; only
// promotes to `failed` when all replicas are stopped/failed.
const (
	ReplicaStatusProvisioning = "provisioning"
	ReplicaStatusRunning      = "running"
	ReplicaStatusStopped      = "stopped"
	ReplicaStatusFailed       = "failed"
)

// DeploymentReplica is one running container backing a deployment. A
// single-replica deployment has exactly one of these (replica_index=0)
// mirroring its host_port + container_id; HA-enabled deployments have N.
type DeploymentReplica struct {
	ID               string     `json:"id"`
	DeploymentID     string     `json:"deploymentId"`
	ReplicaIndex     int        `json:"replicaIndex"`
	ContainerID      string     `json:"-"`
	HostPort         int        `json:"-"`
	Status           string     `json:"status"`
	LastSeenActiveAt *time.Time `json:"lastSeenActiveAt,omitempty"`
	CreatedAt        time.Time  `json:"createTime"`
}

// DeploymentStorage describes the (optional) Postgres + S3 backing for a
// deployment. SQLite + local-volume deployments have no row in
// `deployment_storage` and read no fields here.
//
// Encrypted columns (DBURL, S3AccessKey, S3SecretKey) are AES-GCM
// ciphertexts produced by internal/crypto/secrets.go. The plaintext is
// only handed to a freshly-spawned container as an env var; never
// returned over the API, never logged.
type DeploymentStorage struct {
	DeploymentID      string
	DBKind            string // "postgres" today; "mysql"/"cockroach" later
	DBURLEnc          []byte
	DBSchema          string
	S3Endpoint        string
	S3Region          string
	S3AccessKeyEnc    []byte
	S3SecretKeyEnc    []byte
	S3BucketFiles     string
	S3BucketModules   string
	S3BucketSearch    string
	S3BucketExports   string
	S3BucketSnapshots string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

const (
	RoleAdmin  = "admin"
	RoleMember = "member"
	// RoleViewer is project-scoped only — there is no team-level
	// viewer. A `project_members` row with role="viewer" downgrades a
	// team admin/member to read-only access on that one project.
	// v1.0+ via migration 000008.
	RoleViewer = "viewer"
)

// ProjectMember is a (project_id, user_id, role) override on top of
// team_members. When a row exists for (project, user), its role wins
// over the user's team-level role for that project. See migration
// 000008 for the rationale + resolution rules.
type ProjectMember struct {
	ProjectID string    `json:"projectId"`
	UserID    string    `json:"id"`
	Role      string    `json:"role"`
	Email     string    `json:"email,omitempty"`
	Name      string    `json:"name,omitempty"`
	CreatedAt time.Time `json:"createTime"`
	// Source records where the effective role came from. "project" =
	// row in project_members; "team" = fell through to team_members.
	// Useful for the dashboard members panel: "team admin (project
	// viewer)" lets operators reason about overrides at a glance.
	Source string `json:"source,omitempty"`
}

// DeployKey is a named alias for an admin key on a single deployment,
// used by CI integrations (Vercel, GitHub Actions, etc) so the operator
// gets a clean audit trail per credential. Mirrors Convex Cloud's
// "Personal Deployment Settings → Deploy Keys" UX.
//
// Revocation rotates the deployment's INSTANCE_SECRET because the Convex
// backend authenticates admin keys by signature against that stateless
// secret. That invalidates every deploy key minted before the rotation, so
// revoked_at is set on all active rows for the deployment at once.
//
// AdminKey is non-empty *only* on the create-response struct (the operator
// gets the value back exactly once, GitHub-PAT-style); subsequent reads
// see only Prefix.
type DeployKey struct {
	ID            string     `json:"id"`
	DeploymentID  string     `json:"deploymentId"`
	Name          string     `json:"name"`
	AdminKey      string     `json:"adminKey,omitempty"`
	Prefix        string     `json:"prefix"`
	CreatedBy     *string    `json:"createdBy,omitempty"`
	CreatedByName string     `json:"createdByName,omitempty"`
	CreatedAt     time.Time  `json:"createTime"`
	LastUsedAt    *time.Time `json:"lastUsedAt,omitempty"`
	RevokedAt     *time.Time `json:"revokedAt,omitempty"`
}

// DeploymentDomain is a custom domain registered against a deployment so
// remote callers can reach it at "api.example.com" instead of the
// "<name>.<base>" wildcard subdomain. The proxy/TLS layer (PR #5) reads
// rows where status='active' to make routing + on-demand TLS gating
// decisions; this model is shared with the dashboard (PR #6).
//
// Lifecycle: row inserted with status='pending'; the create-handler
// kicks a synchronous DNS preflight (5s timeout). Match → 'active';
// mismatch → 'failed' with last_dns_error populated. The /verify
// endpoint re-runs the same preflight on demand.
//
// LastDNSError is omitted on the wire when empty so successful rows
// don't carry a stale "" field.
type DeploymentDomain struct {
	ID            string     `json:"id"`
	DeploymentID  string     `json:"deploymentId"`
	Domain        string     `json:"domain"`
	Role          string     `json:"role"`
	Status        string     `json:"status"`
	DNSVerifiedAt *time.Time `json:"dnsVerifiedAt,omitempty"`
	LastDNSError  string     `json:"lastDnsError,omitempty"`
	// AutoConfigured is true when Synapse created the A record on the
	// operator's behalf via a stored DNS-provider credential
	// (v1.5+). Surfaced to the dashboard so a "we set this up for you"
	// chip can render next to the row.
	AutoConfigured bool `json:"autoConfigured"`
	// DNSCredentialID points at the dns_credentials row that minted the
	// A record. Nil for manually-configured domains.
	DNSCredentialID *string   `json:"dnsCredentialId,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// DNSCredential is a stored API credential for a DNS provider
// (Cloudflare today; Route53/Google planned). The plaintext token is
// never returned over the API — only the metadata fields below.
//
// Zones is cached at save time so the dashboard can show "this token
// covers: [...]" without re-calling the provider on every page load.
// LastUsedAt + LastError are populated by the auto-configure flow and
// surface as "credential health" indicators in the panel.
type DNSCredential struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
	Label    string `json:"label"`
	// ProjectID is non-nil when the credential is scoped to a single
	// project (v1.6.4+). Nil = instance-wide (managed under /v1/admin/
	// dns_credentials). The lookup hierarchy is project-scoped first,
	// then instance-wide as fallback, matched by zone coverage.
	ProjectID  *string    `json:"projectId,omitempty"`
	Zones      []ZoneInfo `json:"zones"`
	CreatedBy  *string    `json:"createdBy,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	LastError  string     `json:"lastError,omitempty"`
}

// ZoneInfo mirrors the shape persisted in dns_credentials.zones jsonb.
// Kept in models/ so both api/ and dns/ can reference the same type
// without an import cycle (api/ already imports models/; dns/ has no
// reason to).
type ZoneInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"` // zone apex, no trailing dot, e.g. "fechasul.com.br"
}

const (
	DomainRoleAPI       = "api"
	DomainRoleDashboard = "dashboard"
	// DomainRoleSite routes a custom domain at the deployment's SITE
	// proxy (Convex backend port 3211) where HTTP actions live at their
	// natural paths — distinct from 'api' (port 3210). See
	// docs/CONVEX_SITE_ORIGIN.md.
	DomainRoleSite = "site"

	DomainStatusPending = "pending"
	DomainStatusActive  = "active"
	DomainStatusFailed  = "failed"
)

const (
	TokenScopeUser       = "user"
	TokenScopeTeam       = "team"
	TokenScopeProject    = "project"
	TokenScopeDeployment = "deployment"
	// TokenScopeApp mirrors Convex Cloud's app_access_tokens family — a
	// short-lived per-project key targeted at CI/CD preview deploys. From
	// Synapse's authorization standpoint it behaves like a project-scoped
	// token; the distinct label exists so the dashboard can categorise it
	// separately ("app tokens" vs "project tokens"). v1.0+ migration 000007.
	TokenScopeApp = "app"
)

type AccessToken struct {
	ID         string     `json:"id"`
	UserID     string     `json:"userId"`
	Name       string     `json:"name"`
	Scope      string     `json:"scope"`
	ScopeID    string     `json:"scopeId,omitempty"`
	CreatedAt  time.Time  `json:"createTime"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
}

// ============================================================
// Cell Control Plane (feat/cell-control-plane)
// ============================================================
//
// New domain layer that turns Synapse from a per-deployment control plane
// into a "Cell" control plane. These types are Synapse-original (no Convex
// Cloud / OpenAPI counterpart), so their JSON tags use camelCase
// createdAt/updatedAt to match the most recent additions (DeploymentDomain,
// DNSCredential) rather than the older createTime/updateTime parity fields.
//
// Conceptual model:
//   Host   = a machine (VPS) the control plane can place resources on.
//   Cell   = an operational unit of a Project (core / runtime / …).
//   Deployment (existing) = a resource that lives inside a Cell.
//   DeploymentPlacement = where a deployment physically runs (host + state).
// See docs/CELLS.md (added in a later block) for the full vocabulary.

const (
	HostStatusOnline   = "online"
	HostStatusOffline  = "offline"
	HostStatusDraining = "draining"
	HostStatusUnknown  = "unknown"
	// HostStatusStale is a COMPUTED effectiveStatus value only — never stored
	// in hosts.status (whose CHECK constraint doesn't allow it). It means
	// "last heartbeat is older than the stale threshold but not yet offline".
	HostStatusStale = "stale"
)

// Host is a physical/virtual machine the control plane knows about. Today
// there's one (the VPS Synapse runs on, marked IsSynapseHost); agent-adopted
// VPSs arrive in a later block. Secrets never live here.
type Host struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Provider        string            `json:"provider"`
	Region          string            `json:"region"`
	PublicIP        string            `json:"publicIp,omitempty"`
	PrivateIP       string            `json:"privateIp,omitempty"`
	Labels          map[string]string `json:"labels"`
	Status          string            `json:"status"`
	AgentVersion    string            `json:"agentVersion,omitempty"`
	DockerVersion   string            `json:"dockerVersion,omitempty"`
	CPUCores        *int              `json:"cpuCores,omitempty"`
	MemoryMB        *int64            `json:"memoryMb,omitempty"`
	DiskGB          *int64            `json:"diskGb,omitempty"`
	IsSynapseHost   bool              `json:"isSynapseHost"`
	LastHeartbeatAt *time.Time        `json:"lastHeartbeatAt,omitempty"`
	CreatedAt       time.Time         `json:"createdAt"`
	UpdatedAt       time.Time         `json:"updatedAt"`
	// EffectiveStatus (Bloco 6.5) is computed at read time from
	// LastHeartbeatAt + the stale/offline thresholds — NOT stored. The API
	// always sets it; `Status` remains the last-known stored signal. Clients
	// should display EffectiveStatus. See api.effectiveHostStatus.
	EffectiveStatus string `json:"effectiveStatus,omitempty"`
}

const (
	HostAgentStatusPending = "pending"
	HostAgentStatusOnline  = "online"
	HostAgentStatusOffline = "offline"
	HostAgentStatusRevoked = "revoked"
)

// HostAgent is the agent process running on a Host. The agent binary itself
// (Go, synapse/cmd/synapse-agent) lands in a later block; this type + the
// adoption-token flow are modelled now so the DB/API are agent-ready.
// TokenHash + heartbeat payload never leave the server.
type HostAgent struct {
	ID             string     `json:"id"`
	HostID         string     `json:"hostId"`
	Name           string     `json:"name"`
	Status         string     `json:"status"`
	ConnectionMode string     `json:"connectionMode"`
	LastSeenAt     *time.Time `json:"lastSeenAt,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	UpdatedAt      time.Time  `json:"updatedAt"`
}

// HostAdoptionToken is a short-lived credential an operator mints to connect
// a VPS ("synapse-agent join --token <token>"). Stored as a hash; the
// plaintext Token is populated ONLY on the create response, shown once.
type HostAdoptionToken struct {
	ID        string     `json:"id"`
	HostID    *string    `json:"hostId,omitempty"`
	Name      string     `json:"name"`
	Token     string     `json:"token,omitempty"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	UsedAt    *time.Time `json:"usedAt,omitempty"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`
	CreatedBy *string    `json:"createdBy,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
}

const (
	CellKindCore          = "core"
	CellKindRuntime       = "runtime"
	CellKindIntegration   = "integration"
	CellKindPreview       = "preview"
	CellKindEnterpriseApp = "enterprise-app"

	CellEnvDev     = "dev"
	CellEnvStaging = "staging"
	CellEnvProd    = "prod"
	CellEnvPreview = "preview"

	CellTierShared    = "shared"
	CellTierPremium   = "premium"
	CellTierDedicated = "dedicated"
	CellTierInternal  = "internal"

	CellStatusActive      = "active"
	CellStatusInactive    = "inactive"
	CellStatusDraining    = "draining"
	CellStatusMigrating   = "migrating"
	CellStatusMaintenance = "maintenance"
)

// Cell is an operational unit of a Project. See migration 000018 for the
// kind/environment/isolation taxonomy and the "a Cell is not a customer and
// not a deployment" framing.
type Cell struct {
	ID                  string    `json:"id"`
	TeamID              string    `json:"teamId"`
	ProjectID           string    `json:"projectId"`
	Name                string    `json:"name"`
	Slug                string    `json:"slug"`
	Kind                string    `json:"kind"`
	Environment         string    `json:"environment"`
	Region              string    `json:"region"`
	IsolationTier       string    `json:"isolationTier"`
	Status              string    `json:"status"`
	PrimaryDeploymentID *string   `json:"primaryDeploymentId,omitempty"`
	PrimaryHostID       *string   `json:"primaryHostId,omitempty"`
	Description         string    `json:"description,omitempty"`
	CreatedAt           time.Time `json:"createdAt"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

const (
	CellResourceConvexDeployment = "convex_deployment"
	CellResourceAppRoute         = "app_route"
	CellResourceStorageScope     = "storage_scope"
	CellResourceSecretsScope     = "secrets_scope"
	CellResourceWorkerPool       = "worker_pool"
	CellResourceCustom           = "custom"

	CellResourceRolePrimary   = "primary"
	CellResourceRoleSecondary = "secondary"
	CellResourceRoleBackup    = "backup"
	CellResourceRoleInternal  = "internal"
)

// CellResource ties a resource (a Convex deployment, today) to a Cell. The
// partial unique index on (resource_id) WHERE resource_type='convex_deployment'
// enforces that a deployment belongs to at most one Cell.
type CellResource struct {
	ID           string            `json:"id"`
	CellID       string            `json:"cellId"`
	ResourceType string            `json:"resourceType"`
	ResourceID   string            `json:"resourceId"`
	Role         string            `json:"role"`
	Metadata     map[string]string `json:"metadata,omitempty"`
	CreatedAt    time.Time         `json:"createdAt"`
	UpdatedAt    time.Time         `json:"updatedAt"`
}

const (
	PlacementDesiredRunning = "running"
	PlacementDesiredStopped = "stopped"
	PlacementDesiredAbsent  = "absent"

	PlacementObservedRunning = "running"
	PlacementObservedStopped = "stopped"
	PlacementObservedFailed  = "failed"
	PlacementObservedUnknown = "unknown"
)

const (
	CellLinkProtocolHTTP         = "http"
	CellLinkProtocolConvexAction = "convex_action"
	CellLinkProtocolOutbox       = "outbox"
	CellLinkProtocolWebhook      = "webhook"
	CellLinkProtocolPolling      = "polling"

	CellLinkAuthServiceToken = "service_token"
	CellLinkAuthMTLS         = "mtls"
	CellLinkAuthNone         = "none"

	CellLinkStatusActive   = "active"
	CellLinkStatusDisabled = "disabled"
)

// CellLink is a service-to-service CONTRACT between two Cells in the same
// project (feat/cell-control-plane, Bloco 7). It records who may talk, the
// protocol, and the allowed command/event vocabulary — Synapse registers and
// protects the channel but never transports the payload itself.
type CellLink struct {
	ID              string   `json:"id"`
	TeamID          string   `json:"teamId"`
	ProjectID       string   `json:"projectId"`
	SourceCellID    string   `json:"sourceCellId"`
	TargetCellID    string   `json:"targetCellId"`
	Protocol        string   `json:"protocol"`
	AuthMode        string   `json:"authMode"`
	AllowedCommands []string `json:"allowedCommands"`
	AllowedEvents   []string `json:"allowedEvents"`
	Status          string   `json:"status"`
	// ServiceTokenCount is a computed convenience (active tokens for this
	// link) for the dashboard table — not a stored column.
	ServiceTokenCount int `json:"serviceTokenCount"`
	// Endpoint / EndpointSource (Bloco 7.5) are computed at read time — the
	// best-effort reachable URL of the target cell, resolved from the existing
	// Route layer (active custom domain) or the deployment URL. Omitted when
	// nothing safe is known. Same resolution the discovery endpoint uses.
	Endpoint       *string   `json:"endpoint,omitempty"`
	EndpointSource string    `json:"endpointSource,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

const (
	ServiceTokenStatusActive  = "active"
	ServiceTokenStatusRevoked = "revoked"
	ServiceTokenStatusExpired = "expired"

	// ServiceScopeDiscoveryRead is required to call the discovery endpoint and
	// is the default scope minted when none is supplied (Bloco 7.5).
	ServiceScopeDiscoveryRead = "discovery:read"
	// ServiceScopeCommandsSend is RESERVED for a future command-transport
	// block. Synapse does not transport commands today; the scope name is
	// fixed now so tokens minted today stay forward-compatible.
	ServiceScopeCommandsSend = "commands:send"
)

// ServiceToken is a credential for one CellLink. Stored as a sha256 hash; the
// plaintext (Token, syn_svc_…) is populated ONLY on the create response.
type ServiceToken struct {
	ID           string   `json:"id"`
	CellLinkID   string   `json:"cellLinkId"`
	SourceCellID string   `json:"sourceCellId"`
	TargetCellID string   `json:"targetCellId"`
	Name         string   `json:"name"`
	Token        string   `json:"token,omitempty"`
	Scopes       []string `json:"scopes"`
	Status       string   `json:"status"`
	// EffectiveStatus (Bloco 7.5) is computed at read time: a token past its
	// expiresAt reads "expired" even though the stored status is still
	// "active" (there's no reaper). Clients should display EffectiveStatus.
	EffectiveStatus string     `json:"effectiveStatus,omitempty"`
	ExpiresAt       *time.Time `json:"expiresAt,omitempty"`
	LastUsedAt      *time.Time `json:"lastUsedAt,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

// DeploymentPlacement is the physical placement of a deployment: the Cell it
// belongs to, the Host it runs on, and desired-vs-observed runtime state. It
// sits ON TOP of the deployments table — deployments.container_id/host_port
// stay authoritative for the existing provisioner + health worker.
type DeploymentPlacement struct {
	ID                string     `json:"id"`
	DeploymentID      string     `json:"deploymentId"`
	CellID            string     `json:"cellId"`
	HostID            *string    `json:"hostId,omitempty"`
	DesiredStatus     string     `json:"desiredStatus"`
	ObservedStatus    string     `json:"observedStatus"`
	DockerContainerID string     `json:"dockerContainerId,omitempty"`
	InternalPort      *int       `json:"internalPort,omitempty"`
	PublicURL         string     `json:"publicUrl,omitempty"`
	RouteID           *string    `json:"routeId,omitempty"`
	VolumeRef         string     `json:"volumeRef,omitempty"`
	LastAppliedAt     *time.Time `json:"lastAppliedAt,omitempty"`
	LastObservedAt    *time.Time `json:"lastObservedAt,omitempty"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

// ============================================================
// Desired / Observed / Operation state (Bloco 9)
// ============================================================
//
// The intention/observation/operation layer. Synapse MODELS, OBSERVES,
// COMPARES, PLANS — never APPLIES (Bloco 9). No secrets in DesiredJSON /
// ObservedJSON.

const (
	DesiredStateStatusActive     = "active"
	DesiredStateStatusSuperseded = "superseded"
	DesiredStateStatusDisabled   = "disabled"

	DesiredSourcePlacement = "placement"
	DesiredSourceRoute     = "route"
	DesiredSourceManual    = "manual"
	DesiredSourceSystem    = "system"
	DesiredSourceImported  = "imported"

	ResourceTypeConvexDeployment = "convex_deployment"
	ResourceTypeHostFacts        = "host_facts"
	ResourceTypeDockerContainer  = "docker_container"
	ResourceTypeRoute            = "route"
)

// DesiredState is what Synapse wants to exist on a host. DesiredJSON carries
// no secrets — just placement intent + synapse.* labels.
type DesiredState struct {
	ID           string         `json:"id"`
	TeamID       *string        `json:"teamId,omitempty"`
	ProjectID    *string        `json:"projectId,omitempty"`
	CellID       *string        `json:"cellId,omitempty"`
	HostID       string         `json:"hostId"`
	ResourceType string         `json:"resourceType"`
	ResourceID   *string        `json:"resourceId,omitempty"`
	ResourceKey  string         `json:"resourceKey"`
	DesiredJSON  map[string]any `json:"desired"`
	DesiredHash  string         `json:"desiredHash"`
	Version      int            `json:"version"`
	Status       string         `json:"status"`
	Source       string         `json:"source"`
	CreatedBy    *string        `json:"createdBy,omitempty"`
	CreatedAt    time.Time      `json:"createdAt"`
	UpdatedAt    time.Time      `json:"updatedAt"`
}

const (
	ObservedSourceAgent  = "agent"
	ObservedSourceServer = "server"
	ObservedSourceImport = "import"
)

// ObservedState is what an agent reported exists on a host. ObservedJSON
// carries only safe metadata (never env vars, commands-with-secrets, tokens).
type ObservedState struct {
	ID           string         `json:"id"`
	HostID       string         `json:"hostId"`
	AgentID      *string        `json:"agentId,omitempty"`
	ResourceType string         `json:"resourceType"`
	ResourceID   *string        `json:"resourceId,omitempty"`
	ResourceKey  string         `json:"resourceKey"`
	ObservedJSON map[string]any `json:"observed"`
	ObservedHash string         `json:"observedHash"`
	ObservedAt   time.Time      `json:"observedAt"`
	Source       string         `json:"source"`
	CreatedAt    time.Time      `json:"createdAt"`
	UpdatedAt    time.Time      `json:"updatedAt"`
}

const (
	OperationStatusQueued    = "queued"
	OperationStatusRunning   = "running"
	OperationStatusSucceeded = "succeeded"
	OperationStatusFailed    = "failed"
	OperationStatusCancelled = "cancelled"

	OperationTypeSyncDesiredFromPlacements = "sync_desired_from_placements"
	OperationTypeRecordObservedState       = "record_observed_state"
	OperationTypeComputeDrift              = "compute_drift"
	OperationTypeReconcileDryRun           = "reconcile_dry_run"
	OperationTypeCreateDesiredState        = "create_desired_state"
	OperationTypeDisableDesiredState       = "disable_desired_state"
)

// OperationRun tracks a Synapse operation (sync / drift / dry-run). PlanJSON
// holds a dry-run plan; ResultJSON the outcome summary. Never executes an
// apply in Bloco 9.
type OperationRun struct {
	ID           string         `json:"id"`
	Type         string         `json:"type"`
	TeamID       *string        `json:"teamId,omitempty"`
	ProjectID    *string        `json:"projectId,omitempty"`
	CellID       *string        `json:"cellId,omitempty"`
	HostID       *string        `json:"hostId,omitempty"`
	DeploymentID *string        `json:"deploymentId,omitempty"`
	Status       string         `json:"status"`
	InputJSON    map[string]any `json:"input,omitempty"`
	PlanJSON     map[string]any `json:"plan,omitempty"`
	ResultJSON   map[string]any `json:"result,omitempty"`
	Error        string         `json:"error,omitempty"`
	CreatedBy    *string        `json:"createdBy,omitempty"`
	StartedAt    *time.Time     `json:"startedAt,omitempty"`
	FinishedAt   *time.Time     `json:"finishedAt,omitempty"`
	CreatedAt    time.Time      `json:"createdAt"`
	UpdatedAt    time.Time      `json:"updatedAt"`
}

// Drift vocabulary (Bloco 9b). The Drift Engine COMPARES DesiredState against
// ObservedState and CLASSIFIES the divergence; the dry-run planner turns each
// classification into a *planned* operation step. Nothing here applies.
const (
	// DriftStatus* — how a desired/observed pair relates. Mirrors the
	// drift_items.drift_status CHECK in migration 000021.
	DriftStatusInSync          = "in_sync"          // desired + compatible observed both exist
	DriftStatusMissing         = "missing"          // desired exists, no observed (host trusted)
	DriftStatusDrifted         = "drifted"          // both exist but diverge (state / labels)
	DriftStatusUnmanaged       = "unmanaged"        // observed synapse-managed, no active desired
	DriftStatusOrphaned        = "orphaned"         // control-plane row points at a gone resource
	DriftStatusHostUnreachable = "host_unreachable" // observation can't be trusted (stale/offline/no agent)
	DriftStatusIgnored         = "ignored"          // observed resource that shouldn't be considered

	// Severity* — drift_items.severity CHECK.
	SeverityInfo     = "info"
	SeverityWarning  = "warning"
	SeverityCritical = "critical"

	// RecommendedAction* — drift_items.recommended_action CHECK. A
	// RECOMMENDATION only; the dry-run planner never executes it.
	RecommendedActionNone        = "none"
	RecommendedActionCreate      = "create"
	RecommendedActionUpdate      = "update"
	RecommendedActionRestart     = "restart"
	RecommendedActionStop        = "stop"
	RecommendedActionRemove      = "remove"
	RecommendedActionInvestigate = "investigate"

	// DriftReportStatus* — drift_reports.status CHECK (the rolled-up verdict).
	DriftReportStatusClean   = "clean"
	DriftReportStatusDrifted = "drifted"
	DriftReportStatusWarning = "warning"
	DriftReportStatusFailed  = "failed"

	// OperationStepStatus* — operation_steps.status CHECK. In Bloco 9 only
	// planned / skipped / no_op are ever written (nothing is executed).
	OperationStepStatusPlanned   = "planned"
	OperationStepStatusSkipped   = "skipped"
	OperationStepStatusNoOp      = "no_op"
	OperationStepStatusSucceeded = "succeeded"
	OperationStepStatusFailed    = "failed"

	// StepActionNoOp is the only step action that isn't a RecommendedAction*
	// value (create/restart/stop/remove/investigate are reused verbatim).
	StepActionNoOp = "no_op"
)

// DriftReport is one desired-vs-observed comparison run, scoped to a host,
// cell, or project. Summary holds the per-status / per-severity counts.
type DriftReport struct {
	ID             string         `json:"id"`
	HostID         *string        `json:"hostId,omitempty"`
	ProjectID      *string        `json:"projectId,omitempty"`
	CellID         *string        `json:"cellId,omitempty"`
	OperationRunID *string        `json:"operationRunId,omitempty"`
	Status         string         `json:"status"`
	Summary        map[string]any `json:"summary,omitempty"`
	CreatedAt      time.Time      `json:"createdAt"`
}

// DriftItem is one classified divergence inside a DriftReport. Diff carries
// only safe, redacted metadata (never env / secrets / tokens / private IPs).
type DriftItem struct {
	ID                string         `json:"id"`
	DriftReportID     string         `json:"driftReportId,omitempty"`
	HostID            *string        `json:"hostId,omitempty"`
	CellID            *string        `json:"cellId,omitempty"`
	ResourceType      string         `json:"resourceType"`
	ResourceKey       string         `json:"resourceKey"`
	DesiredStateID    *string        `json:"desiredStateId,omitempty"`
	ObservedStateID   *string        `json:"observedStateId,omitempty"`
	DriftStatus       string         `json:"driftStatus"`
	Severity          string         `json:"severity"`
	Diff              map[string]any `json:"diff,omitempty"`
	RecommendedAction string         `json:"recommendedAction"`
	CreatedAt         time.Time      `json:"createdAt"`
}
