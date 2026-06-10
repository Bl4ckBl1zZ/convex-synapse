// `synapse https setup <domain>` — the wizard.
//
// Flow (all idempotent — re-running is a no-op on a healthy machine):
//   1. SCAN     — read 16 detection vars (read-only, ~50ms)
//   2. PLAN     — turn detections into a list of steps
//   3. PREVIEW  — print the plan; ask "ok?" unless --yes
//   4. EXECUTE  — run each step; stop on failure (steps converge on
//                  re-run because each is independently idempotent)
//   5. VERIFY   — re-scan + print summary
//
// Flags:
//   --force         regenerate the cert even if present
//   --yes           skip the preview confirm prompt
//   --dry-run       SCAN + PLAN + PREVIEW; never execute
//   --skip-hosts    skip the hosts file step
//   --skip-script   skip the package.json mutation
//   --json          machine-readable output
//   --verbose       print per-step duration + outcome details

const colors = require("../colors");
const { extractFlags } = require("./_resource");
const { confirm } = require("../prompts");
const detectMod = require("../https/detect");
const plannerMod = require("../https/planner");
const executorMod = require("../https/executor");

function renderPlan(steps, { stdout }) {
  for (const step of steps) {
    const symbol = symbolFor(step.kind);
    stdout.write(`  ${symbol} ${step.title}\n`);
    if (step.kind === "blocker") {
      stdout.write(colors.red(`     blocker: ${step.blocker || step.reason}\n`));
      continue;
    }
    if (step.reason) {
      stdout.write(colors.dim(`     ${step.reason}\n`));
    }
    if (step.skipReason && step.kind !== "exec") {
      stdout.write(colors.dim(`     ${step.skipReason}\n`));
    }
  }
}

function symbolFor(kind) {
  switch (kind) {
    case "exec":
      return colors.cyan("●");
    case "skip":
      return colors.dim("○");
    case "warn":
      return colors.yellow("!");
    case "blocker":
      return colors.red("✗");
    default:
      return " ";
  }
}

function renderResults(results, { stdout }) {
  for (const r of results) {
    const sym =
      r.kind === "ok"
        ? colors.green("✓")
        : r.kind === "failed"
          ? colors.red("✗")
          : r.kind === "blocker"
            ? colors.red("✗")
            : r.kind === "warn"
              ? colors.yellow("!")
              : colors.dim("○");
    const tail =
      r.kind === "ok"
        ? colors.dim(`  ${r.durationMs}ms`)
        : r.kind === "failed"
          ? colors.red(`  ${r.outcome.error || "failed"}`)
          : "";
    stdout.write(`  ${sym} ${r.title}${tail}\n`);
  }
}

module.exports = {
  name: "https setup",
  summary: "Configure local HTTPS for a Next.js dev domain (mkcert + hosts + package.json).",
  usage:
    "synapse https setup <domain> [--force] [--yes] [--dry-run] [--skip-hosts] [--skip-script] [--verbose] [--json]",
  description: `Sets up self-signed HTTPS for a custom dev domain (e.g. dev.myproject.com) so \`next dev --experimental-https\` works without browser warnings.

Does six things in one pass:
  1. Detects mkcert + your OS + DNS state + cwd's package.json
  2. Ensures the local CA is trusted (mkcert -install, idempotent)
  3. Generates a cert pair at ~/.config/dev-certs/<domain>/
  4. Adds a 127.0.0.1 entry to your hosts file (sudo/UAC prompt if needed)
     — skipped automatically if your public DNS already resolves to loopback
  5. Adds/updates the dev:https script in package.json
  6. Verifies + prints "now run \`npm run dev:https\`"

Re-running is safe (every step is idempotent). The whole thing works
identically on Linux, macOS, Windows, and WSL.

Flags:
  --force         regenerate the cert even if one exists
  --yes           skip the preview confirmation prompt
  --dry-run       show the plan, don't execute (useful for partners
                  on Windows who want to see what will happen first)
  --skip-hosts    don't touch the hosts file
  --skip-script   don't touch package.json
  --verbose       per-step duration + outcome details
  --json          machine-readable output for CI

Examples:
  synapse https setup dev.myproject.com
  synapse https setup dev.myproject.com --dry-run --verbose
  synapse https setup dev.myproject.com --force --yes`,

  // Exports for tests
  renderPlan,
  renderResults,
  symbolFor,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: [],
      boolean: ["force", "yes", "dry-run", "skip-hosts", "skip-script", "verbose", "json"],
    });
    const domain = rest[0];
    if (!domain) {
      throw new Error(
        "Usage: synapse https setup <domain>\n\nExample: synapse https setup dev.myproject.com",
      );
    }
    if (rest.length > 1) {
      throw new Error(`Unexpected positional: ${rest[1]}.`);
    }

    const force = flags.force === true;
    const yes = flags.yes === true;
    const dryRun = flags["dry-run"] === true;
    const skipHosts = flags["skip-hosts"] === true;
    const skipScript = flags["skip-script"] === true;
    const verbose = flags.verbose === true;

    // ---- Phase 1: SCAN ------------------------------------------------
    if (!ctx.out.json) ctx.out.info("Scanning environment…");
    const detection = await detectMod.scan({ domain, cwd: ctx.cwd });

    // ---- Phase 2: PLAN ------------------------------------------------
    const steps = plannerMod.plan(detection, { force, skipHosts, skipScript });
    const executable = plannerMod.planIsExecutable(steps);

    // ---- Phase 3: PREVIEW --------------------------------------------
    if (!ctx.out.json) {
      ctx.out.stdout.write(
        `\n${colors.bold("Plan")} ${colors.dim(`for ${domain} on ${detection.platform.id}`)}\n`,
      );
      renderPlan(steps, { stdout: ctx.out.stdout });
      ctx.out.stdout.write("\n");
    }

    if (!executable) {
      const blocker = steps.find((s) => s.kind === "blocker");
      if (ctx.out.json) {
        ctx.out.result(
          { domain, blocked: true, steps, blocker: blocker?.blocker || blocker?.reason },
          () => {},
        );
        process.exitCode = 1;
        return;
      }
      ctx.out.error(blocker?.blocker || "Plan is blocked.");
      process.exitCode = 1;
      return;
    }

    if (dryRun) {
      if (ctx.out.json) {
        ctx.out.result({ domain, dryRun: true, steps }, () => {});
        return;
      }
      ctx.out.info("(dry-run — not executing)");
      return;
    }

    const willChange = steps.some((s) => s.kind === "exec");
    if (!willChange) {
      if (ctx.out.json) {
        ctx.out.result({ domain, executedAny: false, steps }, () => {});
        return;
      }
      ctx.out.stdout.write(
        colors.green("Nothing to do — everything already in the desired state.\n"),
      );
      return;
    }

    if (!yes && !ctx.out.json) {
      const ok = await confirm(`Apply this plan? [Y/n] `, { defaultAnswer: true });
      if (!ok) {
        ctx.out.info("Aborted.");
        process.exitCode = 1;
        return;
      }
    }
    if (!yes && ctx.out.json) {
      throw new Error("Refusing to execute in --json mode without --yes.");
    }

    // ---- Phase 4: EXECUTE --------------------------------------------
    const { results, failedAny } = await executorMod.execute(steps, {
      out: ctx.out,
      verbose,
    });

    // ---- Phase 5: VERIFY ---------------------------------------------
    const after = await detectMod.scan({ domain, cwd: ctx.cwd });

    // v1.8.10 added post-execute verification; v1.13.0 makes it honest
    // AND diagnostic. The repair step's own control probe is the
    // freshest signal (it resolved both names INSIDE the same elevated
    // session that wrote the file); the re-scan covers the plain
    // add-entry path. If the domain doesn't resolve, this command must
    // NOT print "HTTPS ready" — `npm run dev:https` is guaranteed to
    // fail with ENOTFOUND, and pretending otherwise is how operators
    // end up running flushdns in circles.
    const hostsResult = results.find((r) => r.id === "hosts" && r.kind === "ok");
    const repair = (hostsResult && hostsResult.outcome) || {};
    const wroteHosts = !!hostsResult;
    const verifyOk =
      repair.domainResolved === true || after.resolution.resolvesToLoopback;
    const verifyFailed = wroteHosts && !verifyOk && !skipHosts;

    const summary = {
      domain,
      platform: detection.platform.id,
      certPath: after.existingCerts?.certPath ?? null,
      keyPath: after.existingCerts?.keyPath ?? null,
      hostsEntry: after.hosts.matches.length > 0,
      devHttpsScript: after.pkg.existingDevHttps,
      results,
      failedAny,
    };
    if (wroteHosts) summary.verifyResolution = !verifyFailed;

    if (verifyFailed) {
      const lines = [];
      if (repair.controlResolved === true) {
        lines.push(
          `The hosts file itself WORKS — a throwaway control entry resolved fine — but ${domain} is still answered by something else before the Windows resolver. Typical culprits: VPN split-DNS, an NRPT policy rule, or antivirus web-protection.`,
        );
        if (repair.diagnosis && repair.diagnosis.advice) lines.push(repair.diagnosis.advice);
      } else if (repair.controlResolved === false) {
        lines.push(
          `Windows ignored even a freshly written control entry — the hosts file is being bypassed entirely (DNS interceptor, redirected DataBasePath, or policy), so no amount of rewriting/flushing will help.`,
        );
        if (repair.diagnosis && repair.diagnosis.summary) {
          lines.push(`Deep probes point at: ${repair.diagnosis.summary}.`);
        }
      } else if (detection.platform.id === "windows") {
        lines.push(
          "Windows DNS Client is still not serving the entry. Run `synapse https doctor " +
            domain +
            "` for the deep diagnosis, or restart the machine.",
        );
      } else {
        lines.push(
          "Hosts file was written but the OS resolver still doesn't return 127.0.0.1. Try restarting nscd / systemd-resolved if you use one, or open a new shell.",
        );
      }
      const aRecord =
        plannerMod.publicARecordAdvice(after) || plannerMod.publicARecordAdvice(detection);
      if (aRecord) lines.push(aRecord);
      summary.verifyHint = lines.join("\n");
    }

    if (ctx.out.json) {
      ctx.out.result(summary, () => {});
      if (failedAny || verifyFailed) process.exitCode = 1;
      return;
    }

    ctx.out.stdout.write("\n");
    renderResults(results, { stdout: ctx.out.stdout });
    ctx.out.stdout.write("\n");
    if (failedAny) {
      ctx.out.error(
        "One or more steps failed. Fix the cause and re-run — every step is idempotent so safe steps won't re-do.",
      );
      process.exitCode = 1;
      return;
    }

    if (verifyFailed) {
      ctx.out.error(`${domain} still doesn't resolve to 127.0.0.1.`);
      ctx.out.stdout.write(`\n${summary.verifyHint}\n\n`);
      ctx.out.stdout.write(
        `${colors.red("✗")} ${colors.bold(`HTTPS NOT ready for ${domain}`)} ${colors.dim("— fix the resolution issue above, then re-run `synapse https setup`.")}\n`,
      );
      process.exitCode = 1;
      return;
    }

    ctx.out.stdout.write(
      `${colors.green("✓")} ${colors.bold(`HTTPS ready for ${domain}`)}\n`,
    );
    if (wroteHosts && repair.domainResolved === true) {
      ctx.out.stdout.write(
        colors.dim(`(verified: ${domain} resolves to 127.0.0.1)\n`),
      );
    }
    if (after.pkg.hasNext) {
      ctx.out.stdout.write(colors.dim(`Next: run \`npm run dev:https\` in ${ctx.cwd}\n`));
    } else {
      ctx.out.stdout.write(
        colors.dim(
          `Cert lives at: ${after.existingCerts?.certPath}\nPair it with:\n  next dev --experimental-https --experimental-https-cert <cert> --experimental-https-key <key> --hostname ${domain}\n`,
        ),
      );
    }
    if (after.resolution.source === "dns") {
      ctx.out.stdout.write(
        colors.dim(
          `(Public DNS A record points ${domain} → 127.0.0.1, so no /etc/hosts edit was needed. Partners on other machines also need no setup.)\n`,
        ),
      );
    }
  },
};
