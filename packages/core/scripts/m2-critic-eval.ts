/**
 * M2 critic calibration — probes realistic tool-result shapes with ground truth,
 * measures the worked/onTrack noul distributions, and checks current thresholds.
 *
 * Run: npx tsx --env-file=.env packages/core/scripts/m2-critic-eval.ts
 *
 * Ground truth: `intervene` = the agent should be told the call did not do what
 * was intended (failure, wrong file, silent no-op). `ok` = result is fine (or a
 * benign error the agent already sees clearly and need not be nagged about —
 * recorded but not scored against, flagged in the verdict).
 *
 * Findings are printed as a table + suggested threshold; edit DEFAULT_THRESHOLDS
 * in packages/core/src/types.ts only after eyeballing the distributions.
 */
import { InMemoryLedger, DecisionKitCore } from "decisionkit-core";

type Case = {
  name: string;
  expect: "intervene" | "ok";
  tool: string;
  toolInput: unknown;
  resultPreview: string;
  isError: boolean;
  taskContext: string;
};

const CASES: Case[] = [
  // --- should intervene ---
  {
    name: "module-not-found",
    expect: "intervene",
    tool: "bash",
    toolInput: { command: "node src/index.ts" },
    resultPreview: "Error: Cannot find module './helperx'",
    isError: true,
    taskContext: "fix the failing import in src/index.ts",
  },
  {
    name: "test-fail",
    expect: "intervene",
    tool: "bash",
    toolInput: { command: "npm test" },
    resultPreview:
      "FAIL src/parse.test.ts\n  ● parseConfig throws on missing key\n    expect(received).toThrow()\n    Received function did not throw\nTests: 2 failed, 12 passed, 14 total",
    isError: true,
    taskContext: "make the test suite pass",
  },
  {
    name: "typecheck-fail",
    expect: "intervene",
    tool: "bash",
    toolInput: { command: "npx tsc --noEmit" },
    resultPreview: "src/index.ts(12,3): error TS2304: Cannot find name 'expct'.",
    isError: true,
    taskContext: "fix the type errors",
  },
  {
    name: "edit-miss",
    expect: "intervene",
    tool: "edit",
    toolInput: { path: "src/config.ts", oldText: "port: 3000" },
    resultPreview: "String to replace not found in file. No changes were made.",
    isError: true,
    taskContext: "change the dev server port to 8080",
  },
  {
    name: "empty-grep",
    expect: "intervene",
    tool: "bash",
    toolInput: { command: "grep -rn 'handleSubmit' src/" },
    resultPreview: "",
    isError: false,
    taskContext: "rename handleSubmit to onSubmit and update its callers",
  },
  {
    name: "wrong-file-read",
    expect: "intervene",
    tool: "read",
    toolInput: { path: "README.md" },
    resultPreview: "# MyProject\nA demo repository.\n## Setup\nnpm install\nnpm run dev",
    isError: false,
    taskContext: "change the dev server port to 8080",
  },
  // --- should be ok ---
  {
    name: "test-pass",
    expect: "ok",
    tool: "bash",
    toolInput: { command: "npm test" },
    resultPreview: "Tests: 14 passed, 14 total\nSnapshots: 0 total\nTime: 2.3s",
    isError: false,
    taskContext: "make the test suite pass",
  },
  {
    name: "build-success",
    expect: "ok",
    tool: "bash",
    toolInput: { command: "npm run build" },
    resultPreview: "> esbuild src/index.ts --bundle --outfile=dist/index.js\n  dist/index.js  14.2kb\nDone in 0.6s",
    isError: false,
    taskContext: "build the package",
  },
  {
    name: "grep-hit",
    expect: "ok",
    tool: "bash",
    toolInput: { command: "grep -rn 'handleSubmit' src/" },
    resultPreview: "src/app.ts:12:  handleSubmit(evt) {\nsrc/app.ts:41:  onClick={handleSubmit}",
    isError: false,
    taskContext: "rename handleSubmit to onSubmit and update its callers",
  },
  {
    name: "edit-applied",
    expect: "ok",
    tool: "edit",
    toolInput: { path: "src/config.ts", oldText: "port: 3000", newText: "port: 8080" },
    resultPreview: "Applied 1 edit to src/config.ts",
    isError: false,
    taskContext: "change the dev server port to 8080",
  },
];

const RUNS = Number(process.env.CRITIC_RUNS ?? 3);
const ledger = new InMemoryLedger();
const decisionkit = new DecisionKitCore({ enabled: true, model: "jev-1.13.0", timeoutMs: 10000 }, ledger);

type Row = { name: string; expect: string; worked: number[]; onTrack: number[] };
const rows = new Map<string, Row>();
for (const c of CASES) rows.set(c.name, { name: c.name, expect: c.expect, worked: [], onTrack: [] });

for (let r = 0; r < RUNS; r++) {
  for (const c of CASES) {
    const d = await decisionkit.critic({
      tool: c.tool,
      toolInput: c.toolInput,
      resultPreview: c.resultPreview,
      isError: c.isError,
      taskContext: c.taskContext,
    });
    const row = rows.get(c.name)!;
    row.worked.push((d.receipt.detail as { failed?: number } | undefined)?.failed ?? NaN);
    row.onTrack.push((d.receipt.detail as { failed?: number } | undefined)?.failed ?? NaN);
  }
}

const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const lo = (a: number[]) => Math.min(...a);
console.log("\ncase                 expect      worked(avg/min)  onTrack(avg/min)");
for (const row of rows.values()) {
  console.log(
    `${row.name.padEnd(20)} ${row.expect.padEnd(11)} ${avg(row.worked).toFixed(2)}/${lo(row.worked).toFixed(2).padEnd(11)} ${avg(row.onTrack).toFixed(2)}/${lo(row.onTrack).toFixed(2)}`,
  );
}

// Suggest thresholds: max over intervene-cases of min(worked,onTrack) gives the
// ceiling; min over ok-cases of min(worked,onTrack) gives the floor.
const failScores = CASES.filter((c) => c.expect === "intervene").map(
  (c) => Math.min(...rows.get(c.name)!.worked),
);
const okScores = CASES.filter((c) => c.expect === "ok").map((c) => Math.max(...rows.get(c.name)!.worked));
const ceiling = Math.min(...failScores);
const floor = Math.max(...okScores);
console.log(`\nsuggested: intervene iff failed > ${((ceiling + floor) / 2).toFixed(2)}  (fail-min ${ceiling.toFixed(2)}, ok-max ${floor.toFixed(2)})`);
console.log(`current threshold: criticFailed=${"0.25"}`);
console.log("\nnote: detail field is { failed } since the 2026-09-17 recalc (inverted wording).\n");
