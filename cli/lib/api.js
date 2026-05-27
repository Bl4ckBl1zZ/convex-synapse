class SynapseAPIError extends Error {
  constructor(status, code, message) {
    super(message || code || `Synapse API returned ${status}`);
    this.name = "SynapseAPIError";
    this.status = status;
    this.code = code || "request_failed";
  }
}

class SynapseAPI {
  constructor({ baseUrl, accessToken, fetchImpl = globalThis.fetch }) {
    if (!fetchImpl) {
      throw new Error("This Node version does not provide fetch()");
    }
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.accessToken = accessToken || "";
    this.fetch = fetchImpl;
  }

  async request(method, path, body, { auth = true, includeHeaders = false } = {}) {
    const url = new URL(path, `${this.baseUrl}/`);
    const headers = {
      "Accept": "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (auth && this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      throw new SynapseAPIError(0, "network_error", `Could not reach Synapse at ${this.baseUrl}: ${detail}`);
    }
    if (!res.ok) {
      let code = "request_failed";
      let message = `${method} ${url.pathname} failed with ${res.status}`;
      try {
        const data = await res.json();
        code = data.code || data.error || code;
        message = data.message || data.error || message;
      } catch {
        // Keep the generic message if the server didn't return JSON.
      }
      throw new SynapseAPIError(res.status, code, message);
    }
    let data = null;
    if (res.status !== 204) {
      try {
        data = await res.json();
      } catch {
        throw new SynapseAPIError(res.status, "bad_response", `${method} ${url.pathname} did not return JSON`);
      }
    }
    if (includeHeaders) {
      return { data, headers: res.headers };
    }
    return data;
  }

  async listAll(path) {
    const items = [];
    let cursor = "";
    do {
      const pageURL = new URL(path, "http://synapse.local");
      pageURL.searchParams.set("limit", "500");
      if (cursor) {
        pageURL.searchParams.set("cursor", cursor);
      }
      const page = await this.request("GET", `${pageURL.pathname}${pageURL.search}`, undefined, { includeHeaders: true });
      // Backend currently returns a bare JSON array for every paginated
      // endpoint, but the dashboard already tolerates both `[...]` and
      // `{ <noun>: [...] }` (see `collectPaginated` in dashboard/lib/api.ts).
      // Mirror that resilience here so a future server-side reshape doesn't
      // brick `synapse select` for every CLI user simultaneously.
      const arr = extractListPayload(page.data);
      if (arr === null) {
        const shape = page.data && typeof page.data === "object"
          ? `object with keys [${Object.keys(page.data).join(", ")}]`
          : typeof page.data;
        throw new SynapseAPIError(
          0,
          "bad_response",
          `Expected ${path} to return a JSON array (got ${shape})`,
        );
      }
      items.push(...arr);
      cursor = page.headers.get("x-next-cursor") || "";
    } while (cursor);
    return items;
  }

  login(email, password) {
    return this.request("POST", "/v1/auth/login", { email, password }, { auth: false });
  }

  refresh(refreshToken) {
    return this.request("POST", "/v1/auth/refresh", { refreshToken }, { auth: false });
  }

  me() {
    return this.request("GET", "/v1/me/");
  }

  teams() {
    return this.listAll("/v1/teams/");
  }

  projects(teamRef) {
    return this.listAll(`/v1/teams/${encodeURIComponent(teamRef)}/list_projects`);
  }

  // Single-project lookup by ID. Cheaper than listing a team's projects
  // (no pagination) and FK cascade team→projects means this also detects
  // a deleted team — backend returns 404 in both cases.
  getProject(projectId) {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/`);
  }

  deployments(projectId) {
    return this.listAll(`/v1/projects/${encodeURIComponent(projectId)}/list_deployments`);
  }

  cliCredentials(deploymentName) {
    return this.request("GET", `/v1/deployments/${encodeURIComponent(deploymentName)}/cli_credentials`);
  }

  // ---- v1.8.7 control-plane methods ------------------------------

  // GET /v1/deployments/{name}/ — single-deployment snapshot for the
  // status command (faster than filtering listDeployments client-side
  // when the operator already knows the name).
  getDeployment(name) {
    return this.request("GET", `/v1/deployments/${encodeURIComponent(name)}/`);
  }

  // GET /v1/deployments/{name}/backend_version — version of the running
  // Convex backend inside the container. Cheap and useful in `status`.
  // Falls back to {} if the deployment isn't ready (status: provisioning).
  getDeploymentBackendVersion(name) {
    return this.request("GET", `/v1/deployments/${encodeURIComponent(name)}/backend_version`);
  }

  // POST /v1/projects/{id}/create_deployment — body: { type, ha?, reference?, isDefault? }.
  // Backend generates the deployment name; we surface it in the response.
  createDeployment(projectId, body) {
    return this.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/create_deployment`, body);
  }

  // POST /v1/deployments/{name}/delete — irreversible; container + volume
  // gone. Returns 200 with no body on success. The caller is responsible
  // for typed-confirmation in the UI layer.
  deleteDeployment(name) {
    return this.request("POST", `/v1/deployments/${encodeURIComponent(name)}/delete`, {});
  }

  // POST /v1/deployments/{name}/reissue_admin_key — re-mints the admin
  // key from the current instance_secret WITHOUT touching the secret.
  // Use when stored credentials drift from the live container.
  // Response: { deploymentName, adminKey, prefix }.
  reissueAdminKey(name) {
    return this.request("POST", `/v1/deployments/${encodeURIComponent(name)}/reissue_admin_key`, {});
  }

  // GET /v1/projects/{id}/list_default_environment_variables — returns
  // { configs: [{ name, value, deploymentTypes[] }] }. We hand the raw
  // shape back; the command formats it.
  listProjectEnvVars(projectId) {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/list_default_environment_variables`);
  }

  // POST /v1/projects/{id}/update_default_environment_variables — body:
  // { changes: [{ op: "set"|"delete", name, value?, deploymentTypes? }] }.
  // Cloud-spec shape; the backend applies the batch in a transaction so
  // partial-failure is impossible.
  updateProjectEnvVars(projectId, changes) {
    return this.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/update_default_environment_variables`, {
      changes,
    });
  }

  // ---- Cell Control Plane (Bloco 5) ------------------------------
  // Thin wrappers over the existing endpoints (see
  // docs/API_CELL_CONTROL_PLANE.md). NONE of these apply changes to a host:
  // recompute/dry-run only diagnose + plan, and no method sends apply:true.

  // Hosts (instance-admin).
  hostsList() {
    return this.request("GET", "/v1/hosts").then(itemsOf);
  }
  hostGet(id) {
    return this.request("GET", `/v1/hosts/${encodeURIComponent(id)}`);
  }
  hostCreate(body) {
    return this.request("POST", "/v1/hosts", body);
  }
  // Mints a single-use adoption token; the plaintext + joinCommand come
  // back ONCE in this response (never returned again).
  hostAdoptionToken(id, body = {}) {
    return this.request("POST", `/v1/hosts/${encodeURIComponent(id)}/adoption_token`, body);
  }
  hostDrain(id) {
    return this.request("POST", `/v1/hosts/${encodeURIComponent(id)}/drain`, {});
  }
  // { agentVersion?, items: [...] } — no-secrets agent summaries.
  hostAgents(id) {
    return this.request("GET", `/v1/hosts/${encodeURIComponent(id)}/agents`);
  }
  hostDesiredState(id) {
    return this.request("GET", `/v1/hosts/${encodeURIComponent(id)}/desired_state`).then(itemsOf);
  }
  hostObservedState(id) {
    return this.request("GET", `/v1/hosts/${encodeURIComponent(id)}/observed_state`).then(itemsOf);
  }

  // Agent lifecycle (instance-admin).
  agentRevoke(agentId) {
    return this.request("POST", `/v1/host_agents/${encodeURIComponent(agentId)}/revoke`, {});
  }
  // New agent token returned ONCE.
  agentRotateToken(agentId) {
    return this.request("POST", `/v1/host_agents/${encodeURIComponent(agentId)}/rotate_token`, {});
  }

  // Cells (project-RBAC).
  cellsList(projectId) {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/cells`).then(itemsOf);
  }
  cellCreate(projectId, body) {
    return this.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/cells`, body);
  }
  cellGet(id) {
    return this.request("GET", `/v1/cells/${encodeURIComponent(id)}`);
  }
  cellAttachDeployment(id, deploymentName, role) {
    const body = role ? { deploymentName, role } : { deploymentName };
    return this.request("POST", `/v1/cells/${encodeURIComponent(id)}/attach_deployment`, body);
  }
  // hostId accepts a host UUID or name (the backend resolves either).
  cellAttachHost(id, hostId) {
    return this.request("POST", `/v1/cells/${encodeURIComponent(id)}/attach_host`, { hostId });
  }
  // { resources: [...], placements: [...] }
  cellResources(id) {
    return this.request("GET", `/v1/cells/${encodeURIComponent(id)}/resources`);
  }
  cellDrain(id) {
    return this.request("POST", `/v1/cells/${encodeURIComponent(id)}/drain`, {});
  }
  cellDelete(id) {
    return this.request("POST", `/v1/cells/${encodeURIComponent(id)}/delete`, {});
  }

  // Cell links + service tokens (project-RBAC).
  cellLinksList(projectId) {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/cell_links`).then(itemsOf);
  }
  cellLinkCreate(projectId, body) {
    return this.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/cell_links`, body);
  }
  cellLinkDisable(id) {
    return this.request("POST", `/v1/cell_links/${encodeURIComponent(id)}/disable`, {});
  }
  serviceTokensList(linkId) {
    return this.request("GET", `/v1/cell_links/${encodeURIComponent(linkId)}/service_tokens`).then(itemsOf);
  }
  // Plaintext token returned ONCE in this response.
  serviceTokenCreate(linkId, body) {
    return this.request("POST", `/v1/cell_links/${encodeURIComponent(linkId)}/service_tokens`, body);
  }
  serviceTokenRevoke(tokenId) {
    return this.request("POST", `/v1/service_tokens/${encodeURIComponent(tokenId)}/revoke`, {});
  }

  // Topology.
  cellTopology(projectId) {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/cell_topology`);
  }

  // Desired / Observed / Drift / Reconcile (dry-run) / Operations.
  // `scope` is the path segment: "hosts" | "cells" | "projects".
  desiredSync(projectId) {
    return this.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/desired_state/sync_from_placements`, {});
  }
  desiredListProject(projectId) {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/desired_state`).then(itemsOf);
  }
  driftRecompute(scope, id) {
    return this.request("POST", `/v1/${scope}/${encodeURIComponent(id)}/drift/recompute`, {});
  }
  driftLatest(scope, id) {
    return this.request("GET", `/v1/${scope}/${encodeURIComponent(id)}/drift/latest`);
  }
  // Dry-run only. The body is empty by contract — the CLI never sends
  // apply:true (the backend would 400 it anyway).
  reconcileDryRun(scope, id) {
    return this.request("POST", `/v1/${scope}/${encodeURIComponent(id)}/reconcile/dry_run`, {});
  }
  operationRunsList(projectId) {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/operation_runs`).then(itemsOf);
  }
  // { operationRun, steps }
  operationRunGet(id) {
    return this.request("GET", `/v1/operation_runs/${encodeURIComponent(id)}`);
  }

  // ---- Custom domains per deployment (v1.0+) ---------------------
  // Operator manages <domain> records on a specific deployment. Role
  // selects which Convex listener the proxy routes to:
  //   api       → port 3210 (cloud / queries / mutations)
  //   site      → port 3211 (HTTP actions; required for Better Auth)
  //   dashboard → the Convex Dashboard sidecar (port 6791)
  // status flips pending→active after the verify probe sees a matching
  // A record (SYNAPSE_PUBLIC_IP must be set server-side).

  deploymentDomainsList(name) {
    return this.request("GET", `/v1/deployments/${encodeURIComponent(name)}/domains`).then(itemsOf);
  }
  deploymentDomainCreate(name, body) {
    // body: { domain, role }
    return this.request("POST", `/v1/deployments/${encodeURIComponent(name)}/domains`, body);
  }
  deploymentDomainDelete(name, domainId) {
    return this.request(
      "DELETE",
      `/v1/deployments/${encodeURIComponent(name)}/domains/${encodeURIComponent(domainId)}`,
    );
  }
  deploymentDomainVerify(name, domainId) {
    return this.request(
      "POST",
      `/v1/deployments/${encodeURIComponent(name)}/domains/${encodeURIComponent(domainId)}/verify`,
      {},
    );
  }
  deploymentDomainAutoConfigure(name, domainId) {
    return this.request(
      "POST",
      `/v1/deployments/${encodeURIComponent(name)}/domains/${encodeURIComponent(domainId)}/auto_configure`,
      {},
    );
  }

  // ---- Project members (RBAC v1.0+) ------------------------------
  // Three roles at the project grain: admin > member > viewer.
  // Overrides win over team_members (see effectiveProjectRole in
  // synapse/internal/api/projects.go). Adding a member requires the
  // user already be on the owning team.

  projectMembersList(projectId) {
    return this.request("GET", `/v1/projects/${encodeURIComponent(projectId)}/list_members`).then(itemsOf);
  }
  projectMemberAdd(projectId, userId, role) {
    return this.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/add_member`, { userId, role });
  }
  projectMemberUpdateRole(projectId, memberId, role) {
    return this.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/update_member_role`, { memberId, role });
  }
  projectMemberRemove(projectId, memberId) {
    return this.request("POST", `/v1/projects/${encodeURIComponent(projectId)}/remove_member`, { memberId });
  }

  // ---- Auto-update (instance-admin only) -------------------------
  // Read /admin/version_check to see whether a newer Synapse release
  // exists on GitHub; POST /admin/upgrade to dispatch setup.sh --upgrade
  // through the host-side updater daemon. The backend 503s with code
  // "updater_unreachable" when the operator skipped the updater install
  // — upgrade.js catches that and prints a friendlier hint.

  adminVersionCheck({ refresh = false } = {}) {
    if (refresh) {
      return this.request("POST", "/v1/admin/version_check/refresh", {});
    }
    return this.request("GET", "/v1/admin/version_check");
  }
  adminUpgrade(body = {}) {
    // body: { ref?: string } — optional git ref/tag to upgrade to.
    return this.request("POST", "/v1/admin/upgrade", body);
  }
  adminUpgradeStatus(jobId) {
    const query = jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
    return this.request("GET", `/v1/admin/upgrade/status${query}`);
  }
}

// itemsOf unwraps a list endpoint's envelope to a bare array. Tolerates
// the canonical `{ items: [...] }`, the per-noun envelopes the v1.0
// handlers emit (`{ domains: [...] }`, `{ members: [...] }`), and a
// bare array. Used for non-cursor-paginated list endpoints.
function itemsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.domains)) return data.domains;
  if (data && Array.isArray(data.members)) return data.members;
  return [];
}

// Known envelope keys, in priority order. We try these explicitly before
// falling back to a generic "first array-valued property" lookup so a
// future endpoint that wraps results in `{ items: [...] }` (or similar)
// keeps working. The fallback handles the unlikely case of a renamed
// envelope without crashing the CLI.
const KNOWN_LIST_KEYS = [
  "teams",
  "projects",
  "deployments",
  "members",
  "items",
  "data",
  "results",
];

function extractListPayload(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of KNOWN_LIST_KEYS) {
      if (Array.isArray(data[key])) return data[key];
    }
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

module.exports = {
  SynapseAPI,
  SynapseAPIError,
  extractListPayload,
};
