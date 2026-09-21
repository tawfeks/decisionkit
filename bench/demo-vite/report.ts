/**
 * Demo rig report — aggregates demo-run{N}-{arm}.json + decisionkit-receipts JSONL into the
 * honest two-arm summary: distributions over runs, routing accuracy vs the
 * labeled expectations, fail-opens, DecisionKit call stats. Measured numbers only.
 *
 * Run: npx tsx bench/demo-vite/report.ts [--dir .bench-demo] [--runs 3,4,5]
 *
 * --runs selects run numbers (default: all). Receipts are the appended
 * decisionkit-receipts-run.jsonl across ALL runs ever, so they are attributed to the
 * selected decisionkit runs by time window ([run.started - 5s, run end + 120s]) —
 * orphan receipts from deleted/other sessions are excluded automatically.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};

const RIG_DIR = resolve(argValue("--dir") ?? ".bench-demo");
const runFilter = argValue("--runs");
const wantedRuns = runFilter ? new Set(runFilter.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))) : undefined;

interface Turn {
  demo: string;
  wallMs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** reasoning tokens — separate from `output` in pi's Usage, billed as output */
  reasoningTokens?: number;
  /** cache tokens reported by the provider */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  exitCode: number;
  /** exit 0 AND (≥1 assistant turn OR a DecisionKit-routed turn); undefined in legacy run files */
  executed?: boolean;
  /** invocation attempts; 2 = one automatic retry in run.ts */
  attempts?: number;
  /** Tier-2 routing handled this prompt — 0 assistant turns by design */
  routedTurn?: boolean;
  decisionkitLatencyMs?: number;
  decisionkitCalls?: number;
}
interface RunFile {
  run: number;
  arm: string;
  model?: string;
  /** run aborted by run.ts after a prompt failed twice — exclude everything */
  invalid?: boolean;
  failedPrompt?: { index: number; demo: string; text: string };
  /** ISO end timestamp (interleaved runs: prompts span wall time beyond ΣwallMs) */
  ended?: string;
  prompts: Array<{ demo: string; text: string; expect?: string }>;
  turns: Turn[];
  receipts: number;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

const runFiles = readdirSync(RIG_DIR)
  .filter((f) => /^(?:demo|m3)-run\d+-\w+\.json$/.test(f) && !f.endsWith("-actions.json"))
  .filter((f) => wantedRuns === undefined || wantedRuns.has(Number(/^(?:demo|m3)-run(\d+)-/.exec(f)?.[1])));
if (wantedRuns && wantedRuns.size > 0) {
  const found = new Set(runFiles.map((f) => Number(/^(?:demo|m3)-run(\d+)-/.exec(f)?.[1])));
  const missing = [...wantedRuns].filter((n) => !found.has(n));
  if (missing.length > 0) {
    console.error(`--runs: no run file(s) for ${missing.join(", ")} in ${RIG_DIR}`);
    process.exit(2);
  }
}
const allRuns: RunFile[] = runFiles.map((f) => JSON.parse(readFileSync(resolve(RIG_DIR, f), "utf8")));
if (allRuns.length === 0) {
  console.error("no demo-run-*.json found — run run.ts first");
  process.exit(1);
}

// Invalid runs (prompt failed twice in run.ts) are excluded from EVERYTHING —
// metrics, verify aggregation, cost. Report them loudly instead.
const runs = allRuns.filter((r) => !r.invalid);
const invalidRuns = allRuns.filter((r) => r.invalid);
if (invalidRuns.length > 0) {
  console.log(
    `EXCLUDED ${invalidRuns.length} invalid run(s) (prompt failed twice in run.ts): ${invalidRuns.map((r) => `run${r.run}/${r.arm} [${r.failedPrompt?.demo}] "${r.failedPrompt?.text.slice(0, 40)}"`).join("; ")}`,
  );
  console.log("");
}

// Actions (tool calls + file edits) per arm, from demo-run{N}-{arm}-actions.json.
const actionFiles = readdirSync(RIG_DIR).filter((f) => /^(?:demo|m3)-run\d+-\w+-actions\.json$/.test(f))
  .filter((f) => wantedRuns === undefined || wantedRuns.has(Number(/^(?:demo|m3)-run(\d+)-/.exec(f)?.[1])));
const actionsByArm = new Map<string, { toolCalls: Record<string, number>; editedFiles: string[] }>();
for (const f of actionFiles) {
  const a = JSON.parse(readFileSync(resolve(RIG_DIR, f), "utf8")) as { arm: string; toolCalls: Record<string, number>; editedFiles: string[] };
  const agg = actionsByArm.get(a.arm) ?? { toolCalls: {}, editedFiles: [] };
  for (const [k, v] of Object.entries(a.toolCalls)) agg.toolCalls[k] = (agg.toolCalls[k] ?? 0) + v;
  agg.editedFiles = [...new Set([...agg.editedFiles, ...a.editedFiles])];
  actionsByArm.set(a.arm, agg);
}

// Task-success verification per arm (deterministic checks from run.ts), linked
// back to its run so entries from invalid (aborted) runs are excluded — a
// verify written for a run whose prompts didn't all execute proves nothing.
const verifyFiles = readdirSync(RIG_DIR).filter((f) => /^(?:demo|m3)-run\d+-\w+-verify\.json$/.test(f))
  .filter((f) => wantedRuns === undefined || wantedRuns.has(Number(/^(?:demo|m3)-run(\d+)-/.exec(f)?.[1])));
const invalidRunKeys = new Set(invalidRuns.map((r) => `run${r.run}-${r.arm}`));
const verifyByArm = new Map<string, Array<{ run: number; demo: string; ok: boolean; detail: string }>>();
for (const f of verifyFiles) {
  const v = JSON.parse(readFileSync(resolve(RIG_DIR, f), "utf8")) as {
    run: number;
    arm: string;
    verify: Array<{ demo: string; ok: boolean; detail: string }>;
  };
  if (invalidRunKeys.has(`run${v.run}-${v.arm}`)) continue;
  verifyByArm.set(v.arm, [
    ...(verifyByArm.get(v.arm) ?? []),
    ...v.verify.map((x) => ({ run: v.run, ...x })),
  ]);
}

// Receipts (decisionkit arm): tier decisions, fail-opens, routing accuracy. The
// receipts JSONL is APPENDED across every run ever executed, so lines are
// attributed to the SELECTED decisionkit runs by time window — orphan lines from
// other/deleted sessions never blend into the metrics.
const rawReceiptLines: Array<Record<string, unknown>> = [];
let orphanReceiptLines = 0;
try {
  rawReceiptLines.push(
    ...readFileSync(resolve(RIG_DIR, "decisionkit-receipts-run.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
} catch {
  /* no receipts */
}
// Window per selected decisionkit run: [started - 5s, ended + 120s] (ended from the
// run file when present — interleaved arms prompt alternately, so ΣwallMs
// underestimates the real span; legacy files fall back to started + Σwall).
const receiptWindows = runs
  .filter((r) => r.arm === "decisionkit")
  .map((r) => {
    const start = Date.parse(r.started);
    const end = r.ended !== undefined && Number.isFinite(Date.parse(r.ended))
      ? Date.parse(r.ended)
      : start + r.turns.reduce((a, t) => a + t.wallMs, 0);
    return [start - 5_000, end + 120_000] as const;
  });
const inWindow = (line: Record<string, unknown>): boolean => {
  const ts = Date.parse(String(line.ts ?? ""));
  if (!Number.isFinite(ts)) return false;
  return receiptWindows.some(([lo, hi]) => ts >= lo && ts <= hi);
};
const receiptLines = receiptWindows.length > 0 ? rawReceiptLines.filter(inWindow) : [];
orphanReceiptLines = rawReceiptLines.length - receiptLines.length;
const byTier = new Map<string, number>();
let failOpen = 0;
let routed = 0;
let routingTotal = 0;
const latencies: number[] = [];
for (const r of receiptLines) {
  const tier = String(r.tier ?? "?");
  byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
  if (r.failOpen === true) failOpen++;
  if (r.ok && typeof r.latencyMs === "number") latencies.push(r.latencyMs);
  if (tier === "routing") {
    routingTotal++;
    if (String(r.decision ?? "").startsWith("route(")) routed++;
  }
}

// Routing ACCURACY vs the labeled expectations in prompts.ts (run-file data) —
// natural-phrasing passthroughs are correct behavior, not misses, so the
// honest gate is label accuracy, not routed/total. Unlabeled prompts (legacy
// run files) are excluded from accuracy and reported separately.
let routeCorrect = 0;
let routeLabeled = 0;
let routeUnlabeled = 0;
for (const r of runs.filter((x) => x.arm === "decisionkit")) {
  r.turns.forEach((t, i) => {
    const expect = r.prompts[i]?.expect;
    if (expect !== "route" && expect !== "passthrough") {
      routeUnlabeled++;
      return;
    }
    routeLabeled++;
    if (t.routedTurn === true === (expect === "route")) routeCorrect++;
  });
}

const arms = [...new Set(runs.map((r) => r.arm))];
console.log(`Demo rig report — ${runs.length} runs, arms: ${arms.join(", ")}, model: ${runs[0]?.model ?? "(default)"}`);
console.log("");
for (const arm of arms) {
  const armRuns = runs.filter((r) => r.arm === arm);
  const turnsPerRun = armRuns.map((r) => r.turns.reduce((a, t) => a + t.turns, 0));
  const inTokPerRun = armRuns.map((r) => r.turns.reduce((a, t) => a + t.inputTokens, 0));
  const reasoningPerRun = armRuns.map((r) => r.turns.reduce((a, t) => a + (t.reasoningTokens ?? 0), 0));
  const cacheReadPerRun = armRuns.map((r) => r.turns.reduce((a, t) => a + (t.cacheReadTokens ?? 0), 0));
  const cacheWritePerRun = armRuns.map((r) => r.turns.reduce((a, t) => a + (t.cacheWriteTokens ?? 0), 0));
  const cacheNote =
    cacheReadPerRun.some((x) => x > 0) || cacheWritePerRun.some((x) => x > 0)
      ? ` | cache/run p50 read ${median(cacheReadPerRun)} + write ${median(cacheWritePerRun)} tok`
      : " | cache: none";
  console.log(
    `arm ${arm}: turns/run p50 ${median(turnsPerRun)} (min ${Math.min(...turnsPerRun)}, max ${Math.max(...turnsPerRun)}) | in-tok/run p50 ${median(inTokPerRun)} | reasoning/run p50 ${median(reasoningPerRun)}${cacheNote}`,
  );
  for (const demo of ["A", "B", "C", "D"]) {
    const t = armRuns.flatMap((r) => r.turns.filter((x) => x.demo === demo));
    if (t.length === 0) continue;
    const promptsForDemo = armRuns[0]?.prompts.filter((p) => p.demo === demo).length ?? 0;
    const decisionkitLat = t.map((x) => x.decisionkitLatencyMs ?? 0);
    const llmLat = t.map((x) => Math.max(x.wallMs - (x.decisionkitLatencyMs ?? 0), 0));
    const wallMin = Math.min(...t.map((x) => x.wallMs));
    const wallMax = Math.max(...t.map((x) => x.wallMs));
    // Small n: p50 alone hides the outlier that dominates the story (measured:
    // a 28s prompt next to three ~2s ones), so ranges are always shown.
    console.log(
      `  demo ${demo}: turns p50 ${median(t.map((x) => x.turns))} / prompt (range ${Math.min(...t.map((x) => x.turns))}–${Math.max(...t.map((x) => x.turns))}, n=${t.length}, ${promptsForDemo}/run), in-tok p50 ${median(t.map((x) => x.inputTokens))}, out p50 ${median(t.map((x) => x.outputTokens))}, reasoning p50 ${median(t.map((x) => x.reasoningTokens ?? 0))}, wall p50 ${median(t.map((x) => x.wallMs))}ms (range ${wallMin}–${wallMax}ms)`,
    );
    console.log(
      `    latency split p50: total ${median(t.map((x) => x.wallMs))}ms = llm≈${median(llmLat)}ms + decisionkit ${median(decisionkitLat)}ms`,
    );
  }
  const acts = actionsByArm.get(arm);
  if (acts) {
    const tools = Object.entries(acts.toolCalls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(", ");
    console.log(`  tool calls (all runs): ${tools || "none"}`);
    console.log(`  files changed (${acts.editedFiles.length}): ${acts.editedFiles.join(", ") || "none"}`);
  }
  const ver = verifyByArm.get(arm);
  if (ver && ver.length > 0) {
    const pass = ver.filter((v) => v.ok).length;
    for (const demo of ["B", "C", "D"]) {
      const vs = ver.filter((v) => v.demo === demo);
      if (vs.length === 0) continue;
      const p = vs.filter((v) => v.ok).length;
      console.log(`  verify ${demo}: ${p}/${vs.length} runs pass — ${vs[vs.length - 1].detail}`);
    }
    console.log(`  task success: ${pass}/${ver.length} checks pass`);
  }
  // Prompt-level execution honesty: retries are auto-healed dead invocations
  // (counted, not hidden); legacy run files predate the executed flag.
  const retries = armRuns.reduce((a, r) => a + r.turns.filter((t) => (t.attempts ?? 1) > 1).length, 0);
  const routedTurns = armRuns.reduce((a, r) => a + r.turns.filter((t) => t.routedTurn === true).length, 0);
  const legacy = armRuns.some((r) => r.turns.some((t) => t.executed === undefined));
  if (routedTurns > 0) console.log(`  routed turns (LLM skipped by Tier 2): ${routedTurns}`);
  if (retries > 0) console.log(`  prompt retries (dead invocation, healed): ${retries}`);
  if (legacy) console.log(`  note: legacy run file(s) predate the executed flag — re-run for per-prompt execution data`);
}
console.log("");
console.log(`decisionkit receipts: ${receiptLines.length} total, by tier: ${[...byTier].map(([k, v]) => `${k}=${v}`).join(", ")}`);
if (orphanReceiptLines > 0) {
  console.log(`  (excluded ${orphanReceiptLines} receipt line(s) outside the selected decisionkit runs' time windows)`);
}
if (routeLabeled > 0) {
  const pct = ((routeCorrect / routeLabeled) * 100).toFixed(0);
  console.log(`routing accuracy (vs labeled expect): ${routeCorrect}/${routeLabeled} = ${pct}% — passthrough on natural phrasing is CORRECT, not a miss`);
  if (routeUnlabeled > 0) console.log(`  (${routeUnlabeled} unlabeled prompt(s) excluded from accuracy)`);
}
console.log(`routed turns (LLM deleted by Tier 2): ${routed}/${routingTotal} prompts = ${routingTotal > 0 ? ((routed / routingTotal) * 100).toFixed(0) : 0}% of the mixed-phrasing set`);
console.log(`fail-opens: ${failOpen}/${receiptLines.length || 1}`);
if (latencies.length > 0) {
  console.log(`decisionkit latency p50 ${median(latencies)}ms, max ${Math.max(...latencies)}ms`);
}

// Cost split. Frontier prices default to the glm-5.3-flash rates used in the demo rig
// ($10/Mtok in, $50/Mtok out) — override via DEMO_FRONTIER_IN_PRICE /
// DEMO_FRONTIER_OUT_PRICE (USD per Mtok) for other models. Reasoning tokens are
// billed at the OUTPUT rate on every major provider, counted as output spend
// but reported as their own metric. Cache: default read = 10% of input price,
// write = 125% of input price (OpenAI/Anthropic conventions) — override via
// DEMO_FRONTIER_CACHE_READ_PRICE / DEMO_FRONTIER_CACHE_WRITE_PRICE. DecisionKit is $42/Btok
// input (= $0.042/Mtok); DecisionKit output tokens are free (docs.typesafe.ai, plan §1).
const FRONTIER_IN_PRICE = Number(process.env.DEMO_FRONTIER_IN_PRICE ?? 10); // USD/Mtok
const FRONTIER_OUT_PRICE = Number(process.env.DEMO_FRONTIER_OUT_PRICE ?? 50); // USD/Mtok
const FRONTIER_CACHE_READ_PRICE = Number(process.env.DEMO_FRONTIER_CACHE_READ_PRICE ?? FRONTIER_IN_PRICE * 0.1);
const FRONTIER_CACHE_WRITE_PRICE = Number(process.env.DEMO_FRONTIER_CACHE_WRITE_PRICE ?? FRONTIER_IN_PRICE * 1.25);
const DECISIONKIT_IN_PRICE = 0.042; // USD/Mtok; output free
const fmtUsd = (usd: number): string => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`);
const perM = (tok: number): number => tok / 1_000_000;

console.log("");
console.log(
  `prices: frontier $${FRONTIER_IN_PRICE}/M in, $${FRONTIER_OUT_PRICE}/M out (reasoning billed as out), cache read $${FRONTIER_CACHE_READ_PRICE}/M, cache write $${FRONTIER_CACHE_WRITE_PRICE}/M | decisionkit $${DECISIONKIT_IN_PRICE}/M in, out free`,
);
for (const arm of arms) {
  const armRuns = runs.filter((r) => r.arm === arm);
  const inTok = armRuns.reduce((a, r) => a + r.turns.reduce((s, t) => s + t.inputTokens, 0), 0);
  const outTok = armRuns.reduce((a, r) => a + r.turns.reduce((s, t) => s + t.outputTokens, 0), 0);
  const reasoningTok = armRuns.reduce((a, r) => a + r.turns.reduce((s, t) => s + (t.reasoningTokens ?? 0), 0), 0);
  const cacheReadTok = armRuns.reduce((a, r) => a + r.turns.reduce((s, t) => s + (t.cacheReadTokens ?? 0), 0), 0);
  const cacheWriteTok = armRuns.reduce((a, r) => a + r.turns.reduce((s, t) => s + (t.cacheWriteTokens ?? 0), 0), 0);
  // pi's `input` already EXCLUDES cache tokens (openai-completions.ts:
  // input = promptTokens - cacheRead - cacheWrite), so cache is billed on top.
  const usd =
    perM(inTok) * FRONTIER_IN_PRICE +
    perM(cacheReadTok) * FRONTIER_CACHE_READ_PRICE +
    perM(cacheWriteTok) * FRONTIER_CACHE_WRITE_PRICE +
    perM(outTok + reasoningTok) * FRONTIER_OUT_PRICE;
  const promptTotal = inTok + cacheReadTok + cacheWriteTok;
  const cacheReadPct = promptTotal > 0 ? ((cacheReadTok / promptTotal) * 100).toFixed(1) : "0.0";
  const cacheWritePct = promptTotal > 0 ? ((cacheWriteTok / promptTotal) * 100).toFixed(1) : "0.0";
  const reasoningPct = outTok + reasoningTok > 0 ? ((reasoningTok / (outTok + reasoningTok)) * 100).toFixed(1) : "0.0";
  console.log(
    `arm ${arm}: frontier in ${inTok} tok (cache read ${cacheReadTok} tok = ${cacheReadPct}% of prompt, cache write ${cacheWriteTok} tok = ${cacheWritePct}%), out ${outTok} tok + reasoning ${reasoningTok} tok (${reasoningPct}% of billed output) over ${armRuns.length} run(s) → ${fmtUsd(usd)}`,
  );
}
const decisionkitInTok = receiptLines.reduce((a, r) => a + (typeof r.inputTokens === "number" ? r.inputTokens : 0), 0);
const decisionkitUsd = perM(decisionkitInTok) * DECISIONKIT_IN_PRICE;
console.log(`decisionkit (System 1): ${decisionkitInTok} in-tok over ${receiptLines.length} calls, out free → ${fmtUsd(decisionkitUsd)} (at $${DECISIONKIT_IN_PRICE}/Mtok input)`);
console.log(`note: decisionkit-arm frontier spend = its arm line above (routed turns contribute 0 frontier tokens); total decisionkit arm = frontier + decisionkit line`);
