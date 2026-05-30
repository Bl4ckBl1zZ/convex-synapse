// Cell Control Plane — Hosts + Agent lifecycle (Bloco 5).
//
// All instance-admin server-side. Observe + manage metadata only: no Docker,
// no SSH, no host mutation. Adoption / rotated tokens are shown ONCE.

const colors = require("../colors");
const { extractFlags } = require("./_resource");
const { collectValueFlag } = require("./_cellplane");

function parseLabels(pairs) {
  const labels = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid --label: ${pair}. Use --label key=value.`);
    }
    labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

const hostsList = {
  name: "hosts list",
  summary: "List hosts (VPSs) known to the control plane.",
  usage: "synapse hosts list [--json]",
  async run(args, ctx) {
    if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
    const hosts = await ctx.api.hostsList();
    ctx.out.result({ kind: "hosts", count: hosts.length, hosts }, () => {
      ctx.out.table(
        hosts.map((h) => ({
          name: h.name,
          status: h.effectiveStatus || h.status,
          region: h.region || "",
          provider: h.provider || "",
          id: h.id,
        })),
        [
          { key: "name", header: "NAME" },
          { key: "status", header: "STATUS" },
          { key: "region", header: "REGION" },
          { key: "provider", header: "PROVIDER" },
          { key: "id", header: "ID" },
        ],
      );
    });
  },
};

const hostsShow = {
  name: "hosts show",
  summary: "Show a single host.",
  usage: "synapse hosts show <host-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse hosts show <host-id>");
    const host = await ctx.api.hostGet(id);
    ctx.out.result({ host }, () => {
      const w = ctx.out.stdout;
      w.write(`${colors.bold(host.name)} ${colors.dim("(" + host.id + ")")}\n`);
      w.write(colors.dim(`  status: ${host.effectiveStatus || host.status}\n`));
      if (host.region) w.write(colors.dim(`  region: ${host.region}\n`));
      if (host.provider) w.write(colors.dim(`  provider: ${host.provider}\n`));
      if (host.agentVersion) w.write(colors.dim(`  agent: ${host.agentVersion}\n`));
      if (host.dockerVersion) w.write(colors.dim(`  docker: ${host.dockerVersion}\n`));
      if (host.lastHeartbeatAt) w.write(colors.dim(`  last heartbeat: ${host.lastHeartbeatAt}\n`));
    });
  },
};

const hostsCreate = {
  name: "hosts create",
  summary: "Register a new host (metadata only — does not touch any machine).",
  usage:
    "synapse hosts create --name <name> [--provider <p>] [--region <r>] [--public-ip <ip>] [--private-ip <ip>] [--label k=v]... [--json]",
  async run(args, ctx) {
    const { values: labelPairs, rest: afterLabels } = collectValueFlag(args, "label");
    const { flags, rest } = extractFlags(afterLabels, {
      string: ["name", "provider", "region", "public-ip", "private-ip"],
    });
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    if (!flags.name) throw new Error("Usage: synapse hosts create --name <name> [...]");
    const body = { name: flags.name };
    if (flags.provider) body.provider = flags.provider;
    if (flags.region) body.region = flags.region;
    if (flags["public-ip"]) body.publicIp = flags["public-ip"];
    if (flags["private-ip"]) body.privateIp = flags["private-ip"];
    const labels = parseLabels(labelPairs);
    if (Object.keys(labels).length > 0) body.labels = labels;

    const host = await ctx.api.hostCreate(body);
    ctx.out.result({ host }, () => {
      ctx.out.stdout.write(
        `${colors.green("Created host")} ${colors.bold(host.name)} ${colors.dim("(" + host.id + ")")}\n`,
      );
      ctx.out.stdout.write(
        colors.dim(`Next: \`synapse hosts adoption-token ${host.id}\` to connect an agent.\n`),
      );
    });
  },
};

const hostsAdoptionToken = {
  name: "hosts adoption-token",
  summary: "Mint a single-use adoption token + join command for a host.",
  usage: "synapse hosts adoption-token <host-id> [--json]",
  description: `Mints a one-time adoption token the synapse-agent exchanges for a long-lived agent token. The plaintext token + ready-to-paste join command are shown ONCE here and never again.`,
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse hosts adoption-token <host-id>");
    const res = await ctx.api.hostAdoptionToken(id);
    // This is a creation response — the token is meant to be shown once.
    ctx.out.result(res, () => {
      const w = ctx.out.stdout;
      w.write(colors.yellow("Adoption token (shown once — copy it now):\n"));
      w.write("  " + colors.bold(res.token) + "\n\n");
      if (res.joinCommand) {
        w.write(colors.dim("Run this on the host:\n"));
        w.write("  " + res.joinCommand + "\n");
      }
      if (res.expiresAt) w.write(colors.dim(`\nExpires: ${res.expiresAt}\n`));
    });
  },
};

const hostsDrain = {
  name: "hosts drain",
  summary: "Mark a host as draining (operator intent; observe-only).",
  usage: "synapse hosts drain <host-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse hosts drain <host-id>");
    const host = await ctx.api.hostDrain(id);
    ctx.out.result({ host }, () => {
      ctx.out.stdout.write(
        `${colors.yellow("Draining")} ${colors.bold(host.name || id)} ${colors.dim("(no workload is moved — this only records intent)")}\n`,
      );
    });
  },
};

const hostsDelete = {
  name: "hosts delete",
  summary: "Remove a host from the control plane (registry-only).",
  usage: "synapse hosts delete <host-id> [--yes] [--json]",
  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, { boolean: ["yes"] });
    const id = rest[0];
    if (!id) throw new Error("Usage: synapse hosts delete <host-id> --yes");
    if (!flags.yes) {
      throw new Error(
        "Refusing to delete a host without --yes. Re-run with --yes to confirm. (Registry only — a remote host's tailnet node and on-box agent are not touched.)",
      );
    }
    const res = await ctx.api.hostDelete(id);
    ctx.out.result(res, () => {
      ctx.out.stdout.write(`${colors.red("Deleted")} host ${colors.bold(id)}\n`);
      // Honest scope: removal only clears the Synapse registry row. A remote
      // VPS keeps its Headscale tailnet node + the agent/systemd unit/users/
      // SSH keys until you clean them manually. See docs/REMOTE_HOSTS.md.
      ctx.out.stdout.write(
        colors.dim(
          "  (registry only — a remote host's tailnet node and on-box agent are not removed)\n",
        ),
      );
    });
  },
};

const hostsAgents = {
  name: "hosts agents",
  summary: "List the agents registered on a host.",
  usage: "synapse hosts agents <host-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse hosts agents <host-id>");
    const res = await ctx.api.hostAgents(id);
    const agents = res.items || [];
    ctx.out.result({ hostId: id, agentVersion: res.agentVersion, agents }, () => {
      ctx.out.table(
        agents.map((a) => ({
          id: a.id,
          status: a.status,
          mode: a.connectionMode || "",
          lastSeen: a.lastSeenAt || "",
        })),
        [
          { key: "id", header: "AGENT ID" },
          { key: "status", header: "STATUS" },
          { key: "mode", header: "MODE" },
          { key: "lastSeen", header: "LAST SEEN" },
        ],
      );
    });
  },
};

const agentsRevoke = {
  name: "agents revoke",
  summary: "Revoke an agent's token (it stops authenticating immediately).",
  usage: "synapse agents revoke <agent-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse agents revoke <agent-id>");
    const res = await ctx.api.agentRevoke(id);
    ctx.out.result(res, () => {
      ctx.out.stdout.write(`${colors.yellow("Revoked")} agent ${colors.bold(id)}\n`);
    });
  },
};

const agentsRotateToken = {
  name: "agents rotate-token",
  summary: "Rotate an agent's token (new token shown once; old one invalidated).",
  usage: "synapse agents rotate-token <agent-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse agents rotate-token <agent-id>");
    const res = await ctx.api.agentRotateToken(id);
    ctx.out.result(res, () => {
      const w = ctx.out.stdout;
      w.write(colors.yellow("New agent token (shown once — update the agent config):\n"));
      w.write("  " + colors.bold(res.agentToken) + "\n");
      w.write(
        colors.dim(`\nRe-run \`synapse-agent join\` on the host, or update its config.json.\n`),
      );
    });
  },
};

module.exports = [
  hostsList,
  hostsShow,
  hostsCreate,
  hostsAdoptionToken,
  hostsDrain,
  hostsDelete,
  hostsAgents,
  agentsRevoke,
  agentsRotateToken,
];
