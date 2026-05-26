// Cell Control Plane — CellLinks + ServiceTokens (Bloco 5). Project-RBAC.
// Registers service-to-service CONTRACTS + link-scoped credentials. The CLI
// never transports payloads; tokens are shown ONCE on create.

const colors = require("../colors");
const { extractFlags, resolveProject } = require("./_resource");
const { collectValueFlag } = require("./_cellplane");

const PROTOCOLS = new Set(["outbox", "http", "webhook", "polling", "convex_action"]);

const cellLinksList = {
  name: "cell-links list",
  summary: "List the cell links in a project.",
  usage: "synapse cell-links list --project <id> [--json]",
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const links = await ctx.api.cellLinksList(projectId);
    ctx.out.result({ projectId, count: links.length, cellLinks: links }, () => {
      ctx.out.table(
        links.map((l) => ({
          id: l.id,
          from: String(l.sourceCellId).slice(0, 8),
          to: String(l.targetCellId).slice(0, 8),
          protocol: l.protocol,
          auth: l.authMode,
          status: l.status,
          tokens: l.serviceTokenCount,
        })),
        [
          { key: "id", header: "ID" },
          { key: "from", header: "FROM" },
          { key: "to", header: "TO" },
          { key: "protocol", header: "PROTOCOL" },
          { key: "auth", header: "AUTH" },
          { key: "status", header: "STATUS" },
          { key: "tokens", header: "TOKENS", align: "right" },
        ],
      );
    });
  },
};

const cellLinksCreate = {
  name: "cell-links create",
  summary: "Create a service-to-service contract between two cells.",
  usage:
    "synapse cell-links create --project <id> --from <source-cell-id> --to <target-cell-id> [--protocol outbox|http|webhook|polling|convex_action] [--auth service_token] [--allow-command <cmd>]... [--allow-event <evt>]... [--json]",
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    const cmds = collectValueFlag(rest, "allow-command");
    const evts = collectValueFlag(cmds.rest, "allow-event");
    const { flags, rest: leftover } = extractFlags(evts.rest, {
      string: ["from", "to", "protocol", "auth"],
    });
    if (leftover.length > 0) throw new Error(`Unexpected argument: ${leftover[0]}`);
    if (!flags.from || !flags.to) {
      throw new Error("Usage: synapse cell-links create --project <id> --from <cell> --to <cell> [...]");
    }
    if (flags.protocol && !PROTOCOLS.has(flags.protocol)) {
      throw new Error(`Invalid --protocol: ${flags.protocol}. One of: ${[...PROTOCOLS].join(", ")}.`);
    }
    const body = { sourceCellId: flags.from, targetCellId: flags.to };
    if (flags.protocol) body.protocol = flags.protocol;
    if (flags.auth) body.authMode = flags.auth;
    if (cmds.values.length > 0) body.allowedCommands = cmds.values;
    if (evts.values.length > 0) body.allowedEvents = evts.values;

    const link = await ctx.api.cellLinkCreate(projectId, body);
    ctx.out.result({ cellLink: link }, () => {
      ctx.out.stdout.write(
        `${colors.green("Created link")} ${colors.dim(link.id)}  ${link.protocol}/${link.authMode}\n`,
      );
      if (link.authMode === "service_token") {
        ctx.out.stdout.write(
          colors.dim(`Next: \`synapse service-tokens create ${link.id} --scope discovery:read\`.\n`),
        );
      }
    });
  },
};

const cellLinksDisable = {
  name: "cell-links disable",
  summary: "Disable a cell link.",
  usage: "synapse cell-links disable <link-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse cell-links disable <link-id>");
    const link = await ctx.api.cellLinkDisable(id);
    ctx.out.result({ cellLink: link }, () => {
      ctx.out.stdout.write(`${colors.yellow("Disabled")} link ${colors.bold(id)}\n`);
    });
  },
};

const serviceTokensList = {
  name: "service-tokens list",
  summary: "List a cell link's service tokens (metadata only — never the secret).",
  usage: "synapse service-tokens list <cell-link-id> [--json]",
  async run(args, ctx) {
    const linkId = args[0];
    if (!linkId) throw new Error("Usage: synapse service-tokens list <cell-link-id>");
    const tokens = await ctx.api.serviceTokensList(linkId);
    ctx.out.result({ cellLinkId: linkId, count: tokens.length, serviceTokens: tokens }, () => {
      ctx.out.table(
        tokens.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.effectiveStatus || t.status,
          scopes: (t.scopes || []).join(","),
          expires: t.expiresAt || "",
        })),
        [
          { key: "id", header: "ID" },
          { key: "name", header: "NAME" },
          { key: "status", header: "STATUS" },
          { key: "scopes", header: "SCOPES" },
          { key: "expires", header: "EXPIRES" },
        ],
      );
    });
  },
};

const serviceTokensCreate = {
  name: "service-tokens create",
  summary: "Mint a link-scoped service token (plaintext shown once).",
  usage: "synapse service-tokens create <cell-link-id> [--name <name>] [--scope <scope>]... [--json]",
  description: `Mints a link-scoped service token (syn_svc_…). The plaintext is shown ONCE here and never again — only its hash is stored. Default scope is discovery:read.

Only links with auth mode service_token can mint tokens; the backend refuses others.`,
  async run(args, ctx) {
    const scopes = collectValueFlag(args, "scope");
    const { flags, rest } = extractFlags(scopes.rest, { string: ["name"] });
    const linkId = rest[0];
    if (!linkId) throw new Error("Usage: synapse service-tokens create <cell-link-id> [--name <n>] [--scope <s>]");
    const body = {};
    if (flags.name) body.name = flags.name;
    if (scopes.values.length > 0) body.scopes = scopes.values;
    const token = await ctx.api.serviceTokenCreate(linkId, body);
    // Creation response — the plaintext token is meant to be shown once.
    ctx.out.result({ serviceToken: token }, () => {
      const w = ctx.out.stdout;
      w.write(colors.yellow("Service token (shown once — copy it now):\n"));
      w.write("  " + colors.bold(token.token) + "\n");
      w.write(colors.dim(`\n  scopes: ${(token.scopes || []).join(", ")}\n`));
      if (token.expiresAt) w.write(colors.dim(`  expires: ${token.expiresAt}\n`));
    });
  },
};

const serviceTokensRevoke = {
  name: "service-tokens revoke",
  summary: "Revoke a service token.",
  usage: "synapse service-tokens revoke <token-id> [--json]",
  async run(args, ctx) {
    const id = args[0];
    if (!id) throw new Error("Usage: synapse service-tokens revoke <token-id>");
    const res = await ctx.api.serviceTokenRevoke(id);
    ctx.out.result(res, () => {
      ctx.out.stdout.write(`${colors.yellow("Revoked")} service token ${colors.bold(id)}\n`);
    });
  },
};

module.exports = [
  cellLinksList,
  cellLinksCreate,
  cellLinksDisable,
  serviceTokensList,
  serviceTokensCreate,
  serviceTokensRevoke,
];
