/**
 * Critic policy probe with REAL M3-captured cases (vite rig, 2026-09-17 run).
 *
 * The shipped anchored wording separates the M2 eval set (failures 0.76–0.99,
 * oks ≤0.13) but false-fired on the vite rig: `cat package.json` during a
 * cleanup task scored 0.84, an `ls` listing 0.45, a successful silent
 * `rm` returning "(no output)" 0.83 — task-context priming ("did this
 * accomplish the CLEANUP?") plus the "empty/missing outcome" anchor. True
 * catches were ≥0.94 (results showing "Command exited with code 1").
 *
 * Probes 4 variants: current wording vs invocation-anchored wording, each with
 * and without `task` in the state. Ground truth from the rig: every true catch
 * is visible in the result itself; every false fire was a command that DID what
 * it was invoked to do.
 *
 * Run: npx tsx --env-file=.env packages/core/scripts/m3-critic-policy-probe.ts
 */
import { TypeSafeClient, noul } from "@typesafe-ai/sdk";

const decisionkit = new TypeSafeClient();

const W_CURRENT =
  "Did this tool call fail, error, or otherwise not accomplish what it was invoked to do? Answer yes only if the result itself shows an error, an empty/missing outcome, or incomplete execution — not merely because the output is unremarkable.";
const W_INVOCATION =
  "Did this tool call fail, error, or otherwise not accomplish what the agent invoked it to do (judge against the tool input itself, not the broader task)? Answer yes only if the result itself shows an error, a non-zero exit, an empty/missing outcome, or incomplete execution. A successful step toward the broader task is never a failure here.";

const PKG_JSON = `{
  "name": "@vitejs/vite-monorepo",
  "private": true,
  "type": "module",
  "engines": { "node": "^20.19.0 || >=22.12.0" },
  "homepage": "https://vite.dev/",
  "repository": { "type": "git", "url": "git+https://github.com/vitejs/vite.git" },
  "scripts": { "dev": "pnpm --filter='./packages/vite' run dev" }
}

Command exited with code 1`;

const LS_ROOT =
  "CONTRIBUTING.md\nLICENSE\nREADME.md\ndocs\neslint.config.js\nleftover-temp-copy-a.txt\nleftover-temp-copy-b.txt\nnetlify.toml\npackage.json\npackages\npatches\nplayground\npnpm-lock.yaml\npnpm-workspace.yaml\nscripts";

const CASES: Array<{
  name: string;
  expect: "intervene" | "ok";
  state: { tool: string; input: string; result: string; isError: boolean; task: string };
}> = [
  // True catches (M3 rig, both exited 1 — result itself shows the failure)
  { name: "m3-cat-dist-exit1", expect: "intervene", state: { tool: "bash", input: "cat packages/vite/dist/index.js", result: "// rig-generated placeholder build artifact (Demo B target)\n\nCommand exited with code 1", isError: false, task: "clean up the build artifacts in this project" } },
  { name: "m3-du-exit1", expect: "intervene", state: { tool: "bash", input: "du -ah packages/vite/dist", result: "4.0K\tpackages/vite/dist\nindex.js\n\nCommand exited with code 1", isError: false, task: "clean up the build artifacts in this project" } },
  // M2 eval shapes
  { name: "module-not-found", expect: "intervene", state: { tool: "bash", input: "node src/index.ts", result: "Error: Cannot find module './helperx'", isError: true, task: "fix the failing import in src/index.ts" } },
  { name: "test-fail", expect: "intervene", state: { tool: "bash", input: "npm test", result: "FAIL src/parse.test.ts\nTests: 2 failed, 12 passed, 14 total", isError: true, task: "make the test suite pass" } },
  { name: "typecheck-fail", expect: "intervene", state: { tool: "bash", input: "npx tsc --noEmit", result: "src/index.ts(12,3): error TS2304: Cannot find name 'expct'.", isError: true, task: "fix the type errors" } },
  { name: "edit-miss", expect: "intervene", state: { tool: "edit", input: "src/config.ts", result: "String to replace not found in file. No changes were made.", isError: true, task: "change the dev server port to 8080" } },
  { name: "empty-grep", expect: "intervene", state: { tool: "bash", input: "grep -rn 'handleSubmit' src/", result: "", isError: false, task: "rename handleSubmit to onSubmit and update its callers" } },
  // False fires observed on the M3 rig (real captured outputs)
  { name: "m3-cat-package", expect: "ok", state: { tool: "bash", input: "cat package.json", result: PKG_JSON, isError: false, task: "clean up the build artifacts in this project" } },
  { name: "m3-ls-root", expect: "ok", state: { tool: "bash", input: "ls", result: LS_ROOT, isError: false, task: "also remove the leftover temp copies in the repo root if any" } },
  { name: "m3-rm-nooutput", expect: "ok", state: { tool: "bash", input: "rm leftover-temp-copy-a.txt leftover-temp-copy-b.txt", result: "(no output)", isError: false, task: "also remove the leftover temp copies in the repo root if any" } },
  { name: "m3-ls-dist", expect: "ok", state: { tool: "bash", input: "ls ./packages/vite/dist", result: "./packages/vite/dist\n---", isError: false, task: "clean up the build artifacts in this project" } },
  { name: "m3-rolldown-typecheck", expect: "ok", state: { tool: "bash", input: "node -e \"console.log('module ok')\" && npx tsc --noEmit", result: "import { exec } from 'node:child_process'\nmodule ok, exec: function\npackages/vite/rolldown.config.ts(5,29): error TS2307: Cannot find module 'rolldown' or its corresponding type declarations.", isError: false, task: "verify the fix and tell me what was wrong" } },
  // M2 eval oks
  { name: "test-pass", expect: "ok", state: { tool: "bash", input: "npm test", result: "Tests: 14 passed, 14 total\nSnapshots: 0 total\nTime: 2.3s", isError: false, task: "make the test suite pass" } },
  { name: "grep-hit", expect: "ok", state: { tool: "bash", input: "grep -rn 'handleSubmit' src/", result: "src/app.ts:12:  handleSubmit(evt) {\nsrc/app.ts:41:  onClick={handleSubmit}", isError: false, task: "rename handleSubmit to onSubmit and update its callers" } },
  { name: "edit-applied", expect: "ok", state: { tool: "edit", input: "src/config.ts", result: "Applied 1 edit to src/config.ts", isError: false, task: "change the dev server port to 8080" } },
];

const VARIANTS: Array<{ name: string; wording: string; withTask: boolean }> = [
  { name: "W0-current+task  ", wording: W_CURRENT, withTask: true },
  { name: "W1-current-notask", wording: W_CURRENT, withTask: false },
  { name: "W2-invocation+task", wording: W_INVOCATION, withTask: true },
  { name: "W3-invocation-notask", wording: W_INVOCATION, withTask: false },
];

for (let r = 0; r < 3; r++) {
  for (const v of VARIANTS) {
    const parts: string[] = [];
    for (const c of CASES) {
      const state: Record<string, unknown> = {
        tool: c.state.tool,
        input: c.state.input,
        result: c.state.result.slice(0, 4000),
        isError: c.state.isError,
      };
      if (v.withTask) state.task = c.state.task;
      const { answers } = await decisionkit.systemOne({ state, questions: { failed: noul(v.wording) } });
      parts.push(`${c.name}=${(answers.failed as { noul: number }).noul.toFixed(2)}(${c.expect[0]})`);
    }
    console.log(`run${r} ${v.name}: ${parts.join(" ")}`);
  }
}
