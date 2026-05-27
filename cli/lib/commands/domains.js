// Custom domains per deployment (v1.0+). Mirror the dashboard's
// CustomDomainsPanel surface: list, add, verify, delete, auto-configure.
// All five wrap deployment-scoped endpoints under
// /v1/deployments/{name}/domains[/{id}[/{verify|auto_configure}]].
//
// Two-word dispatcher convention (`synapse domains <sub>`); each command
// supports --json and `extractFlags` for `--name=value` / `--name value`.

const colors = require("../colors");
const { extractFlags } = require("./_resource");

const ROLES = ["api", "site", "dashboard"];
const ROLE_SET = new Set(ROLES);

function requireDeployment(rest) {
  const name = rest[0];
  if (!name) {
    throw new Error(
      "Missing <deployment>. Usage: synapse domains <list|add|verify|delete|auto-configure> <deployment> [...]",
    );
  }
  if (rest.length > 1) {
    throw new Error(`Unexpected argument: ${rest[1]}`);
  }
  return name;
}

function requireFlag(flags, name, exampleVal) {
  const v = flags[name];
  if (typeof v !== "string" || v === "") {
    throw new Error(`Missing --${name}=<${exampleVal}>.`);
  }
  return v;
}

function statusColor(status) {
  if (status === "active") return colors.green;
  if (status === "failed") return colors.red;
  // pending / anything else
  return colors.yellow;
}

const domainsList = {
  name: "domains list",
  summary: "List custom domains attached to a deployment.",
  usage: "synapse domains list <deployment> [--json]",
  async run(args, ctx) {
    const { rest } = extractFlags(args, { boolean: [] });
    const name = requireDeployment(rest);
    const domains = await ctx.api.deploymentDomainsList(name);
    ctx.out.result(
      { kind: "domains", deployment: name, count: domains.length, domains },
      () => {
        ctx.out.table(
          domains.map((d) => ({
            domain: d.domain,
            role: d.role,
            status: d.status,
            id: d.id,
          })),
          [
            { key: "domain", header: "DOMAIN" },
            { key: "role", header: "ROLE" },
            { key: "status", header: "STATUS" },
            { key: "id", header: "ID" },
          ],
        );
      },
    );
  },
};

const domainsAdd = {
  name: "domains add",
  summary: "Attach a custom domain to a deployment.",
  usage:
    "synapse domains add <deployment> --domain=<host> --role=<api|site|dashboard> [--json]",
  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: ["domain", "role"],
    });
    const name = requireDeployment(rest);
    const domain = requireFlag(flags, "domain", "host");
    const role = requireFlag(flags, "role", ROLES.join("|"));
    if (!ROLE_SET.has(role)) {
      throw new Error(
        `Invalid --role: ${role}. One of: ${ROLES.join(", ")}.`,
      );
    }
    const created = await ctx.api.deploymentDomainCreate(name, { domain, role });
    ctx.out.result(created, () => {
      const w = ctx.out.stdout;
      const c = statusColor(created.status);
      w.write(
        `${colors.green("Added domain")} ${colors.bold(created.domain || domain)} ${colors.dim(`(${created.role || role}, ${created.id})`)}\n`,
      );
      w.write(colors.dim(`  status: `) + c(created.status || "pending") + "\n");
      if (created.lastDnsError) {
        w.write(colors.dim(`  last DNS error: ${created.lastDnsError}\n`));
      }
      if (created.status !== "active") {
        w.write(
          colors.dim(
            `  Run \`synapse domains verify ${name} --domain-id=${created.id}\` once your A record propagates.\n`,
          ),
        );
      }
    });
  },
};

const domainsVerify = {
  name: "domains verify",
  summary: "Re-run the DNS verification probe for a domain.",
  usage: "synapse domains verify <deployment> --domain-id=<id> [--json]",
  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, { string: ["domain-id"] });
    const name = requireDeployment(rest);
    const domainId = requireFlag(flags, "domain-id", "id");
    const res = await ctx.api.deploymentDomainVerify(name, domainId);
    ctx.out.result(res, () => {
      const w = ctx.out.stdout;
      const c = statusColor(res.status);
      w.write(
        `${colors.bold(res.domain || domainId)} ${colors.dim("→")} ` +
          c(res.status || "pending") +
          "\n",
      );
      if (res.lastDnsError) {
        w.write(colors.dim(`  last DNS error: ${res.lastDnsError}\n`));
      }
      if (res.deploymentRestartTriggered) {
        w.write(
          colors.yellow(
            "  Deployment container is restarting to refresh CORS_ALLOWED_ORIGINS (~15s).\n",
          ),
        );
      }
    });
  },
};

const domainsDelete = {
  name: "domains delete",
  summary: "Remove a custom domain from a deployment.",
  usage: "synapse domains delete <deployment> --domain-id=<id> [--json]",
  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, { string: ["domain-id"] });
    const name = requireDeployment(rest);
    const domainId = requireFlag(flags, "domain-id", "id");
    const res = await ctx.api.deploymentDomainDelete(name, domainId);
    ctx.out.result(res || { deleted: true, deployment: name, domainId }, () => {
      ctx.out.stdout.write(
        `${colors.red("Deleted")} domain ${colors.bold(domainId)} ${colors.dim(`(deployment ${name})`)}\n`,
      );
    });
  },
};

const domainsAutoConfigure = {
  name: "domains auto-configure",
  summary:
    "Have Synapse mint the A record on the operator's Cloudflare account.",
  usage:
    "synapse domains auto-configure <deployment> --domain-id=<id> [--json]",
  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, { string: ["domain-id"] });
    const name = requireDeployment(rest);
    const domainId = requireFlag(flags, "domain-id", "id");
    const res = await ctx.api.deploymentDomainAutoConfigure(name, domainId);
    ctx.out.result(res, () => {
      const w = ctx.out.stdout;
      if (res && res.success === false) {
        w.write(
          `${colors.red("Auto-configure failed")} ${colors.dim(`(${res.reason || "unknown reason"})`)}\n`,
        );
        return;
      }
      w.write(
        `${colors.green("Auto-configured")} domain ${colors.bold(res && res.domain ? res.domain : domainId)}\n`,
      );
      if (res && res.zone) {
        w.write(colors.dim(`  zone: ${res.zone}\n`));
      }
    });
  },
};

module.exports = [
  domainsList,
  domainsAdd,
  domainsVerify,
  domainsDelete,
  domainsAutoConfigure,
];
