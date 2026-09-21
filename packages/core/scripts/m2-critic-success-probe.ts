import { InMemoryLedger, DecisionKitCore } from "decisionkit-core";

const decisionkit = new DecisionKitCore({ enabled: true, model: "jev-1.13.0", timeoutMs: 10000 }, new InMemoryLedger());
const d = await decisionkit.critic({
  tool: "bash",
  toolInput: { command: "node src/index.ts" },
  resultPreview: "hello world",
  isError: false,
  taskContext: "fix the failing import in src/index.ts",
});
console.log("success-bash:", d.receipt.decision, JSON.stringify(d.receipt.detail));
