// Project members (project-level RBAC v1.0+). Composes with team
// membership: project_members override > team_members fallback. Adding
// a member requires the user to already be on the owning team — the
// backend rejects unknown user IDs with `not_team_member`.
//
// Two-word dispatcher convention (`synapse members <sub>`). All
// commands resolve the project via `resolveProject` so they honour
// either --project=<id> or the directory-linked project.

const colors = require("../colors");
const { extractFlags, resolveProject } = require("./_resource");

const ROLES = ["admin", "member", "viewer"];
const ROLE_SET = new Set(ROLES);

function requireFlag(flags, name, exampleVal) {
  const v = flags[name];
  if (typeof v !== "string" || v === "") {
    throw new Error(`Missing --${name}=<${exampleVal}>.`);
  }
  return v;
}

function requireRole(flags) {
  const role = requireFlag(flags, "role", ROLES.join("|"));
  if (!ROLE_SET.has(role)) {
    throw new Error(`Invalid --role: ${role}. One of: ${ROLES.join(", ")}.`);
  }
  return role;
}

const membersList = {
  name: "members list",
  summary: "List members of a project (with effective role + source).",
  usage: "synapse members list [--project=<id>] [--json]",
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const members = await ctx.api.projectMembersList(projectId);
    ctx.out.result(
      { kind: "members", projectId, count: members.length, members },
      () => {
        ctx.out.table(
          members.map((m) => ({
            user: m.name || m.id,
            email: m.email,
            role: m.role,
            source: m.source,
          })),
          [
            { key: "user", header: "USER" },
            { key: "email", header: "EMAIL" },
            { key: "role", header: "ROLE" },
            { key: "source", header: "SOURCE" },
          ],
        );
      },
    );
  },
};

const membersAdd = {
  name: "members add",
  summary: "Grant a team member a project-level role override.",
  usage:
    "synapse members add [--project=<id>] --user-id=<uuid> --role=<admin|member|viewer> [--json]",
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    const { flags, rest: leftover } = extractFlags(rest, {
      string: ["user-id", "role"],
    });
    if (leftover.length > 0) throw new Error(`Unexpected argument: ${leftover[0]}`);
    const userId = requireFlag(flags, "user-id", "uuid");
    const role = requireRole(flags);
    const res = await ctx.api.projectMemberAdd(projectId, userId, role);
    ctx.out.result(res, () => {
      ctx.out.stdout.write(
        `${colors.green("Added member")} ${colors.bold(userId)} ${colors.dim(`(role: ${res.role || role})`)}\n`,
      );
    });
  },
};

const membersUpdateRole = {
  name: "members update-role",
  summary: "Change an existing member's project-level role override.",
  usage:
    "synapse members update-role [--project=<id>] --member-id=<uuid> --role=<admin|member|viewer> [--json]",
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    const { flags, rest: leftover } = extractFlags(rest, {
      string: ["member-id", "role"],
    });
    if (leftover.length > 0) throw new Error(`Unexpected argument: ${leftover[0]}`);
    const memberId = requireFlag(flags, "member-id", "uuid");
    const role = requireRole(flags);
    const res = await ctx.api.projectMemberUpdateRole(projectId, memberId, role);
    ctx.out.result(res, () => {
      ctx.out.stdout.write(
        `${colors.green("Updated role")} for ${colors.bold(memberId)} ${colors.dim(`→ ${res.role || role}`)}\n`,
      );
    });
  },
};

const membersRemove = {
  name: "members remove",
  summary:
    "Drop a project-level role override (member falls back to their team role).",
  usage: "synapse members remove [--project=<id>] --member-id=<uuid> [--json]",
  async run(args, ctx) {
    const { projectId, rest } = resolveProject(ctx, args);
    const { flags, rest: leftover } = extractFlags(rest, {
      string: ["member-id"],
    });
    if (leftover.length > 0) throw new Error(`Unexpected argument: ${leftover[0]}`);
    const memberId = requireFlag(flags, "member-id", "uuid");
    const res = await ctx.api.projectMemberRemove(projectId, memberId);
    ctx.out.result(res, () => {
      ctx.out.stdout.write(
        `${colors.red("Removed override")} for ${colors.bold(memberId)} ${colors.dim("(team-level role still applies if any)")}\n`,
      );
    });
  },
};

module.exports = [membersList, membersAdd, membersUpdateRole, membersRemove];
