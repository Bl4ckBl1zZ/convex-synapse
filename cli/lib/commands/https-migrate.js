// `synapse https migrate [--cwd] [--all] [--yes] [--dry-run] [--json]`
//
// Migrates legacy cert layouts to the canonical ~/.config/dev-certs/
// store. Two modes:
//
//   1. cwd mode (default): scans the current directory for legacy
//      `dev.*.pem` + `-key.pem` pairs and migrates them.
//   2. --all: scans EVERY known project root (operator-supplied via
//      --root flag, default: ~/Documents and the cwd). This is more
//      ambitious and gated behind explicit opt-in.
//
// Migration per cert pair:
//   - Move the .pem files into ~/.config/dev-certs/<domain>/
//   - Set mode 0600 on the key
//   - Rewrite package.json dev:https to point at the new paths
//   - Leave the original files in place ONLY if --keep-old; default
//     is to delete them once they've been moved successfully.

const fs = require("node:fs");
const path = require("node:path");
const colors = require("../colors");
const { extractFlags } = require("./_resource");
const { confirm } = require("../prompts");
const detectMod = require("../https/detect");
const nextjsMod = require("../https/nextjs");

module.exports = {
  name: "https migrate",
  summary: "Move legacy cert pairs from project roots into ~/.config/dev-certs/.",
  usage: "synapse https migrate [--cwd | --root=<path>] [--keep-old] [--dry-run] [--yes] [--json]",
  description: `Some projects have their .pem files in the project root (left over from the manual setup era). This command moves them into the canonical ~/.config/dev-certs/<domain>/ store, then rewrites the project's package.json dev:https script to reference the new paths.

Flags:
  --cwd               only the current directory (default)
  --root=<path>       a specific directory to scan
  --keep-old          leave the original .pem files in place after moving
  --dry-run           show what would happen, don't change anything
  --yes               skip the per-pair confirmation
  --json              machine-readable output

The cwd is scanned non-recursively. Subdirectories are ignored —
if you want to migrate every project on disk, run this command in
each project root (or write a small loop).`,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: ["root"],
      boolean: ["cwd", "keep-old", "dry-run", "yes", "json"],
    });
    if (rest.length > 0) {
      throw new Error(`Unexpected positional: ${rest[0]}.`);
    }
    const root = typeof flags.root === "string" ? flags.root : ctx.cwd;
    const dryRun = flags["dry-run"] === true;
    const keepOld = flags["keep-old"] === true;
    const yes = flags.yes === true;
    const legacy = detectMod.detectLegacyCertsInCwd(root);

    if (legacy.length === 0) {
      ctx.out.result(
        { root, migrated: [], skipped: [], count: 0 },
        () =>
          ctx.out.stdout.write(
            colors.dim(`No legacy cert pairs found in ${root}.\n`),
          ),
      );
      return;
    }

    if (!ctx.out.json) {
      ctx.out.stdout.write(
        `${colors.bold(`Found ${legacy.length} legacy cert pair${legacy.length > 1 ? "s" : ""} in ${root}:`)}\n`,
      );
      for (const p of legacy) {
        ctx.out.stdout.write(`  · ${colors.bold(p.domain)}\n`);
        ctx.out.stdout.write(colors.dim(`      ${p.cert}\n`));
        ctx.out.stdout.write(colors.dim(`      ${p.key}\n`));
      }
      ctx.out.stdout.write("\n");
    }
    if (dryRun) {
      ctx.out.info("(dry-run — no changes applied)");
      ctx.out.result({ root, found: legacy, dryRun: true }, () => {});
      return;
    }
    if (!yes && !ctx.out.json) {
      const ok = await confirm(`Migrate ${legacy.length} pair(s)? [Y/n] `, { defaultAnswer: true });
      if (!ok) {
        ctx.out.info("Aborted.");
        process.exitCode = 1;
        return;
      }
    }
    if (!yes && ctx.out.json) {
      throw new Error("Refusing to migrate in --json mode without --yes.");
    }

    const migrated = [];
    const skipped = [];
    const failed = [];
    for (const p of legacy) {
      try {
        const target = detectMod.certFilesFor(p.domain);
        // Skip pairs whose canonical location is already populated
        // unless --force (which we don't expose here — re-running
        // setup --force is the right way to regenerate).
        if (fs.existsSync(target.cert) && fs.existsSync(target.key)) {
          skipped.push({ domain: p.domain, reason: "target already exists in cert store" });
          continue;
        }
        fs.mkdirSync(target.dir, { recursive: true, mode: 0o700 });
        fs.copyFileSync(p.cert, target.cert);
        fs.copyFileSync(p.key, target.key);
        try {
          fs.chmodSync(target.key, 0o600);
        } catch {
          // ignore
        }
        if (!keepOld) {
          fs.rmSync(p.cert, { force: true });
          fs.rmSync(p.key, { force: true });
        }
        // Rewrite package.json dev:https if present + still references
        // the project-root form.
        const pkgPath = path.join(root, "package.json");
        if (fs.existsSync(pkgPath)) {
          const info = nextjsMod.readPackageJson(pkgPath);
          if (info.parsed && info.parsed.scripts && info.parsed.scripts["dev:https"]) {
            const current = info.parsed.scripts["dev:https"];
            // Replace any reference to the project-root pem paths
            // with the canonical ones.
            const newCommand = current
              .replace(p.cert.replace(/\\/g, "/"), target.cert.replace(/\\/g, "/"))
              .replace(p.key.replace(/\\/g, "/"), target.key.replace(/\\/g, "/"))
              .replace(`./${path.basename(p.cert)}`, target.cert.replace(/\\/g, "/"))
              .replace(`./${path.basename(p.key)}`, target.key.replace(/\\/g, "/"));
            if (newCommand !== current) {
              nextjsMod.setDevHttpsScript(pkgPath, newCommand);
            }
          }
        }
        migrated.push({
          domain: p.domain,
          from: { cert: p.cert, key: p.key },
          to: { cert: target.cert, key: target.key },
        });
      } catch (err) {
        failed.push({ domain: p.domain, error: err.message });
      }
    }

    ctx.out.result(
      { root, migrated, skipped, failed, count: migrated.length },
      (_d, { stdout }) => {
        for (const m of migrated) {
          stdout.write(`${colors.green("✓")} ${colors.bold(m.domain)} → ${colors.dim(m.to.cert)}\n`);
        }
        for (const s of skipped) {
          stdout.write(`${colors.dim("○")} ${colors.bold(s.domain)} skipped: ${s.reason}\n`);
        }
        for (const f of failed) {
          stdout.write(`${colors.red("✗")} ${colors.bold(f.domain)}: ${f.error}\n`);
        }
      },
    );
    if (failed.length > 0) process.exitCode = 1;
  },
};
