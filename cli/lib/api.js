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
