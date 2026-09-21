/**
 * Bench runner — A/B the DecisionKit pi extension against stock pi on ANY repo.
 *
 * Per (run, prompt, arm):
 *   1. fresh copy of the repo → .bench-run/run{N}-{arm}-{promptKey}
 *      (kept after the test: each test = its own saved named copy)
 *   2. ship .env INTO the copy (providers read cwd/.env)
 *   3. s0 arm: install the pi drop-in (bench/dropin) + the calibrated pack
 *      (pack: the shipped agent-calibrated default inside decisionkit-core)
 *   4. run pi `-p <prompt>` (no -c — single-task copies), -a on the s0 arm
 *   5. parse the session jsonl + fresh receipt lines → fixture verify() if the
 *      fixture defines one (else metrics only)
 *   6. write .bench-run/run{N}-{arm}-{promptKey}.json → aggregate with report.ts
 *
 * Arms: base = stock pi; s0 = decisionkit extension. Prompts × arms INTERLEAVED
 * (same provider window per prompt — no drift confound). Dead invocation
 * (non-zero exit or 0 assistant turns) → retry ONCE, then abort.
 *
 * Run:  npx tsx bench/run.ts --fixture outbidlaunch --runs 3
 *       npx tsx bench/run.ts "the 3d map is missing some countries, fix it"
 *       npx tsx bench/run.ts --repo ./my-app --runs 1 --prompt "find the broken import"
 * (no args → prints the full usage)
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { Fixture, VerifyResult } from "./fixture-api.js";
import { outbidlaunch } from "./fixtures/outbidlaunch.js";

const WORKSPACE = resolve(import.meta.dirname, "..");
const PI_CLI = resolve(WORKSPACE, "pi/packages/coding-agent/dist/bundle/cli.js");
const DROPIN = resolve(WORKSPACE, "bench/dropin");
const CACHE_DIR = resolve(WORKSPACE, ".bench-cache");
const DEFAULT_REPO = resolve(WORKSPACE, "tested-repo");

const FIXTURES: Record<string, Fixture> = { outbidlaunch };

// Load the workspace .env into process.env (does not override existing vars).
// pi never reads cwd/.env; without this, pi falls back to its own auth store.
for (const line of (() => {
  try {
    return readFileSync(resolve(WORKSPACE, ".env"), "utf8").split("\n");
  } catch {
    return [];
  }
})()) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!m || process.env[m[1]] !== undefined) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
}

// Isolated pi agent dir: auth resolution in pi prefers stored credentials over
// env keys, so the user's ~/.pi/agent/auth.json would shadow OPENROUTER_API_KEY.
// An empty agent dir has no stored credentials → pi uses the env key from .env.
const BENCH_AGENT_DIR = resolve(CACHE_DIR, "pi-agent");
mkdirSync(BENCH_AGENT_DIR, { recursive: true });

// ------------------------------------------------------------------- usage ---

const USAGE = `DecisionKit bench — A/B the DecisionKit pi extension against stock pi on any repo.

REPO (pick one):
  --repo <path>          benchmark a local repo directory as-is
  --clone <git-url>      shallow-clone a repo first (cached at .bench-cache/<name>)
  --ref <commit|branch>  with --clone: pin an exact ref
  --fixture <name>       shipped preset: pinned repo + shipped prompts + verify
                         (available: ${Object.keys(FIXTURES).join(", ")})
  (default)              ./tested-repo — put or clone any repo there, e.g.
                           git clone https://github.com/fastlaunch/outbidlaunch.git tested-repo

PROMPTS (pick one):
  --prompt "..."         explicit prompt (repeatable for several prompts)
  "..."                  positional — just paste the prompt as an argument, e.g.
                           npx tsx bench/run.ts "the 3d map is missing some countries, fix it"
                         (quote it — spaces break an unquoted prompt into args)
  --prompts pA,pB        subset of the fixture's shipped prompt keys (with --fixture)
  (default)              all shipped fixture prompts (requires --fixture)

OTHER
  --runs N               runs per (prompt, arm); default 3
  --arms base,s0         comma list; default both
  --model <id>           frontier model for pi (env BENCH_MODEL; default openrouter/z-ai/glm-5.3-flash:low)
  --timeout-ms N         per-prompt timeout; default 300000
  --dir .bench-run       artifact directory

NOTE: both arms are real LLM calls — this costs real spend. Keys come from the
workspace .env (TYPESAFE_API_KEY for DecisionKit + a frontier provider key).
Aggregate afterwards: npx tsx bench/report.ts [--dir .bench-run]`;

const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => process.argv.includes(name);

// -------------------------------------------------------------- repo setup ---

/** Shallow-clone `url` (optionally pinned to `ref`) into .bench-cache/<name>. */
const ensureClone = (url: string, ref: string | undefined, name: string): string => {
  const dir = resolve(CACHE_DIR, name);
  if (existsSync(resolve(dir, ".git"))) return dir;
  mkdirSync(dir, { recursive: true });
  const git = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`git ${args.join(" ")} failed:\n${r.stderr}`);
      process.exit(1);
    }
  };
  console.log(`cloning ${url}${ref ? ` @ ${ref}` : ""} (first time only) …`);
  git(["init"]);
  git(["remote", "add", "origin", url]);
  git(["-c", "protocol.version=2", "fetch", "--depth", "1", "origin", ref ?? "HEAD"]);
  git(["checkout", "FETCH_HEAD"]);
  return dir;
};

const copyFilter = (src: string): boolean => {
  const name = basename(src);
  return name !== "node_modules" && name !== ".git";
};

// ------------------------------------------------------------ run harness ---

interface TurnMetrics {
  promptKey: string;
  wallMs: number;
  exitCode: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  maxInputTokens: number;
  toolCalls: Record<string, number>;
  editedFiles: string[];
  jevCalls: number;
  s0JevCalls: number;
  s0LatencyMs: number;
  s0FailOpens: number;
  digestInjected: boolean;
  digestChars: number;
  digestNote: string;
  s0Picked: string[];
  s0Wasted: number;
  executed: boolean;
  attempts: number;
}

const listSessionFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  try {
    walk(dir);
  } catch {
    /* dir may not exist yet */
  }
  return out;
};

const readEntries = (file: string): Array<Record<string, unknown>> =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });

const EDIT_TOOLS = new Set(["edit", "write", "multiEdit", "applyPatch"]);
const extractEditedPaths = (name: string, args: Record<string, unknown>): string[] => {
  if (!EDIT_TOOLS.has(name)) return [];
  const p = args.path ?? args.file_path ?? args.filePath;
  return typeof p === "string" ? [p] : [];
};

/** One (prompt, arm) execution against a fresh copy. */
const runPrompt = (copyDir: string, promptKey: string, text: string, arm: string, t0: number, receiptsFile: string, timeoutMs: number, model: string): TurnMetrics => {
  const sessionDir = resolve(copyDir, ".bench-sessions");
  const before = new Map(listSessionFiles(sessionDir).map((f) => [f, statSync(f).mtimeMs]));
  let receiptsOffset = 0;
  if (arm === "s0") {
    try {
      receiptsOffset = statSync(receiptsFile).size;
    } catch {
      /* no receipts yet */
    }
  }
  const args = ["-p", text, "--model", model];
  if (arm === "s0") args.push("-a"); // trust project-local extension for one run
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: BENCH_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    ...(arm === "s0" ? { DECISIONKIT_LEDGER_PATH: receiptsFile, DECISIONKIT_ENABLE: "1" } : {}),
  };
  const started = Date.now();
  const res = spawnSync("node", [PI_CLI, ...args], { cwd: copyDir, env, timeout: timeoutMs, encoding: "utf8" });
  const wallMs = Date.now() - started;

  // Fresh receipt lines → real jev calls (inputTokens > 0; fastpath receipts
  // have model "local-fastpath" / 0 tokens) + tier=="s0" split.
  let jevCalls = 0;
  let s0JevCalls = 0;
  let s0LatencyMs = 0;
  let s0FailOpens = 0;
  if (arm === "s0") {
    try {
      const fresh = readFileSync(receiptsFile, "utf8").slice(receiptsOffset).split("\n").filter(Boolean);
      for (const line of fresh) {
        try {
          const r = JSON.parse(line) as { latencyMs?: number; inputTokens?: number; tier?: string; ok?: boolean; failOpen?: boolean };
          if (typeof r.latencyMs === "number" && (r.inputTokens ?? 0) > 0 && r.ok !== false) {
            jevCalls++;
            s0LatencyMs += r.latencyMs;
            if (r.tier === "s0") s0JevCalls++;
          }
          if (r.tier === "s0" && r.failOpen === true) s0FailOpens++;
        } catch {
          /* malformed line */
        }
      }
    } catch {
      /* no receipts */
    }
  }

  // Session entries → turns/tokens/tools + digest & waste info.
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let maxInputTokens = 0;
  const toolCalls: Record<string, number> = {};
  const editedFiles: string[] = [];
  let digestInjected = false;
  let digestChars = 0;
  let digestNote = "";
  let s0Picked: string[] = [];
  let s0Wasted = -1;
  for (const f of listSessionFiles(sessionDir)) {
    const mtime = statSync(f).mtimeMs;
    const prev = before.get(f) ?? 0;
    if (mtime < Math.max(t0, prev)) continue;
    for (const e of readEntries(f)) {
      const ts = typeof e.timestamp === "number" ? e.timestamp : Date.parse(String(e.timestamp ?? ""));
      if (Number.isFinite(ts) && ts < Math.max(t0, prev)) continue;
      if (e.type === "custom_message" && e.customType === "decisionkit-s0") {
        digestInjected = true;
        const content = (e.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
        digestChars = content.reduce((a, c) => a + (c.text?.length ?? 0), 0);
        continue;
      }
      if (e.type === "custom" && e.customType === "decisionkit-s0") {
        const d = (e.data ?? {}) as { skip?: string; failOpen?: string; picked?: string[]; jevCalls?: number; ms?: number };
        if (typeof d.skip === "string") digestNote = `skip: ${d.skip}`;
        else if (typeof d.failOpen === "string") digestNote = `failOpen: ${d.failOpen}`;
        if (Array.isArray(d.picked)) s0Picked = d.picked;
        continue;
      }
      if (e.type === "custom" && e.customType === "decisionkit-s0-waste") {
        const d = (e.data ?? {}) as { wasted?: number };
        if (typeof d.wasted === "number") s0Wasted = d.wasted;
        continue;
      }
      if (e.type !== "message") continue;
      const msg = e.message as {
        role?: string;
        usage?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
        content?: Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }>;
      } | undefined;
      // Digest merged into the user prompt (cache-neutral input-transform
      // injection): the first user message starts with the digest marker.
      if (msg?.role === "user") {
        const text = Array.isArray(msg.content)
          ? (msg.content as Array<{ type?: string; text?: string }>)
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("\n")
          : typeof msg.content === "string"
            ? msg.content
            : "";
        if (text.startsWith("[decisionkit context")) {
          digestInjected = true;
          const sep = text.indexOf("\n\n---\n\n");
          digestChars = sep > 0 ? sep : text.length;
        }
        continue;
      }
      if (msg?.role !== "assistant") continue;
      turns++;
      inputTokens += msg.usage?.input ?? 0;
      outputTokens += msg.usage?.output ?? 0;
      reasoningTokens += msg.usage?.reasoning ?? 0;
      cacheReadTokens += msg.usage?.cacheRead ?? 0;
      cacheWriteTokens += msg.usage?.cacheWrite ?? 0;
      maxInputTokens = Math.max(maxInputTokens, msg.usage?.input ?? 0);
      for (const block of msg.content ?? []) {
        if (block.type !== "toolCall" || typeof block.name !== "string") continue;
        toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
        editedFiles.push(...extractEditedPaths(block.name, block.arguments ?? {}));
      }
    }
  }
  if (res.error) console.error(`[${arm}] ${promptKey} error: ${String(res.error)}`);
  return {
    promptKey,
    wallMs,
    exitCode: res.status ?? -1,
    turns,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    maxInputTokens,
    toolCalls,
    editedFiles,
    jevCalls,
    s0JevCalls,
    s0LatencyMs,
    s0FailOpens,
    digestInjected,
    digestChars,
    digestNote,
    s0Picked,
    s0Wasted,
    executed: (res.status ?? -1) === 0 && turns > 0,
    attempts: 1,
  };
};

// ------------------------------------------------------- terminal display ----

const fmtInt = (n: number): string => n.toLocaleString("en-US");
const fmtMs = (ms: number): string => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${fmtInt(ms)}ms`);
const fmtTok = (n: number): string => (n >= 100_000 ? `${(n / 1000).toFixed(0)}k` : fmtInt(n));

const printResult = (m: TurnMetrics, v: VerifyResult, arm: string): void => {
  const row = (label: string, value: string): void => console.log(`    ${label.padEnd(9)} ${value}`);
  const tools = Object.entries(m.toolCalls).map(([k, c]) => `${k}×${c}`).join(" + ") || "none";
  const verify = v.ok ? (v.required.startsWith("n/a") ? "n/a (metrics only)" : "PASS") : `FAIL — ${v.required}`;
  row("wall", `${fmtMs(m.wallMs)}  ·  ${m.turns} turns  ·  exit ${m.exitCode}${m.attempts > 1 ? `  (${m.attempts} attempts)` : ""}`);
  row("tokens", `↑ ${fmtTok(m.inputTokens)} (biggest single turn ${fmtTok(m.maxInputTokens)})  ↓ ${fmtTok(m.outputTokens)} + ${fmtTok(m.reasoningTokens)} reasoning`);
  row("cache", `read ${fmtTok(m.cacheReadTokens)}  ·  write ${fmtTok(m.cacheWriteTokens)}`);
  row("tools", tools);
  row("verify", verify);
  if (arm === "s0") {
    const parts = [
      `${m.s0JevCalls}/${m.jevCalls} jev calls (s0 tier) · ${fmtMs(m.s0LatencyMs)} total${m.s0FailOpens > 0 ? ` · ${m.s0FailOpens} failOpen` : ""}`,
      `digest ${fmtInt(m.digestChars)}ch${m.digestNote ? ` (${m.digestNote})` : ""}`,
      `wasted ${m.s0Wasted}`,
    ];
    if (m.s0Picked.length > 0) parts.push(`picked: ${m.s0Picked.join(", ")}`);
    row("s0", parts.join("\n             "));
  }
};

// Drop-in install (same mechanics as the demo rig setup), into the copy.
const installDropin = (copyDir: string): void => {
  const dropinDst = resolve(copyDir, ".pi/extensions/decisionkit");
  cpSync(DROPIN, dropinDst, { recursive: true });
  const pkgPath = resolve(dropinDst, "package.json");
  writeFileSync(
    pkgPath,
    readFileSync(pkgPath, "utf8")
      .replace("DECISIONKIT_CORE_PATH", resolve(WORKSPACE, "packages/core"))
      .replace("DECISIONKIT_PI_EXT_PATH", resolve(WORKSPACE, "packages/pi-ext")),
  );
  const r = spawnSync("npm", ["install", "--omit=dev", "--no-package-lock"], { cwd: dropinDst, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`npm install in drop-in failed: ${r.stderr ?? r.stdout}`);
    process.exit(1);
  }
};

// ------------------------------------------------------------------- main ----

// Direct invocation only (imports by wrappers skip the loop).
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  if (process.argv.length <= 2) {
    console.log(USAGE);
    process.exit(0);
  }
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  // ---- repo resolution
  const fixtureName = argValue("--fixture");
  let fixture: Fixture | undefined;
  if (fixtureName) {
    fixture = FIXTURES[fixtureName];
    if (!fixture) {
      console.error(`unknown fixture "${fixtureName}" — available: ${Object.keys(FIXTURES).join(", ")}`);
      process.exit(1);
    }
  }
  const fixtureKeys = argValue("--prompts");
  if (fixture && fixtureKeys) {
    const known = new Set(fixture.prompts.map((p) => p.key));
    const missing = fixtureKeys.split(",").filter((k) => !known.has(k));
    if (missing.length > 0) {
      console.error(`--prompts: unknown key(s) ${missing.join(",")} — fixture has: ${[...known].join(", ")}`);
      process.exit(1);
    }
  }
  const repoArg = argValue("--repo");
  const cloneArg = argValue("--clone");
  const refArg = argValue("--ref");
  let repoDir: string;
  let pristineDir: string; // unmutated source for fixture verify diffs
  if (repoArg) {
    repoDir = resolve(repoArg);
    if (!existsSync(repoDir)) {
      console.error(`--repo: no such directory: ${repoDir}`);
      process.exit(1);
    }
    pristineDir = repoDir;
  } else if (cloneArg) {
    const name = fixture?.name ?? basename(cloneArg).replace(/\.git$/, "");
    pristineDir = ensureClone(cloneArg, refArg, name);
    repoDir = pristineDir;
  } else if (fixture?.clone) {
    pristineDir = ensureClone(fixture.clone.url, fixture.clone.ref, fixture.name);
    repoDir = pristineDir;
  } else {
    repoDir = DEFAULT_REPO;
    pristineDir = repoDir;
    if (!existsSync(repoDir)) {
      console.error(`no repo to benchmark: ${repoDir} is empty.\n\nPut or clone any repo there, e.g.:\n  git clone https://github.com/fastlaunch/outbidlaunch.git tested-repo\n\nOr point at one directly:\n  --repo ./my-app\n  --clone <git-url>\n  --fixture ${Object.keys(FIXTURES).join(", ")}\n\n(run with no arguments for the full usage)`);
      process.exit(1);
    }
  }
  if (!fixture && !repoArg && !cloneArg) {
    console.error(`NOTE: benchmarking ${repoDir} without a fixture — metrics only (no fix-quality verify, no gates).\nFor the shipped outbidlaunch benchmark add --fixture outbidlaunch.\n`);
  }

  // ---- prompt resolution
  const explicitPrompts = process.argv
    .flatMap((a, i) => (a === "--prompt" && process.argv[i + 1] ? [process.argv[i + 1] as string] : []));
  const positional = process.argv.slice(2).filter((a, i, arr) => {
    const prev = i > 0 ? arr[i - 1] : "";
    return !a.startsWith("--") && !["--repo", "--clone", "--ref", "--fixture", "--prompt", "--prompts", "--arms", "--model", "--dir"].includes(prev) && !/^\d+$/.test(a);
  });
  const positionalPrompt = positional.join(" ").trim();
  const model = argValue("--model") ?? process.env.BENCH_MODEL ?? "openrouter/z-ai/glm-5.3-flash:low";
  const timeoutMs = Number(argValue("--timeout-ms") ?? "300000");

  type P = { key: string; text: string };
  let prompts: P[] = [];
  if (fixture) {
    const wanted = fixtureKeys ? fixtureKeys.split(",") : undefined;
    prompts = fixture.prompts.filter((p) => !wanted || wanted.includes(p.key));
  }
  if (explicitPrompts.length > 0) {
    prompts = [...prompts, ...explicitPrompts.map((t, i) => ({ key: `custom${prompts.length + i + 1}`, text: t }))];
  }
  if (positionalPrompt && explicitPrompts.length === 0) {
    prompts = [...prompts, { key: `custom${prompts.length + 1}`, text: positionalPrompt }];
  }
  if (prompts.length === 0) {
    console.error(`no prompts given.\n\nPaste one as a (quoted) argument:\n  npx tsx bench/run.ts "the 3d map is missing some countries, fix it"\n\nor pass --prompt "..." (repeatable), or use a fixture's shipped set:\n  npx tsx bench/run.ts --fixture outbidlaunch\n`);
    process.exit(1);
  }

  // ---- run loop
  const RUN_DIR = resolve(argValue("--dir") ?? ".bench-run");
  const runs = Number(argValue("--runs") ?? "3");
  const arms = (argValue("--arms") ?? "base,s0").split(",");
  const RECEIPTS_FILE = resolve(RUN_DIR, "decisionkit-receipts-run.jsonl");
  const verifyResult = (copyDir: string, editedFiles: string[]): VerifyResult =>
    fixture?.verify
      ? fixture.verify(copyDir, editedFiles, pristineDir)
      : { ok: true, required: "n/a (no fixture verify — metrics only)", discretionary: {}, constraint: "n/a" };

  mkdirSync(RUN_DIR, { recursive: true });
  // Artifact numbering continues across invocations (append mode).
  const existingRunNums = readdirSync(RUN_DIR)
    .map((f) => /^run(\d+)-/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m![1]));
  const runOffset = existingRunNums.length > 0 ? Math.max(...existingRunNums) : 0;

  for (let run = 1; run <= runs; run++) {
    const runNum = run + runOffset;
    console.log(`\n=== run ${runNum}/${runs + runOffset} (${basename(repoDir)}${fixture ? `, fixture ${fixture.name}` : ""}) ===`);
    // Interleaved: prompt × arm — both arms sample the same provider window.
    for (const prompt of prompts) {
      for (const arm of arms) {
        const copyDir = resolve(RUN_DIR, `run${runNum}-${arm}-${prompt.key}`);
        rmSync(copyDir, { recursive: true, force: true });
        cpSync(repoDir, copyDir, { recursive: true, filter: copyFilter });
        // Ship .env INTO each copy (providers read cwd/.env).
        const envSrc = resolve(WORKSPACE, ".env");
        if (existsSync(envSrc)) cpSync(envSrc, resolve(copyDir, ".env"));
        if (arm === "s0") {
          installDropin(copyDir);
          // Pack: the shipped pi-calibrated default inside decisionkit-core
          // loads automatically — no per-repo pack to copy.
        }
        console.log(`  [run ${runNum} | ${arm} | ${prompt.key}] "${prompt.text.slice(0, 60)}"`);
        const t0 = Date.now();
        let m = runPrompt(copyDir, prompt.key, prompt.text, arm, t0, RECEIPTS_FILE, timeoutMs, model);
        if (!m.executed) {
          console.log(`    DEAD (exit ${m.exitCode}, ${m.turns} turns) — retrying once …`);
          m = runPrompt(copyDir, prompt.key, prompt.text, arm, t0, RECEIPTS_FILE, timeoutMs, model);
          m.attempts = 2;
        }
        if (!m.executed) {
          console.error(`    PROMPT FAILED TWICE (${prompt.key}/${arm}) — aborting run ${runNum}`);
          writeFileSync(
            resolve(RUN_DIR, `run${runNum}-${arm}-${prompt.key}.json`),
            JSON.stringify({ run: runNum, arm, fixture: fixture?.name, promptKey: prompt.key, model, invalid: true, turns: m }, null, 2),
          );
          process.exit(1);
        }
        const v = verifyResult(copyDir, m.editedFiles);
        const artifact = {
          run: runNum,
          arm,
          fixture: fixture?.name,
          repo: basename(repoDir),
          promptKey: prompt.key,
          prompt: prompt.text,
          model,
          started: new Date(t0).toISOString(),
          metrics: m,
          verify: v,
          copyDir,
        };
        writeFileSync(resolve(RUN_DIR, `run${runNum}-${arm}-${prompt.key}.json`), JSON.stringify(artifact, null, 2));
        printResult(m, v, arm);
      }
    }
  }
  console.log("\ndone — aggregate with: npx tsx bench/report.ts");
}
