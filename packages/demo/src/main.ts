import { readFile } from "node:fs/promises";
import { InMemoryLedger, DecisionKitCore } from "decisionkit-core";

/**
 * decisionkit-demo: a no-harness mini-agent that shows the System-1 pattern.
 *
 * There is no frontier LLM here. Every "answer" is either:
 *  - routed straight to a mechanical resolver (read/ls) via Tier 2, or
 *  - passed through (the demo prints what the LLM would be asked).
 *
 * Usage: npx decisionkit-demo "What port is the dev server configured on?" [fileToRead]
 */
async function main(): Promise<void> {
  const prompt = process.argv[2];
  const file = process.argv[3];
  if (prompt === undefined || file === undefined) {
    console.error("Usage: decisionkit-demo \"<prompt>\" <file-to-read>");
    process.exit(1);
  }
  const ledger = new InMemoryLedger();
  const decisionkit = new DecisionKitCore({ enabled: process.env.DECISIONKIT_ENABLE !== "0" }, ledger);
  const started = Date.now();

  const decision = await decisionkit.routing({
    prompt,
    cwd: process.cwd(),
    registeredTools: ["read", "ls"],
  });

  if (decision.action === "route" && decision.tool === "read") {
    const content = await readFile(file, "utf8");
    console.log(`[decisionkit] routed to read — frontier LLM turn deleted`);
    console.log(`[decisionkit] ${content.trim().slice(0, 400)}`);
  } else {
    console.log(
      `[decisionkit] passthrough — an LLM turn would handle: "${prompt}"\n[decisionkit] (demo has no LLM; this is where generation would happen)`,
    );
  }

  const t = ledger.totals();
  console.log(
    `\n[decisionkit receipts] ${t.calls} call(s), ${t.inputTokens} in-tok, p50 ${t.latencyMsP50}ms, wall ${Date.now() - started}ms, fail-open ${t.failOpen}`,
  );
  for (const r of ledger.all()) {
    console.log(`  - ${r.tier}: ${r.decision} (${r.latencyMs}ms, ok=${r.ok})`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
