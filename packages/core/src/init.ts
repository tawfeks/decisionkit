import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `decisionkit init` / `decisionkit remove` (plan-v2 M5).
 *
 * Capability matrix verified against upstream docs 2026-09-21:
 *  - pi       https://pi.dev/docs/latest (local clone ground truth: pi/packages/coding-agent/docs/extensions.md)
 *  - opencode https://opencode.ai/docs/plugins
 *  - kilo     https://kilo.ai/docs/automate/extending/plugins
 *  - claude   https://code.claude.com/docs/en/hooks
 *  - codex    https://developers.openai.com/codex/hooks (+ /codex/extend/mcp)
 */

export type HostId = "pi" | "opencode" | "kilo" | "claude" | "codex";

export interface HostCapability {
  id: HostId;
  label: string;
  guardrail: string;
  routing: string;
  s0: string;
  triage: string;
  critic: string;
  locate: string;
  install: string;
  status: "supported" | "spiked";
}

export const CAPABILITIES: HostCapability[] = [
  {
    id: "pi",
    label: "pi",
    guardrail: "yes (tool_call → block)",
    routing: "YES (input event — deletes LLM turns)",
    s0: "yes (input event, merged digest; full S0 run state)",
    triage: "yes (phase-aware scoping)",
    critic: "yes (fast-path + caches)",
    locate: "yes (registerTool + content fallback)",
    install: "drop-in at .pi/extensions/decisionkit/",
    status: "supported",
  },
  {
    id: "opencode",
    label: "opencode",
    guardrail: "yes (tool.execute.before throw, fast-path + caches)",
    routing: "no hook (no prompt-intercept event)",
    s0: "yes (chat.message appends a digest text part)",
    triage: "yes (tool.execute.after rewrite + caches)",
    critic: "yes (fast-path)",
    locate: "yes (tool() registration + content fallback)",
    install: "npm plugin in opencode.json",
    status: "supported",
  },
  {
    id: "kilo",
    label: "kilo",
    guardrail: "yes (tool.execute.before throw, fast-path + caches)",
    routing: "no (chat.message cannot skip the LLM)",
    s0: "yes (chat.message appends a digest text part)",
    triage: "yes (tool.execute.after rewrite + caches)",
    critic: "yes (fast-path)",
    locate: "yes (tool() registration + content fallback)",
    install: "npm plugin in kilo.json (or kilo plugin <pkg>, or drop-in .kilo/plugin/)",
    status: "supported",
  },
  {
    id: "claude",
    label: "claude code",
    guardrail: "yes (PreToolUse permissionDecision: deny, read-only fast path)",
    routing: "no hook",
    s0: "yes (UserPromptSubmit additionalContext digest)",
    triage: "advisory (PostToolUse additionalContext; updatedToolOutput exists — future upgrade)",
    critic: "yes (fast-path; advisory additionalContext)",
    locate: "yes (MCP server)",
    install: "hooks in .claude/settings.json + .mcp.json",
    status: "supported",
  },
  {
    id: "codex",
    label: "codex",
    guardrail: "yes (PreToolUse deny; /hooks trust review required)",
    routing: "no hook",
    s0: "yes (UserPromptSubmit additionalContext digest)",
    triage: "result-replace (PostToolUse decision:block swaps the result; reads go through Bash — no read stubs)",
    critic: "result-replace (stronger than advisory, fast-path)",
    locate: "yes (MCP server in config.toml)",
    install: ".codex/hooks.json + [mcp_servers] in config.toml",
    status: "supported",
  },
];

const AGENTS = CAPABILITIES.map((c) => c.id);

export function capabilityMatrix(): string {
  const rows = CAPABILITIES.map(
    (c) =>
      `  ${c.label.padEnd(14)} guardrail: ${c.guardrail}\n` +
      `${" ".repeat(17)}routing: ${c.routing}\n` +
      `${" ".repeat(17)}s0 context: ${c.s0}\n` +
      `${" ".repeat(17)}triage: ${c.triage} | critic: ${c.critic}\n` +
      `${" ".repeat(17)}locate: ${c.locate}\n` +
      `${" ".repeat(17)}install: ${c.install}${c.status === "spiked" ? " (capability spike only — recorded, not implemented)" : ""}`,
  );
  return `DecisionKit capability matrix (verified against upstream docs 2026-09-21):\n\n${rows.join("\n\n")}\n\nTier 2 turn routing is pi-only: no other host exposes a hook that can skip the LLM turn. S0 pre-turn context assembly ships on all five hosts (pi input-transform merge; opencode/kilo chat.message part; claude/codex UserPromptSubmit additionalContext). All five hosts install via this command.`;
}

/** Detect hosts from repo + home markers. Returns distinct detected hosts. */
export function detectHosts(cwd: string): HostId[] {
  const home = homedir();
  const has = (p: string): boolean => existsSync(p);
  const found: HostId[] = [];
  const push = (id: HostId, cond: boolean): void => {
    if (cond && !found.includes(id)) found.push(id);
  };
  push("pi", has(resolve(cwd, ".pi")) || has(resolve(home, ".pi/agent")));
  push(
    "opencode",
    has(resolve(cwd, "opencode.json")) || has(resolve(cwd, ".opencode")) || has(resolve(home, ".config/opencode")),
  );
  push("kilo", has(resolve(cwd, "kilo.json")) || has(resolve(cwd, ".kilo")) || has(resolve(home, ".config/kilo")));
  push("claude", has(resolve(cwd, ".claude")) || has(resolve(cwd, "CLAUDE.md")) || has(resolve(home, ".claude")));
  push("codex", has(resolve(cwd, ".codex")) || has(resolve(home, ".codex")));
  return found;
}

interface InstallOpts {
  cwd: string;
  agent: HostId;
  /** Dev mode: link workspace packages with file: instead of npm specs. */
  dev?: boolean;
  /** Install deps from local tarballs (npm pack output) instead of registry
   * specs — the M5 acceptance path ("fresh install from npm tarballs only,
   * no file: links to the workspace, no registry publish required"). */
  tarballs?: string;
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** Real path of this package (works via workspace symlinks and npm installs). */
const thisPkgRoot = (): string => {
  const here = fileURLToPath(import.meta.url); // …/packages/core/src/init.ts or …/node_modules/decisionkit-core/dist/init.js
  const root = resolve(dirname(here), "..", "..");
  return existsSync(resolve(root, "package.json")) ? root : resolve(dirname(here), "..");
};

const SIBLING_DIRS: Record<string, string> = {
  "decisionkit-core": "core",
  "decisionkit-pi-ext": "pi-ext",
  "decisionkit-opencode-plugin": "opencode-plugin",
  "decisionkit-kilo-plugin": "kilo-plugin",
};

const siblingPkg = (name: string): string => {
  const dir = SIBLING_DIRS[name];
  if (dir === undefined) throw new Error(`unknown sibling package: ${name}`);
  const root = resolve(thisPkgRoot(), "..", dir);
  if (!existsSync(root)) {
    throw new Error(`--dev mode needs the monorepo checkout: ${root} not found (run init without --dev, or from the decisionkit workspace)`);
  }
  return root;
};

const PKG_VERSIONS: Record<string, string> = {
  "decisionkit-core": "0.1.2",
  "decisionkit-pi-ext": "0.1.2",
  "decisionkit-opencode-plugin": "0.1.2",
  "decisionkit-kilo-plugin": "0.1.2",
  "decisionkit-cli": "0.1.2",
};

const npmSpec = (name: string, opts: InstallOpts): string => {
  if (opts.dev === true) return `file:${siblingPkg(name)}`;
  if (opts.tarballs !== undefined) {
    const tarball = resolve(opts.cwd ?? process.cwd(), opts.tarballs, `${name}-${PKG_VERSIONS[name]}.tgz`);
    if (!existsSync(tarball)) {
      throw new Error(`tarball not found: ${tarball} (run scripts/verify-tarball-install.mjs, or npm pack --pack-destination <dir> for each package)`);
    }
    return `file:${tarball}`;
  }
  return `^${PKG_VERSIONS[name]}`;
};

const npmInstall = (dir: string): void => {
  console.log(`npm install in ${dir} …`);
  execFileSync("npm", ["install", "--omit=dev", "--no-package-lock"], { cwd: dir, stdio: "inherit" });
};

const PI_DROPIN_INDEX = `// decisionkit pi drop-in (generated by decisionkit init).
// The adapter lives in decisionkit-pi-ext (single source); pi's extension
// loader bundles @earendil-works/pi-coding-agent and typebox, so only
// decisionkit-core + the SDK need real node_modules here.
import decisionkitExtension from "decisionkit-pi-ext";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  decisionkitExtension(pi);
}
`;

function installPi(opts: InstallOpts): number {
  const dir = resolve(opts.cwd, ".pi/extensions/decisionkit");
  if (existsSync(dir)) {
    console.log(`pi: drop-in already present at ${dir} — nothing to do`);
    return 0;
  }
  mkdirSync(resolve(dir, "src"), { recursive: true });
  writeJson(resolve(dir, "package.json"), {
    name: "decisionkit-pi-dropin",
    private: true,
    type: "module",
    dependencies: {
      "@typesafe-ai/sdk": "0.6.0",
      "decisionkit-core": npmSpec("decisionkit-core", opts),
      "decisionkit-pi-ext": npmSpec("decisionkit-pi-ext", opts),
    },
    pi: { extensions: ["./src/index.ts"] },
  });
  writeFileSync(resolve(dir, "src/index.ts"), PI_DROPIN_INDEX);
  npmInstall(dir);
  console.log(`pi: DecisionKit drop-in installed at ${dir}`);
  return 0;
}

/** Add `entry` to the host config's "plugin" array (create file if absent). */
function addPluginEntry(configPath: string, entry: string, host: string, schema?: string): number {
  if (existsSync(configPath)) {
    const parsed = readJson(configPath);
    if (parsed === undefined) {
      console.error(
        `${host}: could not parse ${configPath} (JSONC comments?) — add "${entry}" to its "plugin" array manually`,
      );
      return 2;
    }
    const plugin = Array.isArray(parsed.plugin) ? (parsed.plugin as unknown[]) : [];
    if (plugin.includes(entry)) {
      console.log(`${host}: plugin entry already present in ${configPath}`);
      return 0;
    }
    writeJson(configPath, { ...parsed, plugin: [...plugin, entry] });
  } else {
    writeJson(configPath, schema === undefined ? { plugin: [entry] } : { $schema: schema, plugin: [entry] });
  }
  console.log(`${host}: added "${entry}" to ${configPath}`);
  return 0;
}

function removePluginEntry(configPath: string, entry: string, host: string): number {
  if (!existsSync(configPath)) return 0;
  const parsed = readJson(configPath);
  if (parsed === undefined || !Array.isArray(parsed.plugin)) return 0;
  const plugin = (parsed.plugin as unknown[]).filter((p) => p !== entry);
  if (plugin.length === 0) delete parsed.plugin;
  else parsed.plugin = plugin;
  writeJson(configPath, parsed);
  console.log(`${host}: removed "${entry}" from ${configPath}`);
  return 0;
}

const OPENCODE_PLUGIN_REEXPORT = `// decisionkit opencode plugin (generated by decisionkit init --dev).
export { DecisionKitPlugin as DecisionKit } from "decisionkit-opencode-plugin";
`;

const KILO_PLUGIN_REEXPORT = `// decisionkit kilo plugin (generated by decisionkit init --dev).
import decisionkit from "decisionkit-kilo-plugin";
export default decisionkit;
`;

function installOpencode(opts: InstallOpts): number {
  if (opts.dev === true || opts.tarballs !== undefined) {
    const cfgDir = resolve(opts.cwd, ".opencode");
    mkdirSync(resolve(cfgDir, "plugins"), { recursive: true });
    writeFileSync(resolve(cfgDir, "plugins/decisionkit.ts"), OPENCODE_PLUGIN_REEXPORT);
    writeJson(resolve(cfgDir, "package.json"), {
      dependencies: {
        "decisionkit-core": npmSpec("decisionkit-core", opts),
        "decisionkit-opencode-plugin": npmSpec("decisionkit-opencode-plugin", opts),
      },
    });
    if (opts.tarballs !== undefined) {
      npmInstall(cfgDir);
      console.log(`opencode: tarball deps installed into .opencode/node_modules (from ${opts.tarballs})`);
      return addPluginEntry(
        resolve(opts.cwd, "opencode.json"),
        "decisionkit-opencode-plugin",
        "opencode",
        "https://opencode.ai/config.json",
      );
    }
    console.log("opencode: dev plugin written to .opencode/plugins/decisionkit.ts (bun installs deps at startup)");
    return 0;
  }
  return addPluginEntry(
    resolve(opts.cwd, "opencode.json"),
    "decisionkit-opencode-plugin",
    "opencode",
    "https://opencode.ai/config.json",
  );
}

function installKilo(opts: InstallOpts): number {
  if (opts.dev === true || opts.tarballs !== undefined) {
    const cfgDir = resolve(opts.cwd, ".kilo");
    mkdirSync(resolve(cfgDir, "plugin"), { recursive: true });
    writeFileSync(resolve(cfgDir, "plugin/decisionkit.ts"), KILO_PLUGIN_REEXPORT);
    writeJson(resolve(cfgDir, "package.json"), {
      dependencies: {
        "decisionkit-core": npmSpec("decisionkit-core", opts),
        "decisionkit-kilo-plugin": npmSpec("decisionkit-kilo-plugin", opts),
      },
    });
    if (opts.tarballs !== undefined) {
      npmInstall(cfgDir);
      console.log(`kilo: tarball deps installed into .kilo/node_modules (from ${opts.tarballs})`);
      return addPluginEntry(resolve(opts.cwd, "kilo.json"), "decisionkit-kilo-plugin", "kilo");
    }
    console.log("kilo: dev plugin written to .kilo/plugin/decisionkit.ts (bun installs deps at startup)");
    return 0;
  }
  return addPluginEntry(resolve(opts.cwd, "kilo.json"), "decisionkit-kilo-plugin", "kilo");
}

function removeOpencode(cwd: string): number {
  rmSync(resolve(cwd, ".opencode/plugins/decisionkit.ts"), { force: true });
  removePluginEntry(resolve(cwd, "opencode.json"), "decisionkit-opencode-plugin", "opencode");
  return 0;
}

function removeKilo(cwd: string): number {
  rmSync(resolve(cwd, ".kilo/plugin/decisionkit.ts"), { force: true });
  removePluginEntry(resolve(cwd, "kilo.json"), "decisionkit-kilo-plugin", "kilo");
  return 0;
}

// ── Claude Code + Codex: JSON-on-stdin hosts ────────────────────────────────
// Both get the same self-contained hook dir (.decisionkit/hooks/) that npm-
// installs decisionkit-core and re-exports two tiny entries: hook.mjs (stdin
// JSON → guardrail/critic decision via core's runHostHookStdin) and mcp.mjs
// (decisionkit_locate MCP server via core's stdioMain). All policy lives in
// core; the generated files are thin wrappers only.

const HOOK_MJS = `#!/usr/bin/env node
// decisionkit hook (generated by decisionkit init). Reads the host's JSON on
// stdin, prints the decision JSON (if any). Policy lives in decisionkit-core.
const [host, event] = process.argv.slice(2);
const { runHostHookStdin } = await import("decisionkit-core/host-hook");
await runHostHookStdin(host, event);
`;

const MCP_MJS = `#!/usr/bin/env node
// decisionkit_locate MCP server (generated by decisionkit init).
import "decisionkit-core/mcp";
`;

const HOOK_MARKER = ".decisionkit/hooks/hook.mjs";

const claudeHookCommand = (event: "pre" | "post" | "prompt"): string =>
  `node "\${CLAUDE_PROJECT_DIR}/.decisionkit/hooks/hook.mjs" ${event}`;

const codexHookCommand = (event: "pre" | "post" | "prompt"): string =>
  `node "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.decisionkit/hooks/hook.mjs" ${event}`;

/** Write/refresh .decisionkit/hooks (package.json + entry scripts) and npm-install it. */
function ensureHookDir(opts: InstallOpts): number {
  const dir = resolve(opts.cwd, ".decisionkit/hooks");
  const pkgPath = resolve(dir, "package.json");
  if (existsSync(pkgPath)) {
    console.log("decisionkit: hook scripts already present at .decisionkit/hooks — refreshing entries only");
    writeFileSync(resolve(dir, "hook.mjs"), HOOK_MJS);
    writeFileSync(resolve(dir, "mcp.mjs"), MCP_MJS);
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  writeJson(pkgPath, {
    name: "decisionkit-hooks",
    private: true,
    type: "module",
    dependencies: {
      "decisionkit-core": npmSpec("decisionkit-core", opts),
    },
  });
  writeFileSync(resolve(dir, "hook.mjs"), HOOK_MJS);
  writeFileSync(resolve(dir, "mcp.mjs"), MCP_MJS);
  npmInstall(dir);
  return 0;
}

/** True if some hook entry anywhere in the settings shape references our command. */
const hasOurHook = (hooks: unknown): boolean =>
  JSON.stringify(hooks ?? {}).includes(HOOK_MARKER);

function upsertHookGroups(
  hooks: Record<string, unknown>,
  event: string,
  command: string,
  extra: Record<string, unknown>,
): void {
  const groups = Array.isArray(hooks[event]) ? (hooks[event] as Record<string, unknown>[]) : [];
  if (JSON.stringify(groups).includes(HOOK_MARKER)) return;
  hooks[event] = [...groups, { hooks: [{ type: "command", command, ...extra }] }];
}

function pruneHookGroups(hooks: Record<string, unknown>, event: string): void {
  const groups = Array.isArray(hooks[event]) ? (hooks[event] as Record<string, unknown>[]) : [];
  const kept = groups
    .map((g) => {
      const inner = Array.isArray(g.hooks) ? (g.hooks as Record<string, unknown>[]) : [];
      return { ...g, hooks: inner.filter((h) => !String(h.command ?? "").includes(HOOK_MARKER)) };
    })
    .filter((g) => (g.hooks as Record<string, unknown>[]).length > 0);
  if (kept.length === 0) delete hooks[event];
  else hooks[event] = kept;
}

function installClaude(opts: InstallOpts): number {
  const rc = ensureHookDir(opts);
  if (rc !== 0) return rc;
  const settingsPath = resolve(opts.cwd, ".claude/settings.json");
  const settings = readJson(settingsPath) ?? {};
  const hooks = (settings.hooks as Record<string, unknown> | undefined) ?? {};
   upsertHookGroups(hooks, "PreToolUse", claudeHookCommand("pre"), {});
  upsertHookGroups(hooks, "PostToolUse", claudeHookCommand("post"), {});
  upsertHookGroups(hooks, "UserPromptSubmit", claudeHookCommand("prompt"), {});
  writeJson(settingsPath, { ...settings, hooks });

  const mcpPath = resolve(opts.cwd, ".mcp.json");
  const mcp = readJson(mcpPath) ?? {};
  const servers = (mcp.mcpServers as Record<string, unknown> | undefined) ?? {};
  servers.decisionkit = {
    type: "stdio",
    command: "node",
    args: ["${CLAUDE_PROJECT_DIR}/.decisionkit/hooks/mcp.mjs"],
  };
  writeJson(mcpPath, { ...mcp, mcpServers: servers });

  console.log(
    "claude: hooks installed in .claude/settings.json (PreToolUse guardrail, PostToolUse critic) + decisionkit_locate MCP in .mcp.json",
  );
  return 0;
}

function installCodex(opts: InstallOpts): number {
  const rc = ensureHookDir(opts);
  if (rc !== 0) return rc;
  const hooksPath = resolve(opts.cwd, ".codex/hooks.json");
  const parsed = existsSync(hooksPath) ? readJson(hooksPath) : undefined;
  if (existsSync(hooksPath) && parsed === undefined) {
    console.error(
      "codex: could not parse .codex/hooks.json — merge the decisionkit hook entries manually (see docs/capability-matrix.md)",
    );
    return 2;
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const hooks = (root.hooks as Record<string, unknown> | undefined) ?? {};
  upsertHookGroups(hooks, "PreToolUse", codexHookCommand("pre"), { timeout: 15, statusMessage: "decisionkit guardrail" });
  upsertHookGroups(hooks, "PostToolUse", codexHookCommand("post"), { timeout: 15, statusMessage: "decisionkit critic" });
  upsertHookGroups(hooks, "UserPromptSubmit", codexHookCommand("prompt"), { timeout: 15, statusMessage: "decisionkit s0 context" });
  writeJson(hooksPath, { ...root, hooks });

  const tomlPath = resolve(opts.cwd, ".codex/config.toml");
  let toml: string = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  if (!toml.includes("[mcp_servers.decisionkit]")) {
    if (toml.length > 0 && !toml.endsWith("\n")) toml += "\n";
    toml += `\n[mcp_servers.decisionkit]\ncommand = "node"\nargs = ['${resolve(opts.cwd, ".decisionkit/hooks/mcp.mjs")}']\n`;
    mkdirSync(resolve(opts.cwd, ".codex"), { recursive: true });
    writeFileSync(tomlPath, toml);
  }
  console.log(
    "codex: hooks written to .codex/hooks.json + decisionkit_locate MCP added to .codex/config.toml",
  );
  console.log(
    "codex: TRUST REVIEW REQUIRED — run /hooks in Codex and trust the two decisionkit definitions; until then Codex skips them (verify paths in .codex/config.toml too)",
  );
  return 0;
}

/** Remove the shared hook dir when no config file references it anymore. */
function maybeRemoveHookDir(cwd: string): void {
  const refs = [
    resolve(cwd, ".claude/settings.json"),
    resolve(cwd, ".codex/hooks.json"),
    resolve(cwd, ".codex/config.toml"),
    resolve(cwd, ".mcp.json"),
  ]
    .map((p) => (existsSync(p) ? readFileSync(p, "utf8") : ""))
    .join("\n");
  if (!refs.includes(HOOK_MARKER)) {
    rmSync(resolve(cwd, ".decisionkit/hooks"), { recursive: true, force: true });
    rmSync(resolve(cwd, ".decisionkit/receipts.jsonl"), { force: true });
  }
}

function removeClaude(cwd: string): number {
  const settingsPath = resolve(cwd, ".claude/settings.json");
  const settings = readJson(settingsPath);
  if (settings !== undefined && settings.hooks !== undefined && typeof settings.hooks === "object") {
    const hooks = settings.hooks as Record<string, unknown>;
    for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit"]) pruneHookGroups(hooks, event);
    writeJson(settingsPath, settings);
  }
  const mcpPath = resolve(cwd, ".mcp.json");
  const mcp = readJson(mcpPath);
  if (mcp !== undefined && mcp.mcpServers !== undefined && typeof mcp.mcpServers === "object") {
    const servers = mcp.mcpServers as Record<string, unknown>;
    delete servers.decisionkit;
    if (Object.keys(servers).length === 0) delete mcp.mcpServers;
    writeJson(mcpPath, mcp);
  }
  maybeRemoveHookDir(cwd);
  console.log("claude: removed decisionkit hooks + MCP entries");
  return 0;
}

function removeCodex(cwd: string): number {
  const hooksPath = resolve(cwd, ".codex/hooks.json");
  const parsed = readJson(hooksPath);
  if (parsed !== undefined && parsed.hooks !== undefined && typeof parsed.hooks === "object") {
    const hooks = parsed.hooks as Record<string, unknown>;
    for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit"]) pruneHookGroups(hooks, event);
    if (Object.keys(hooks).length === 0) delete parsed.hooks;
    if (Object.keys(parsed).length > 0) writeJson(hooksPath, parsed);
    else rmSync(hooksPath, { force: true });
  }
  const tomlPath = resolve(cwd, ".codex/config.toml");
  if (existsSync(tomlPath)) {
    const toml = readFileSync(tomlPath, "utf8");
    const pruned = toml.replace(/\n?\[mcp_servers\.decisionkit\][^\[]*(?=\n\[|\n?$)/, "");
    if (pruned !== toml) writeFileSync(tomlPath, pruned);
  }
  maybeRemoveHookDir(cwd);
  console.log("codex: removed decisionkit hook entries + MCP section");
  return 0;
}

// ── Shipped agent skills ────────────────────────────────────────────────────
// decisionkit-core ships agent-facing skills (SKILL.md bundles) in
// dist/skills/ (source: packages/core/src/skills/). init copies them into the
// host's native skills directory when one is verified; hosts without one keep
// them at the shipped path (node_modules/decisionkit-core/dist/skills/).

const SHIPPED_SKILLS = ["decisionkit-calibrate", "decisionkit-bench-fixture"];

/** Host skills directory relative to the repo root (undefined = no verified surface). */
const SKILLS_DIR: Partial<Record<HostId, string>> = {
  kilo: ".kilo/skills",
  opencode: ".opencode/skill",
  claude: ".claude/skills",
};

/** Source of the shipped skills (npm install → dist/skills; workspace → src/skills). */
function shippedSkillsRoot(): string | undefined {
  const root = thisPkgRoot();
  for (const p of [resolve(root, "dist", "skills"), resolve(root, "skills"), resolve(root, "src", "skills")]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

function installSkills(agent: HostId, cwd: string): void {
  const target = SKILLS_DIR[agent];
  if (target === undefined) {
    console.log(`skills: ${agent} has no verified skills directory — shipped skills stay at decisionkit-core/dist/skills/`);
    return;
  }
  const srcRoot = shippedSkillsRoot();
  if (srcRoot === undefined) {
    console.log("skills: shipped skills not found next to decisionkit-core (skipped)");
    return;
  }
  const names = readdirSync(srcRoot).filter((n) => existsSync(resolve(srcRoot, n, "SKILL.md")));
  if (names.length === 0) return;
  for (const name of names) {
    cpSync(resolve(srcRoot, name), resolve(cwd, target, name), { recursive: true });
  }
  console.log(`skills: installed ${names.join(", ")} into ${target}/`);
}

function removeSkills(agent: HostId, cwd: string): void {
  const target = SKILLS_DIR[agent];
  if (target === undefined) return;
  for (const name of SHIPPED_SKILLS) {
    rmSync(resolve(cwd, target, name), { recursive: true, force: true });
  }
  console.log(`skills: removed decisionkit skills from ${target}/`);
}

function postInstallNotes(agent: HostId): void {
  console.log(`
Next steps:
  1. Verify the shipped ${agent}-calibrated pack against this repo:
     npx decisionkit-cli test
     (exit 0 = all gated tiers pass; exit 1 = gate failure)
  2. No per-repo calibration: the pack ships pre-calibrated for ${agent}
     (tier set per its verified hook surface; wording measured once on the
     central rigs). If a tier fails its gate, that is a default-pack bug —
     fix it in the central harness (packages/core/scripts), never per repo.
  3. Receipts land in .decisionkit/receipts.jsonl. Shadow mode: the guardrail
     only logs until you opt into enforce. Kill switch: DECISIONKIT_ENABLE=0.
  4. Shipped agent skills (decisionkit-calibrate, decisionkit-bench-fixture)
     are available for your agent — copied into the host skills dir when one
     is verified, else at decisionkit-core/dist/skills/.
`);
}

export function runInit(argv: string[]): number {
  let agent: HostId | undefined;
  let dev = false;
  let tarballs: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dev") dev = true;
    else if (a === "--tarballs") {
      const v = argv[++i];
      if (v === undefined) {
        console.error("--tarballs needs a directory of npm pack output (*.tgz)");
        return 2;
      }
      tarballs = v;
    } else if (a === "--agent") {
      const v = argv[++i];
      if (v === undefined || !AGENTS.includes(v as HostId)) {
        console.error(`--agent must be one of: ${AGENTS.join(", ")}`);
        return 2;
      }
      agent = v as HostId;
    } else {
      console.error(`unknown flag: ${a}`);
      return 2;
    }
  }
  if (dev && tarballs !== undefined) {
    console.error("--dev and --tarballs are mutually exclusive");
    return 2;
  }

  const cwd = process.cwd();
  console.log(capabilityMatrix());
  if (agent === undefined) {
    const detected = detectHosts(cwd);
    if (detected.length === 0) {
      console.error(
        `\nno supported host detected in ${cwd} (looked for pi, opencode, kilo, claude code, codex markers) — pass --agent <name>`,
      );
      return 2;
    }
    if (detected.length > 1) {
      console.error(
        `\nmultiple hosts detected: ${detected.join(", ")} — pass --agent <name> to pick one (or run init once per host)`,
      );
      return 2;
    }
    agent = detected[0];
    if (agent === undefined) return 2;
  }
  console.log(`\ninstalling for: ${agent}\n`);
  const host: HostId = agent;

  const opts: InstallOpts = { cwd, agent: host, dev, ...(tarballs !== undefined ? { tarballs } : {}) };
  const rc = host === "pi" ? installPi(opts)
    : host === "opencode" ? installOpencode(opts)
    : host === "kilo" ? installKilo(opts)
    : host === "claude" ? installClaude(opts)
    : host === "codex" ? installCodex(opts)
    : 2;
  if (rc === 0) {
    installSkills(host, cwd);
    postInstallNotes(host);
  }
  return rc;
}

export function runRemove(argv: string[]): number {
  let agent: HostId | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent") {
      const v = argv[++i];
      if (v === undefined || !AGENTS.includes(v as HostId)) {
        console.error(`--agent must be one of: ${AGENTS.join(", ")}`);
        return 2;
      }
      agent = v as HostId;
    }
  }
  const cwd = process.cwd();
  const targets = agent !== undefined ? [agent] : detectHosts(cwd);
  if (targets.length === 0) {
    console.error("no host detected — pass --agent <name>");
    return 2;
  }
  for (const t of targets) {
    if (t === "pi") rmSync(resolve(cwd, ".pi/extensions/decisionkit"), { recursive: true, force: true });
    else if (t === "opencode") removeOpencode(cwd);
    else if (t === "kilo") removeKilo(cwd);
    else if (t === "claude") removeClaude(cwd);
    else if (t === "codex") removeCodex(cwd);
    removeSkills(t, cwd);
    console.log(`${t}: removed`);
  }
  return 0;
}
