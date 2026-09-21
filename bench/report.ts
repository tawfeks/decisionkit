/**
 * Bench report — aggregates .bench-run/run{N}-{arm}-{key}.json artifacts into
 * per prompt-class per arm distributions: frontier turns, ↑ input tokens,
 * wall, s0 calls/ms, digest injection, wasted rate, fail-open rate, and (for
 * fixtures with a verify) fix quality + gate verdicts.
 *
 * Run: npx tsx bench/report.ts [--dir .bench-run]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { outbidlaunch } from "./fixtures/outbidlaunch.js";

const argValue = (name: string, def: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const RUN_DIR = resolve(argValue("--dir", ".bench-run"));

interface Metrics {
  promptKey: string;
  wallMs: number;
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
  attempts: number;
}
interface Artifact {
  run: number;
  arm: string;
  fixture?: string;
  promptKey: string;
  model?: string;
  invalid?: boolean;
  metrics: Metrics;
  verify: { ok: boolean; required: string; discretionary: Record<string, unknown>; constraint: string };
  copyDir: string;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const rng = (xs: number[]): string => (xs.length === 0 ? "n/a" : `${Math.min(...xs)}–${Math.max(...xs)}`);

if (!existsSync(RUN_DIR)) {
  console.error(`no such dir: ${RUN_DIR} — run bench/run.ts first`);
  process.exit(1);
}
const files = readdirSync(RUN_DIR)
  .filter((f) => (/^run\d+-\w+-[\w-]+\.json$/.test(f) || /^s0-run\d+-\w+-p[A-C]\.json$/.test(f)));
if (files.length === 0) {
  console.error(`no run*.json artifacts in ${RUN_DIR} — run bench/run.ts first`);
  process.exit(1);
}
const all: Artifact[] = files
  .map((f) => JSON.parse(readFileSync(resolve(RUN_DIR, f), "utf8")) as Artifact)
  .sort((a, b) => a.run - b.run || a.promptKey.localeCompare(b.promptKey));
const runs = all.filter((a) => !a.invalid);
const invalid = all.filter((a) => a.invalid === true);
const model = runs[0]?.model ?? "(default)";
const arms = [...new Set(runs.map((r) => r.arm))];
const promptKeys = [...new Set(runs.map((r) => r.promptKey))].sort();

console.log(`bench report — ${runs.length} runs (runs ${[...new Set(runs.map((r) => r.run))].join(",")}), arms: ${arms.join(", ")}, prompts: ${promptKeys.join(",")}, model: ${model}`);
if (invalid.length > 0) {
  console.log(`EXCLUDED ${invalid.length} invalid artifact(s) (prompt failed twice): ${invalid.map((i) => `run${i.run}/${i.arm}/${i.promptKey}`).join(", ")}`);
}
console.log("");

for (const promptKey of promptKeys) {
  for (const arm of arms) {
    const rs = runs.filter((r) => r.promptKey === promptKey && r.arm === arm);
    if (rs.length === 0) continue;
    const turns = rs.map((r) => r.metrics.turns);
    const inTok = rs.map((r) => r.metrics.inputTokens);
    const maxIn = rs.map((r) => r.metrics.maxInputTokens);
    const out = rs.map((r) => r.metrics.outputTokens + r.metrics.reasoningTokens);
    const wall = rs.map((r) => r.metrics.wallMs);
    const hasVerify = !rs.every((r) => r.verify.required.startsWith("n/a"));
    const verifyOk = hasVerify ? rs.filter((r) => r.verify.ok).length : undefined;
    const line = [
      `${promptKey} [${arm}] n=${rs.length}:`,
      `turns p50 ${median(turns)} (range ${rng(turns)})`,
      `↑p50 ${median(inTok)} total input (range ${rng(inTok)}; biggest single turn p50 ${median(maxIn)})`,
      `↓p50 ${median(out)} (out+reasoning)`,
      `wall p50 ${median(wall)}ms (range ${rng(wall)})`,
      verifyOk !== undefined ? `verify ${verifyOk}/${rs.length}` : `verify n/a (no fixture)`,
    ].join(" | ");
    console.log(line);
    if (arm === "s0") {
      const s0calls = rs.map((r) => r.metrics.s0JevCalls);
      const s0ms = rs.map((r) => r.metrics.s0LatencyMs);
      const wasted = rs.map((r) => r.metrics.s0Wasted);
      const failOpens = rs.map((r) => r.metrics.s0FailOpens);
      const digests = rs.filter((r) => r.metrics.digestInjected).length;
      const noDigest = rs.filter((r) => !r.metrics.digestInjected && r.metrics.digestNote !== "").map((r) => `run${r.run}: ${r.metrics.digestNote}`);
      console.log(
        `    s0: jev p50 ${median(s0calls)} (range ${rng(s0calls)}), lat p50 ${median(s0ms)}ms, digest ${digests}/${rs.length} (chars p50 ${median(rs.map((r) => r.metrics.digestChars))}), wasted Σ ${wasted.reduce((a, b) => a + Math.max(b, 0), 0)} (per-run ${rng(wasted.map((w) => Math.max(w, 0)))}), fail-opens ${failOpens.reduce((a, b) => a + b, 0)}${noDigest.length > 0 ? `\n    no-digest: ${noDigest.join("; ")}` : ""}`,
      );
    }
    // Per-run detail line (small n — show every run).
    for (const r of rs) {
      const tools = Object.entries(r.metrics.toolCalls).map(([k, c]) => `${k}×${c}`).join("+") || "none";
      console.log(`      run${r.run}: ${r.metrics.turns}t ↑${r.metrics.inputTokens} input (biggest turn ${r.metrics.maxInputTokens}) ${r.metrics.wallMs}ms verify=${r.verify.required.startsWith("n/a") ? "n/a" : r.verify.ok ? "pass" : "FAIL"} (${r.verify.required})${arm === "s0" ? ` s0=${r.metrics.s0JevCalls}c/${r.metrics.s0LatencyMs}ms wasted=${r.metrics.s0Wasted}${r.metrics.digestNote ? ` [${r.metrics.digestNote}]` : ""}` : ""} tools ${tools}`);
      if (r.verify.constraint !== "n/a") console.log(`        constraint: ${r.verify.constraint}`);
      const disc = Object.entries(r.verify.discretionary).map(([k, v]) => `${k}=${String(v)}`).join(", ");
      if (disc) console.log(`        discretionary: ${disc}`);
    }
  }
}
console.log("");

// ------------------------------------------------------------------- gates ----
const fixtureName = runs.find((r) => r.fixture !== undefined)?.fixture;
if (fixtureName === "outbidlaunch" && outbidlaunch.gates) {
  outbidlaunch.gates(runs.map((r) => ({ run: r.run, arm: r.arm, metrics: r.metrics, verify: r.verify })));
} else if (fixtureName) {
  console.log(`fixture "${fixtureName}" defines no gates`);
} else {
  console.log("no fixture on these artifacts — gate verdicts need a --fixture run");
}
