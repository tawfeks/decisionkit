import { InMemoryLedger, DecisionKitCore } from "decisionkit-core";

const ledger = new InMemoryLedger();
const decisionkit = new DecisionKitCore({ enabled: true, model: "jev-1.13.0", timeoutMs: 10000 }, ledger);
const task = "rename formatDate to formatDateLong in src/utils/format.ts and update its callers";
for (const p of [
  "src/utils/format-date.ts",
  "src/utils/formatDate.ts",
  "src/api/format.ts",
  "src/utils/format.ts",
  "src/index.ts",
]) {
  const d = await decisionkit.triageRead({ path: p, taskContext: task });
  console.log(`${p} -> ${d.action} ${d.receipt.decision} lat=${d.receipt.latencyMs}ms`);
}
