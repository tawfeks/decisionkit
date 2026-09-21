/** 3-run verification of the `failed` question across all 10 critic cases. */
import { TypeSafeClient, noul } from "@typesafe-ai/sdk";

const decisionkit = new TypeSafeClient();
const CASES: Array<[string, string, Record<string, unknown>]> = [
  ["module-not-found", "intervene", { tool: "bash", input: "node src/index.ts", result: "Error: Cannot find module './helperx'", isError: true, task: "fix the failing import in src/index.ts" }],
  ["test-fail", "intervene", { tool: "bash", input: "npm test", result: "FAIL src/parse.test.ts\n  ● parseConfig throws on missing key\nTests: 2 failed, 12 passed, 14 total", isError: true, task: "make the test suite pass" }],
  ["typecheck-fail", "intervene", { tool: "bash", input: "npx tsc --noEmit", result: "src/index.ts(12,3): error TS2304: Cannot find name 'expct'.", isError: true, task: "fix the type errors" }],
  ["edit-miss", "intervene", { tool: "edit", input: "src/config.ts oldText port: 3000", result: "String to replace not found in file. No changes were made.", isError: true, task: "change the dev server port to 8080" }],
  ["empty-grep", "intervene", { tool: "bash", input: "grep -rn handleSubmit src/", result: "", isError: false, task: "rename handleSubmit to onSubmit and update its callers" }],
  ["wrong-file-read", "intervene", { tool: "read", input: "README.md", result: "# MyProject\nA demo repository.\nnpm install\nnpm run dev", isError: false, task: "change the dev server port to 8080" }],
  ["test-pass", "ok", { tool: "bash", input: "npm test", result: "Tests: 14 passed, 14 total\nTime: 2.3s", isError: false, task: "make the test suite pass" }],
  ["build-success", "ok", { tool: "bash", input: "npm run build", result: "dist/index.js 14.2kb\nDone in 0.6s", isError: false, task: "build the package" }],
  ["grep-hit", "ok", { tool: "bash", input: "grep -rn handleSubmit src/", result: "src/app.ts:12: handleSubmit(evt) {\nsrc/app.ts:41: onClick={handleSubmit}", isError: false, task: "rename handleSubmit to onSubmit and update its callers" }],
  ["edit-applied", "ok", { tool: "edit", input: "src/config.ts", result: "Applied 1 edit to src/config.ts", isError: false, task: "change the dev server port to 8080" }],
];

for (let r = 0; r < 3; r++) {
  let line = `run${r}: `;
  for (const [name, expect, state] of CASES) {
    const { answers } = await decisionkit.systemOne({
      state,
      questions: { failed: noul("Did this tool call fail, error, or otherwise not accomplish the agent's intended action?") },
    });
    line += `${name}=${(answers.failed as { noul: number }).noul.toFixed(2)}(${expect[0]}) `;
  }
  console.log(line);
}
