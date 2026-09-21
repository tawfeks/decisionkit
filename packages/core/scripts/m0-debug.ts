import { InMemoryLedger, DecisionKitCore } from "decisionkit-core";

const decisionkit = new DecisionKitCore({ enabled: true }, new InMemoryLedger());
const variants: Array<[string, string[] | undefined]> = [
  ["what port is the dev server configured on", undefined],
  ["what port is the dev server configured on", ["package.json", "src/index.ts"]],
  ["what port is the dev server on", ["package.json", "vite.config.ts"]],
  ["read the file package.json", ["package.json", "src/index.ts"]],
  ["what's in package.json", ["package.json", "src/index.ts"]],
  ["show the dev server port from package.json", ["package.json"]],
];
for (const [prompt, files] of variants) {
  const d = await decisionkit.routing({ prompt, cwd: "/tmp/project", registeredTools: ["read", "ls"], fileListing: files });
  console.log(JSON.stringify(d.receipt.detail), d.action, "tool" in d ? d.tool : "", "←", prompt);
}
