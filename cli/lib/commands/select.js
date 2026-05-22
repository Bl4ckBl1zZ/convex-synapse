// `synapse select` — link the current directory to a Synapse project +
// pick a dev/prod deployment, then write the local artifacts
// (.synapse/project.json + .env.local).
//
// The picker walks team → project → dev → prod as a state machine so
// the operator can type `b` at any level to step back one. Auto-
// selects each level when only one option exists. DEBUG_SYNAPSE=1
// dumps the underlying lists at every step — useful when a real
// deployment is mysteriously missing from the menu.

const colors = require("../colors");
const { writeProjectEnv } = require("../env-file");
const {
  buildProjectConfig,
  writeProjectConfig,
} = require("../project");
const { BACK, choose } = require("../prompts");

function labelName(item) {
  const name = item.name || item.slug || item.id;
  const slug = item.slug && item.slug !== name ? ` (${item.slug})` : "";
  return `${name}${slug}`;
}

function teamRef(team) {
  return team.slug || team.id;
}

function deploymentType(deployment) {
  return deployment.deploymentType || deployment.type || "";
}

function deploymentLabel(deployment) {
  const bits = [colors.bold(deployment.name)];
  const type = deploymentType(deployment);
  if (type) bits.push(colors.dim(type));
  if (deployment.status) bits.push(colors.statusBadge(deployment.status));
  return bits.filter(Boolean).join(" - ");
}

function sortDeploymentsForChoice(deployments) {
  return [...deployments].sort((a, b) => {
    if (!!a.isDefault !== !!b.isDefault) {
      return a.isDefault ? -1 : 1;
    }
    return String(b.createTime || b.createdAt || "").localeCompare(
      String(a.createTime || a.createdAt || ""),
    );
  });
}

function debugLog(msg) {
  if (process.env.DEBUG_SYNAPSE) {
    process.stderr.write(`[DEBUG] ${msg}\n`);
  }
}

async function chooseDeploymentForType(type, deployments, chooseOpts = {}) {
  const matches = sortDeploymentsForChoice(
    deployments.filter(
      (d) => deploymentType(d) === type && d.status !== "deleted",
    ),
  );
  debugLog(
    `chooseDeploymentForType(${type}): matched ${matches.length} of ${deployments.length} ` +
      `(types: ${deployments.map((d) => deploymentType(d) || "?").join(",")})`,
  );
  if (matches.length === 0) return null;
  return await choose(
    `${type} deployments`,
    matches.map((d) => ({ label: deploymentLabel(d), value: d })),
    { singularLabel: `${type} deployment`, ...chooseOpts },
  );
}

module.exports = {
  name: "select",
  summary: "Link this directory to a Synapse project and pick its dev/prod deployments.",
  usage: "synapse select",
  description: `Walks an interactive picker (team → project → dev → prod) and writes:
  .synapse/project.json   refs only — no secrets, safe to commit
  .env.local              CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY

Auto-selects levels where only one option exists. Type 'b' at any
prompt to step back. Set DEBUG_SYNAPSE=1 to print the raw lists
returned at every step (useful when an expected deployment doesn't
show up in the menu).`,

  // Exported for legacy test imports.
  chooseDeploymentForType,
  deploymentLabel,
  deploymentType,
  labelName,
  sortDeploymentsForChoice,

  async run(_args, ctx) {
    const { api } = ctx;
    const cfg = ctx.cfg;

    const cache = {
      teamsList: null,
      projectsByTeamKey: new Map(),
      deploymentsByProjectId: new Map(),
    };
    async function fetchTeams() {
      if (!cache.teamsList) {
        cache.teamsList = await api.teams();
        debugLog(`teams loaded: ${cache.teamsList.length}`);
      }
      return cache.teamsList;
    }
    async function fetchProjects(team) {
      const key = team.id || team.slug || team.name;
      if (!cache.projectsByTeamKey.has(key)) {
        const projects = await api.projects(teamRef(team));
        cache.projectsByTeamKey.set(key, projects);
        debugLog(`projects for team ${key}: ${projects.length}`);
      }
      return cache.projectsByTeamKey.get(key);
    }
    async function fetchDeployments(project) {
      if (!cache.deploymentsByProjectId.has(project.id)) {
        const deployments = await api.deployments(project.id);
        cache.deploymentsByProjectId.set(project.id, deployments);
        debugLog(`deployments for project ${project.id}: ${deployments.length}`);
      }
      return cache.deploymentsByProjectId.get(project.id);
    }

    let team = null;
    let project = null;
    let dev = null;
    let prod = null;
    let step = "team";
    while (step !== "done") {
      if (step === "team") {
        const teams = await fetchTeams();
        const picked = await choose(
          "teams",
          teams.map((t) => ({ label: labelName(t), value: t })),
          { singularLabel: "team", allowBack: false },
        );
        team = picked;
        step = "project";
      } else if (step === "project") {
        const projects = await fetchProjects(team);
        const picked = await choose(
          "projects",
          projects.map((p) => ({ label: labelName(p), value: p })),
          { singularLabel: "project", allowBack: true },
        );
        if (picked === BACK) {
          step = "team";
          continue;
        }
        project = picked;
        step = "dev";
      } else if (step === "dev") {
        const deployments = await fetchDeployments(project);
        const picked = await chooseDeploymentForType("dev", deployments, {
          allowBack: true,
        });
        if (picked === BACK) {
          step = "project";
          continue;
        }
        if (picked === null) {
          throw new Error(
            "No dev deployments available in this project. Create one first in the dashboard.",
          );
        }
        dev = picked;
        step = "prod";
      } else if (step === "prod") {
        const deployments = await fetchDeployments(project);
        const picked = await chooseDeploymentForType("prod", deployments, {
          allowBack: true,
        });
        if (picked === BACK) {
          step = "dev";
          continue;
        }
        prod = picked; // null is valid (no prod yet)
        step = "done";
      }
    }

    const projectPath = writeProjectConfig(
      ctx.cwd,
      buildProjectConfig({
        synapseUrl: cfg.baseUrl,
        team,
        project,
        deployments: { dev, prod },
      }),
    );
    const creds = await api.cliCredentials(dev.name);
    const envPath = writeProjectEnv(ctx.cwd, creds, {
      team: { slug: team.slug, name: team.name },
      project: { slug: project.slug, name: project.name },
      target: "dev",
    });

    ctx.out.result(
      {
        synapseUrl: cfg.baseUrl,
        team: { id: team.id, slug: team.slug, name: team.name },
        project: { id: project.id, slug: project.slug, name: project.name },
        deployments: {
          dev: { name: dev.name, type: deploymentType(dev), status: dev.status },
          prod: prod
            ? { name: prod.name, type: deploymentType(prod), status: prod.status }
            : null,
        },
        files: { projectConfig: projectPath, envLocal: envPath },
      },
      () => {
        ctx.out.info(`\nLinked ${labelName(project)} to ${projectPath}.`);
        ctx.out.info(
          `Selected dev deployment ${colors.bold(dev.name)}. Updated ${envPath}.`,
        );
        if (prod) {
          ctx.out.info(`Selected prod deployment ${colors.bold(prod.name)}.`);
        } else {
          ctx.out.warn(
            "no prod deployment found. `synapse deploy` (and `synapse convex deploy`) will fail with a clear error until you create a prod deployment and run `synapse select` again.",
          );
        }
        if (process.env.CONVEX_DEPLOYMENT) {
          ctx.out.warn(
            "shell CONVEX_DEPLOYMENT is set. Use `synapse dev` / `synapse deploy` / `synapse convex ...` or unset CONVEX_DEPLOYMENT before running `npx convex` directly.",
          );
        }
        ctx.out.info(
          `\nNext step: run ${colors.bold("synapse dev")} (or ${colors.bold("npx convex dev")}) once in this directory to push your schema and watch for changes.`,
        );
      },
    );
    // Force ctx.projectConfig to re-read on next access (commands chained
    // after select within the same process should see the new file).
    ctx.refreshProjectConfig();
  },
};
