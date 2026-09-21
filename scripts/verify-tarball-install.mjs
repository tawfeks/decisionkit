#!/usr/bin/env node
/**
 * M5 acceptance check — "fresh install from npm tarballs only, no file:
 * links to the workspace". Builds the packages, npm-packs them, then runs the
 * real `decisionkit init` (non-dev, --tarballs mode: same code path as a
 * registry install, but resolving deps from the tarballs) for pi, opencode,
 * claude, and codex inside throwaway temp repos, and asserts the installed
 * trees. Also enforces the public-repo hygiene rule: no `.local/` or plan
 * files may leak into any tarball.
 *
 * Usage: node scripts/verify-tarball-install.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKGS = ["decisionkit-core", "decisionkit-pi-ext", "decisionkit-opencode-plugin", "decisionkit-kilo-plugin", "decisionkit-cli"];
const PKG_VERSION = Object.fromEntries(
  PKGS.map((name) => {
    const dir = name === "decisionkit-core" ? "core" : name === "decisionkit-cli" ? "cli" : name.replace("decisionkit-", "");
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));
    return [name, pkg.version];
  }),
);

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: opts.capture ? "pipe" : "inherit", cwd: opts.cwd ?? ROOT, ...opts.env ? { env: opts.env } : {} });

const step = (msg) => console.log(`\n── ${msg}`);

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
  if (!ok) failures++;
};

step("build decisionkit-core (dist + packs)");
run("npm", ["run", "build", "-w", "decisionkit-core"]);

step("npm pack all packages");
const packDir = mkdtempSync(join(tmpdir(), "decisionkit-tarballs-"));
for (const name of PKGS) {
  run("npm", ["pack", "-w", name, "--pack-destination", packDir]);
}
for (const name of PKGS) {
  check(existsSync(join(packDir, `${name}-${PKG_VERSION[name]}.tgz`)), `${name}-${PKG_VERSION[name]}.tgz packed`);
}

step("tarball hygiene (no HN/plan material, no .local, no node_modules)");
for (const name of PKGS) {
  const out = run("tar", ["-tzf", join(packDir, `${name}-${PKG_VERSION[name]}.tgz`)], { capture: true }).toString();
  const bad = out.split("\n").filter((l) => /(^|\/)(\.local|plan.*\.md|node_modules|\.m3-run|\.m3-cache)\b/i.test(l));
  check(bad.length === 0, `${name}: clean file list${bad.length ? ` — leaked: ${bad.slice(0, 3).join(", ")}` : ""}`);
  check(/package\.json/.test(out) && (name === "decisionkit-cli" ? /cli\.js/.test(out) : /README\.md/.test(out)), `${name}: ships expected entries`);
}

const CLI = ["node", join(ROOT, "packages/core/dist/cli.js")];

function arm(name, host, asserts, removedAsserts) {
  step(`init --agent ${host} --tarballs (npm tarballs only, no registry specs)`);
  const repo = mkdtempSync(join(tmpdir(), `decisionkit-${host}-`));
  try {
    run("node", [...CLI.slice(1), "init", "--agent", host, "--tarballs", packDir], { cwd: repo });
    for (const [label, ok] of asserts(repo)) check(ok, label);
    step(`${host}: installed tree smoke check (decisionkit matrix via installed core)`);
    const coreCli = join(repo, host === "pi" ? ".pi/extensions/decisionkit/node_modules" : ".decisionkit/hooks/node_modules", "decisionkit-core/dist/cli.js");
    if (existsSync(coreCli)) {
      const out = run("node", [coreCli, "matrix"], { cwd: repo, capture: true }).toString();
      check(out.includes("capability matrix"), `${host}: installed core CLI runs (matrix output)`);
    }
    step(`${host}: remove undoes the install`);
    run("node", [...CLI.slice(1), "remove", "--agent", host], { cwd: repo });
    for (const [label, ok] of removedAsserts(repo)) check(!ok, `${host}: gone after remove — ${label}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

arm("pi", "pi",
  (repo) => [
    [".pi/extensions/decisionkit/package.json", existsSync(join(repo, ".pi/extensions/decisionkit/package.json"))],
    [".pi/extensions/decisionkit/src/index.ts", existsSync(join(repo, ".pi/extensions/decisionkit/src/index.ts"))],
    ["installed decisionkit-pi-ext", existsSync(join(repo, ".pi/extensions/decisionkit/node_modules/decisionkit-pi-ext/src/index.ts"))],
    ["installed core dist", existsSync(join(repo, ".pi/extensions/decisionkit/node_modules/decisionkit-core/dist/cli.js"))],
  ],
  (repo) => [[".pi/extensions/decisionkit", existsSync(join(repo, ".pi/extensions/decisionkit"))]],
);

arm("opencode", "opencode",
  (repo) => [
    ["opencode.json plugin entry", existsSync(join(repo, "opencode.json"))],
    [".opencode/plugins/decisionkit.ts", existsSync(join(repo, ".opencode/plugins/decisionkit.ts"))],
    ["installed decisionkit-opencode-plugin", existsSync(join(repo, ".opencode/node_modules/decisionkit-opencode-plugin/src/index.ts"))],
  ],
  (repo) => [
    [".opencode/plugins/decisionkit.ts", existsSync(join(repo, ".opencode/plugins/decisionkit.ts"))],
  ],
);

arm("claude", "claude",
  (repo) => [
    [".claude/settings.json hooks", existsSync(join(repo, ".claude/settings.json"))],
    [".mcp.json", existsSync(join(repo, ".mcp.json"))],
    ["hook scripts", existsSync(join(repo, ".decisionkit/hooks/hook.mjs"))],
    ["installed core host-hook", existsSync(join(repo, ".decisionkit/hooks/node_modules/decisionkit-core/dist/host-hook.js"))],
  ],
  (repo) => [
    [".decisionkit/hooks", existsSync(join(repo, ".decisionkit/hooks"))],
  ],
);

arm("codex", "codex",
  (repo) => [
    [".codex/hooks.json", existsSync(join(repo, ".codex/hooks.json"))],
    [".codex/config.toml MCP", existsSync(join(repo, ".codex/config.toml"))],
    ["hook scripts", existsSync(join(repo, ".decisionkit/hooks/hook.mjs"))],
    ["installed core host-hook", existsSync(join(repo, ".decisionkit/hooks/node_modules/decisionkit-core/dist/host-hook.js"))],
  ],
  (repo) => [[".decisionkit/hooks", existsSync(join(repo, ".decisionkit/hooks"))]],
);

rmSync(packDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "PASS — tarball-only installs verified" : `FAIL — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
