// `synapse https status [domain]` — diagnose what's already
// configured. With a domain: deep dive on that one. Without: list
// every domain under ~/.config/dev-certs/.

const fs = require("node:fs");
const path = require("node:path");
const colors = require("../colors");
const { extractFlags } = require("./_resource");
const detectMod = require("../https/detect");

function renderDomainStatus(detection, { stdout }) {
  const sym = (b) => (b ? colors.green("✓") : colors.dim("·"));
  stdout.write(`${colors.bold(detection.domain)}\n`);
  stdout.write(
    `  ${sym(detection.mkcert.present)} mkcert ${
      detection.mkcert.present ? colors.dim(detection.mkcert.version) : colors.red("missing")
    }\n`,
  );
  stdout.write(
    `  ${sym(detection.caTrusted)} CA trusted${
      detection.caTrusted ? "" : colors.red(" (run `mkcert -install`)")
    }\n`,
  );
  const certPresent = detection.existingCerts && detection.existingCerts.present;
  stdout.write(
    `  ${sym(certPresent)} cert pair ${
      certPresent ? colors.dim(detection.existingCerts.certPath) : colors.dim("(not generated yet)")
    }\n`,
  );
  if (certPresent && detection.existingCerts.expiry) {
    stdout.write(colors.dim(`     expires ${detection.existingCerts.expiry}\n`));
  }
  const resolves = detection.resolution.resolvesToLoopback;
  const src = detection.resolution.source;
  stdout.write(
    `  ${sym(resolves)} resolves to 127.0.0.1 ${
      resolves ? colors.dim(`(via ${src})`) : colors.red("(no — add to hosts or DNS A record)")
    }\n`,
  );
  const scriptOk = !!detection.pkg.existingDevHttps;
  stdout.write(
    `  ${sym(scriptOk)} package.json dev:https ${
      scriptOk
        ? colors.dim("set")
        : detection.pkg.present
          ? colors.dim("(missing in cwd's package.json)")
          : colors.dim("(no package.json in cwd)")
    }\n`,
  );
}

module.exports = {
  name: "https status",
  summary: "Show local-HTTPS state for one domain or every configured domain.",
  usage: "synapse https status [domain] [--json]",
  description: `Without a domain: lists every cert directory in ~/.config/dev-certs/.
With a domain: prints a deep diagnostic (mkcert, CA trust, cert presence + expiry, DNS resolution, package.json script).`,

  async run(args, ctx) {
    const { flags, rest } = extractFlags(args, {
      string: [],
      boolean: ["json"],
    });
    const domain = rest[0];
    if (rest.length > 1) {
      throw new Error(`Unexpected positional: ${rest[1]}.`);
    }

    if (!domain) {
      // List mode. We accept TWO layouts in the cert store:
      //   1. Canonical (v1.8.8+): `<root>/<domain>/<domain>.pem` + `-key.pem`
      //   2. Flat (operator's pre-existing intermediate layout):
      //      `<root>/<domain>.pem` + `<domain>{-,.}key.pem`
      // Flat-format certs aren't moved automatically — they show up
      // here with a `flat: true` hint so `https migrate --root` can
      // reorganise them.
      const root = detectMod.certsRoot();
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        entries = [];
      }
      const domains = new Set();
      const flatDomains = new Set();
      // (1) Subdirectories (canonical).
      for (const e of entries) {
        if (e.isDirectory()) domains.add(e.name);
      }
      // (2) Flat pairs in the root.
      const flat = detectMod.detectFlatCertsInStore();
      for (const p of flat) {
        domains.add(p.domain);
        flatDomains.add(p.domain);
      }
      const rows = await Promise.all(
        [...domains].sort().map(async (d) => {
          const det = await detectMod.scan({ domain: d, cwd: ctx.cwd });
          return {
            domain: d,
            cert: det.existingCerts?.present ?? false,
            expiry: det.existingCerts?.expiry ?? null,
            resolves: det.resolution.resolvesToLoopback,
            resolutionSource: det.resolution.source,
            flat: flatDomains.has(d),
          };
        }),
      );
      ctx.out.result(
        { root, count: rows.length, domains: rows },
        (_d, { stdout }) => {
          stdout.write(colors.dim(`Cert store: ${root}\n`));
          if (rows.length === 0) {
            stdout.write(
              colors.dim("(no certs configured — run `synapse https setup <domain>`)\n"),
            );
            return;
          }
          ctx.out.table(
            rows.map((r) => ({
              domain: colors.bold(r.domain) + (r.flat ? colors.dim(" (flat)") : ""),
              cert: r.cert ? colors.green("yes") : colors.dim("no"),
              expiry: r.expiry ? colors.dim(r.expiry.slice(0, 10)) : colors.dim("?"),
              resolves: r.resolves
                ? colors.green(r.resolutionSource)
                : colors.red("no"),
            })),
            [
              { key: "domain", header: "DOMAIN" },
              { key: "cert", header: "CERT" },
              { key: "expiry", header: "EXPIRES" },
              { key: "resolves", header: "LOOPBACK" },
            ],
          );
          if (rows.some((r) => r.flat)) {
            stdout.write(
              colors.dim(
                "\n(flat) = cert lives directly in ~/.config/dev-certs/ instead of a subdirectory. Run `synapse https migrate --root=~/.config/dev-certs` to reorganise.\n",
              ),
            );
          }
        },
      );
      return;
    }

    // Single-domain detail mode.
    const det = await detectMod.scan({ domain, cwd: ctx.cwd });
    ctx.out.result(det, (d, { stdout }) => renderDomainStatus(d, { stdout }));
  },

  // Exports for tests.
  renderDomainStatus,
};
