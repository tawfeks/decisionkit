import { InMemoryLedger, DecisionKitCore } from "decisionkit-core";

const ledger = new InMemoryLedger();
const decisionkit = new DecisionKitCore({ enabled: true, model: "jev-1.13.0", timeoutMs: 10000 }, ledger);
const d = await decisionkit.critic({
  tool: "bash",
  toolInput: { command: "node src/index.ts" },
  resultPreview: "Error: Cannot find module './helperx'",
  isError: true,
  taskContext: "fix the failing import in src/index.ts",
});
console.log(d.action, d.receipt.decision, JSON.stringify(d.receipt.detail));
