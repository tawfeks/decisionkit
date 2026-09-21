/**
 * Two-question critic probe — decomposes the single `failed` judgment into:
 *   error  — "does the result itself show an error / non-zero exit?"
 *   empty  — "is the result empty or missing (nothing usable)?"
 *
 * Why: the single anchored `failed` wording conflates two judgments. The M3
 * run-5 A0 false-fire was a COMPOUND command (`cat package.json; grep …
 * vite.config.*`) where the cat half succeeded (package.json shown) and the
 * grep half legitimately found nothing — `failed` scored 0.86 and the note
 * sent the agent into 3 extra exploration turns. Orthogonal questions let the
 * policy intervene on `error` OR (`failed` AND `empty`) — the compound case
 * has content and no visible error, so it passes, while empty-grep still fires.
 *
 * Cases: the M2/M3 critic spectrum + the run-5 rig captures (compound cat;grep,
 * fd-not-found, ls-leftovers). `m3-rolldown-typecheck` is measured but
 * ADVISORY (genuinely ambiguous ground truth, excluded like wrong-file-read).
 *
 * Run: npx tsx --env-file=.env packages/core/scripts/m4-critic-twoq-probe.ts
 */
import { TypeSafeClient, noul } from "@typesafe-ai/sdk";

const decisionkit = new TypeSafeClient();

const W_FAILED =
  "Did this tool call fail, error, or otherwise not accomplish what it was invoked to do? Answer yes only if the result itself shows an error, an empty/missing outcome, or incomplete execution — not merely because the output is unremarkable.";
const W_ERROR =
  "Does the result itself show an error, a non-zero exit code, or an explicit failure message? Answer yes only if the failure is visible in the result text — not because the content is unhelpful, unremarkable, or unrelated to the broader task.";
const W_EMPTY =
  "Is this result empty or missing — no content, no confirmation, and no output of any kind? Answer yes only if there is literally nothing usable in the result text.";

const PKG_JSON = `{
  "name": "@vitejs/vite-monorepo",
  "private": true,
  "type": "module",
  "engines": { "node": "^20.19.0 || >=22.12.0" },
  "homepage": "https://vite.dev/",
  "repository": { "type": "git", "url": "git+https://github.com/vitejs/vite.git" },
  "scripts": { "dev": "pnpm --filter='./packages/vite' run dev" }
}`;

// Run-5 A0 capture: compound cat (succeeded, output below) + grep (no match at
// monorepo root — legitimate empty, stderr suppressed). Current `failed` wording
// scored 0.86 live on this and the note caused 3 wasted exploration turns.
const COMPOUND_CATGREP_RESULT = PKG_JSON;

const LS_LEFTOVERS =
  "-rw-r--r-- 1 dev staff 53 Sep 18 03:33 leftover-temp-copy-a.txt\n-rw-r--r-- 1 dev staff 53 Sep 18 03:33 leftover-temp-copy-b.txt\nleftover-temp-copy-a.txt: ASCII text\nleftover-temp-copy-b.txt: ASCII text";

type Expect = "intervene" | "ok" | "advisory-ok";

const CASES: Array<{
  name: string;
  expect: Expect;
  state: { tool: string; input: string; result: string; isError: boolean; task: string };
}> = [
  // ── true catches ──────────────────────────────────────────────────────────
  { name: "module-not-found   ", expect: "intervene", state: { tool: "bash", input: "node src/index.ts", result: "Error: Cannot find module './helperx'", isError: true, task: "fix the failing import in src/index.ts" } },
  { name: "test-fail          ", expect: "intervene", state: { tool: "bash", input: "npm test", result: "FAIL src/parse.test.ts\nTests: 2 failed, 12 passed, 14 total", isError: true, task: "make the test suite pass" } },
  { name: "typecheck-fail     ", expect: "intervene", state: { tool: "bash", input: "npx tsc --noEmit", result: "src/index.ts(12,3): error TS2304: Cannot find name 'expct'.", isError: true, task: "fix the type errors" } },
  { name: "edit-miss          ", expect: "intervene", state: { tool: "edit", input: "src/config.ts", result: "String to replace not found in file. No changes were made.", isError: true, task: "change the dev server port to 8080" } },
  { name: "empty-grep         ", expect: "intervene", state: { tool: "bash", input: "grep -rn 'handleSubmit' src/", result: "", isError: false, task: "rename handleSubmit to onSubmit and update its callers" } },
  { name: "m3-cat-dist-exit1  ", expect: "intervene", state: { tool: "bash", input: "cat packages/vite/dist/index.js", result: "// rig-generated placeholder build artifact (Demo B target)\n\nCommand exited with code 1", isError: false, task: "clean up the build artifacts in this project" } },
  { name: "m3-du-exit1        ", expect: "intervene", state: { tool: "bash", input: "du -ah packages/vite/dist", result: "4.0K\tpackages/vite/dist\nindex.js\n\nCommand exited with code 1", isError: false, task: "clean up the build artifacts in this project" } },
  { name: "m3-fd-notfound     ", expect: "intervene", state: { tool: "bash", input: "fd -t d -H '^(dist|dist-ssr)$'", result: "/bin/bash: fd: command not found\n\nCommand exited with code 1", isError: false, task: "clean up the build artifacts in this project" } },
  // ── oks, including every false-fire mode measured on the rigs ────────────
  { name: "test-pass          ", expect: "ok", state: { tool: "bash", input: "npm test", result: "Tests: 14 passed, 14 total\nSnapshots: 0 total\nTime: 2.3s", isError: false, task: "make the test suite pass" } },
  { name: "grep-hit           ", expect: "ok", state: { tool: "bash", input: "grep -rn 'handleSubmit' src/", result: "src/app.ts:12:  handleSubmit(evt) {\nsrc/app.ts:41:  onClick={handleSubmit}", isError: false, task: "rename handleSubmit to onSubmit and update its callers" } },
  { name: "edit-applied       ", expect: "ok", state: { tool: "edit", input: "src/config.ts", result: "Applied 1 edit to src/config.ts", isError: false, task: "change the dev server port to 8080" } },
  { name: "m3-cat-package     ", expect: "ok", state: { tool: "bash", input: "cat package.json", result: PKG_JSON, isError: false, task: "clean up the build artifacts in this project" } },
  { name: "m3-ls-root         ", expect: "ok", state: { tool: "bash", input: "ls", result: "CONTRIBUTING.md\nLICENSE\nREADME.md\ndocs\npackage.json\npackages\nplayground\nscripts", isError: false, task: "also remove the leftover temp copies in the repo root if any" } },
  { name: "m3-rm-nooutput     ", expect: "ok", state: { tool: "bash", input: "rm leftover-temp-copy-a.txt leftover-temp-copy-b.txt", result: "(no output)", isError: false, task: "also remove the leftover temp copies in the repo root if any" } },
  { name: "m3-ls-dist         ", expect: "ok", state: { tool: "bash", input: "ls ./packages/vite/dist", result: "./packages/vite/dist\n---", isError: false, task: "clean up the build artifacts in this project" } },
  { name: "m3-compound-catgrep", expect: "ok", state: { tool: "bash", input: 'cat package.json 2>/dev/null; grep -rE "port" vite.config.* 2>/dev/null', result: PKG_JSON, isError: false, task: "what port is the dev server configured on?" } },
  { name: "m3-ls-leftovers    ", expect: "ok", state: { tool: "bash", input: "ls -la leftover-temp-copy-*; file leftover-temp-copy-*", result: LS_LEFTOVERS, isError: false, task: "also remove the leftover temp copies in the repo root if any" } },
  // advisory: shows a REAL typecheck error, but the task was to surface it —
  // genuinely ambiguous ground truth (like wrong-file-read), excluded from gates.
  { name: "m3-rolldown-ts     ", expect: "advisory-ok", state: { tool: "bash", input: "node -e \"console.log('module ok')\" && npx tsc --noEmit", result: "module ok, exec: function\npackages/vite/rolldown.config.ts(5,29): error TS2307: Cannot find module 'rolldown'.", isError: false, task: "verify the fix and tell me what was wrong" } },
];

const QS = { failed: noul(W_FAILED), error: noul(W_ERROR), empty: noul(W_EMPTY) };

for (let r = 0; r < 3; r++) {
  const rows: string[] = [];
  for (const c of CASES) {
    const { answers } = await decisionkit.systemOne({
      state: {
        tool: c.state.tool,
        input: c.state.input,
        result: c.state.result.slice(0, 4000),
        isError: c.state.isError,
      },
      questions: QS,
    });
    const failed = (answers.failed as { noul: number }).noul;
    const error = (answers.error as { noul: number }).noul;
    const empty = (answers.empty as { noul: number }).noul;
    rows.push(`${c.name} f=${failed.toFixed(2)} e=${error.toFixed(2)} m=${empty.toFixed(2)} (${c.expect[0]})`);
  }
  console.log(`run${r}:`);
  for (const row of rows) console.log(`  ${row}`);
}
console.log("\nPolicy reference: intervene = isError || error > tErr || (failed > tFail && empty > tEmpty)");
