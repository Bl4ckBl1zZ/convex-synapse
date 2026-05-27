// Auto-update (instance-admin). `synapse upgrade check` polls the
// cached GitHub release info; `synapse upgrade run` dispatches
// setup.sh --upgrade through the host-side updater daemon and returns
// whatever the daemon's /upgrade response carries (commonly { started,
// ref } or { jobId, ... }); `synapse upgrade status` reads the daemon's
// /status proxy.
//
// 503 from the backend (code "updater_unreachable") means the operator
// skipped `setup.sh --install-updater`; we surface a one-line hint
// instead of leaking the proxy error verbatim.

const colors = require("../colors");
const { extractFlags } = require("./_resource");
const { SynapseAPIError } = require("../api");
const { confirm } = require("../prompts");

const UPDATER_NOT_INSTALLED_HINT =
  "Updater daemon not installed on this host. Run `setup.sh --install-updater` on the host first, " +
  "or use SSH and run `setup.sh --upgrade` directly.";

const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "rebooting",
  "completed",
  "errored",
]);

function statusOf(payload) {
  if (!payload || typeof payload !== "object") return "";
  return String(payload.status || payload.state || "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Map the backend's 503/updater_unreachable into a one-liner the
// operator can act on. Other errors propagate unchanged so the
// dispatcher's standard error path stays in control of formatting.
function rewrapUpdaterUnavailable(err) {
  if (
    err instanceof SynapseAPIError &&
    (err.status === 503 || err.code === "updater_unreachable")
  ) {
    const wrapped = new Error(UPDATER_NOT_INSTALLED_HINT);
    wrapped.code = "updater_not_installed";
    wrapped.cause = err;
    return wrapped;
  }
  return err;
}

const upgradeCheck = {
  name: "upgrade check",
  summary: "Check whether a newer Synapse release is available on GitHub.",
  usage: "synapse upgrade check [--refresh] [--json]",
  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, { boolean: ["refresh"] });
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const res = await ctx.api.adminVersionCheck({ refresh: Boolean(flags.refresh) });
    ctx.out.result(res, () => {
      const w = ctx.out.stdout;
      const current = res.current || "(unknown)";
      const latest = res.latest || "(unknown)";
      if (res.error) {
        w.write(
          `${colors.yellow("Could not check for updates")}: ${res.error}\n`,
        );
        w.write(colors.dim(`  current: ${current}\n`));
        return;
      }
      if (res.updateAvailable) {
        w.write(
          `${colors.green("Update available")}: ${colors.bold(latest)} ${colors.dim(`(you have ${current})`)}\n`,
        );
        if (res.releaseUrl) {
          w.write(colors.dim(`  release: ${res.releaseUrl}\n`));
        }
        w.write(
          colors.dim(
            "  Run `synapse upgrade run --yes` to dispatch the upgrade via the host updater.\n",
          ),
        );
      } else {
        w.write(
          `${colors.green("Up to date")}: ${colors.bold(current)} ${colors.dim(res.fromCache ? "(cached)" : "(live)")}\n`,
        );
      }
    });
  },
};

const upgradeRun = {
  name: "upgrade run",
  summary: "Dispatch setup.sh --upgrade via the host-side updater daemon.",
  usage: "synapse upgrade run [--ref=<git-ref>] [--yes] [--json]",
  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: ["ref"],
      boolean: ["yes"],
    });
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
    const ref = typeof flags.ref === "string" ? flags.ref : "";
    const yes = flags.yes === true || flags.yes === "true";

    // Confirmation gate. Mirrors `synapse deploy` semantics: --yes
    // skips, interactive TTY prompts y/N, non-TTY without --yes is a
    // hard refuse (and --json mode without --yes is too — same as the
    // env-push pattern).
    if (!yes) {
      if (ctx.out.json) {
        throw new Error(
          "Refusing to dispatch an upgrade in --json mode without --yes.",
        );
      }
      const stdin = (ctx.stdin) || process.stdin;
      if (!stdin.isTTY) {
        throw new Error(
          "synapse upgrade run needs confirmation. Pass --yes to skip in non-interactive contexts (CI, scripts).",
        );
      }
      const confirmed = await confirm(
        `Dispatch \`setup.sh --upgrade${ref ? ` (ref: ${ref})` : ""}\` on this host? [y/N] `,
        { defaultAnswer: false },
      );
      if (!confirmed) {
        ctx.out.info("Aborted.");
        process.exitCode = 1;
        return;
      }
    }

    let res;
    try {
      res = await ctx.api.adminUpgrade(ref ? { ref } : {});
    } catch (err) {
      throw rewrapUpdaterUnavailable(err);
    }

    ctx.out.result(res, () => {
      const w = ctx.out.stdout;
      w.write(`${colors.green("Upgrade dispatched")}.\n`);
      if (res && res.ref) w.write(colors.dim(`  ref: ${res.ref}\n`));
      const jobId = res && (res.jobId || res.id);
      if (jobId) {
        w.write(colors.dim(`  jobId: ${jobId}\n`));
        w.write(
          colors.dim(
            `  Poll progress with \`synapse upgrade status ${jobId} --follow\`.\n`,
          ),
        );
      } else {
        w.write(
          colors.dim(
            "  Poll progress with `synapse upgrade status --follow`.\n",
          ),
        );
      }
    });
  },
};

const upgradeStatus = {
  name: "upgrade status",
  summary: "Read the updater daemon's current job status.",
  usage: "synapse upgrade status [<jobId>] [--follow] [--json]",
  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, { boolean: ["follow"] });
    if (rest.length > 1) throw new Error(`Unexpected argument: ${rest[1]}`);
    const jobId = rest[0] || "";
    const follow = flags.follow === true || flags.follow === "true";

    async function fetchOnce() {
      try {
        return await ctx.api.adminUpgradeStatus(jobId);
      } catch (err) {
        throw rewrapUpdaterUnavailable(err);
      }
    }

    if (!follow) {
      const res = await fetchOnce();
      ctx.out.result(res, () => renderStatus(res, ctx));
      return;
    }

    // Poll loop. 2s cadence is gentle enough for a long-running
    // upgrade + reboot; the updater's /status is a cheap read-through.
    // We render incrementally in human mode and emit one final JSON
    // payload in --json mode so a piped consumer stays single-shot.
    let last = await fetchOnce();
    if (!ctx.out.json) renderStatus(last, ctx);
    while (!TERMINAL_STATES.has(statusOf(last))) {
      await sleep(2000);
      last = await fetchOnce();
      if (!ctx.out.json) renderStatus(last, ctx, { delta: true });
    }
    if (ctx.out.json) {
      ctx.out.result(last, () => {});
    }
  },
};

function renderStatus(res, ctx, { delta = false } = {}) {
  const w = ctx.out.stdout;
  const status = statusOf(res) || "(unknown)";
  if (delta) {
    w.write(colors.dim(`  status: ${status}\n`));
  } else {
    w.write(`Upgrade status: ${colors.bold(status)}\n`);
  }
  if (res && Array.isArray(res.logs) && res.logs.length > 0) {
    for (const line of res.logs) {
      w.write(colors.dim(`  ${line}\n`));
    }
  }
  if (res && res.error) {
    w.write(colors.red(`  error: ${res.error}\n`));
  }
}

module.exports = [upgradeCheck, upgradeRun, upgradeStatus];
