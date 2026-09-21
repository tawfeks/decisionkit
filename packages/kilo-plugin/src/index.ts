import type { Plugin } from "@kilocode/plugin";
import { tool } from "@kilocode/plugin/tool";
import type { DecisionKitSchemaBuilder } from "decisionkit-core";
import { createDecisionKitHostHooks } from "decisionkit-core";

/**
 * decisionkit harness for Kilo.
 *
 * Kilo's plugin API is behaviorally identical to opencode's for the tool hooks
 * (tool.execute.before throws to block, tool.execute.after rewrites output,
 * tool() registers custom tools; verified against
 * https://kilo.ai/docs/automate/extending/plugins 2026-09-20). There is a
 * `chat.message` hook but it cannot skip the LLM, so Tier 2 turn routing stays
 * pi-first — the same hook, however, CAN inject pre-turn context, so S0
 * (plan-v3 §2.1) ships here: it appends the digest as a text part of the user
 * message before the frontier's first turn (DECISIONKIT_S0=0 disables). All
 * logic lives in decisionkit-core (createDecisionKitHostHooks); this file is
 * pure translation.
 *
 * Install: `npx decisionkit init` (adds this package to kilo.json plugin) —
 * or `kilo plugin decisionkit-kilo-plugin`. Kill switch: DECISIONKIT_ENABLE=0.
 * Receipts: .decisionkit/receipts.jsonl.
 */
const server: Plugin = async (ctx) => {
  const hooks = createDecisionKitHostHooks({
    worktree: ctx.worktree,
    host: "kilo",
    schema: { string: () => tool.schema.string() } satisfies DecisionKitSchemaBuilder,
  });
  return {
    "chat.message": hooks["chat.message"],
    "tool.execute.before": hooks["tool.execute.before"],
    "tool.execute.after": hooks["tool.execute.after"],
    tool: {
      decisionkit_locate: tool(hooks.locateTool as unknown as Parameters<typeof tool>[0]),
    },
  };
};

export default { id: "decisionkit", server };
