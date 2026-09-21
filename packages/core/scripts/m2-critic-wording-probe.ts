/**
 * Probe alternate critic question wordings on the contested cases.
 * Run: npx tsx --env-file=.env packages/core/scripts/m2-critic-wording-probe.ts
 */
import { TypeSafeClient, noul } from "@typesafe-ai/sdk";

const decisionkit = new TypeSafeClient();

const CASES = [
  { name: "module-not-found", expect: "intervene", state: { tool: "bash", input: "node src/index.ts", result: "Error: Cannot find module './helperx'", isError: true, task: "fix the failing import in src/index.ts" } },
  { name: "test-fail", expect: "intervene", state: { tool: "bash", input: "npm test", result: "FAIL src/parse.test.ts\n  ● parseConfig throws on missing key\n    expect(received).toThrow()\nTests: 2 failed, 12 passed, 14 total", isError: true, task: "make the test suite pass" } },
  { name: "typecheck-fail", expect: "intervene", state: { tool: "bash", input: "npx tsc --noEmit", result: "src/index.ts(12,3): error TS2304: Cannot find name 'expct'.", isError: true, task: "fix the type errors" } },
  { name: "empty-grep", expect: "intervene", state: { tool: "bash", input: "grep -rn 'handleSubmit' src/", result: "", isError: false, task: "rename handleSubmit to onSubmit and update its callers" } },
  { name: "wrong-file-read", expect: "intervene", state: { tool: "read", input: "README.md", result: "# MyProject\nA demo repository.\nnpm install\nnpm run dev", isError: false, task: "change the dev server port to 8080" } },
  { name: "grep-hit", expect: "ok", state: { tool: "bash", input: "grep -rn 'handleSubmit' src/", result: "src/app.ts:12:  handleSubmit(evt) {\nsrc/app.ts:41:  onClick={handleSubmit}", isError: false, task: "rename handleSubmit to onSubmit and update its callers" } },
  { name: "test-pass", expect: "ok", state: { tool: "bash", input: "npm test", result: "Tests: 14 passed, 14 total", isError: false, task: "make the test suite pass" } },
  { name: "edit-applied", expect: "ok", state: { tool: "edit", input: "src/config.ts", result: "Applied 1 edit to src/config.ts", isError: false, task: "change the dev server port to 8080" } },
];

const WORDINGS: Record<string, { worked: string; onTrack: string }> = {
  current: {
    worked: "Did this tool call do what the agent intended?",
    onTrack: "Is the task still on track?",
  },
  v2: {
    worked: "Did this tool call fail, error, or otherwise not accomplish the agent's intended action?",
    onTrack: "Given this result, does the agent need to change its approach to complete the task?",
  },
  v3: {
    worked: "Would a competent engineer consider this tool result a FAILURE that requires corrective action?",
    onTrack: "Does the remaining evidence show the task is blocked or proceeding incorrectly?",
  },
};

const RUNS = 2;
for (const [name, q] of Object.entries(WORDINGS)) {
  const rows = new Map<string, { expect: string; vals: number[] }>();
  for (const c of CASES) rows.set(c.name, { expect: c.expect, vals: [] });
  for (let r = 0; r < RUNS; r++) {
    for (const c of CASES) {
      try {
        const { answers } = await decisionkit.systemOne({
          state: c.state,
          questions: { worked: noul(q.worked), onTrack: noul(q.onTrack) },
        });
        const w = (answers.worked as { noul: number }).noul;
        const o = (answers.onTrack as { noul: number }).noul;
        rows.get(c.name)!.vals.push(Math.min(w, o));
      } catch (e) {
        console.log(`ERR ${c.name}: ${e}`);
      }
    }
  }
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`\n=== ${name} ===  (min(worked,onTrack) avg)`);
  const failVals: number[] = [];
  const okVals: number[] = [];
  for (const c of CASES) {
    const row = rows.get(c.name)!;
    const m = avg(row.vals);
    (c.expect === "intervene" ? failVals : okVals).push(m);
    console.log(`  ${c.name.padEnd(18)} ${m.toFixed(2)}  expect=${c.expect}`);
  }
  console.log(`  separation: fail-max ${Math.max(...failVals).toFixed(2)}  ok-min ${Math.min(...okVals).toFixed(2)}`);
}
