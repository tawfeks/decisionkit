import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { DecisionKitSchemaBuilder } from "decisionkit-core";
import { createDecisionKitHostHooks } from "decisionkit-core";

/**
 * decisionkit harness for opencode.
 *
 * opencode has no turn-routing hook (no prompt-intercept event in the plugin
 * API; verified against https://opencode.ai/docs/plugins 2026-09-20), so per
 * plan-v2/v3 the turn-routing tier stays pi-first. This adapter ships:
 *  - guardrail (tool.execute.before throws to block; read-only fast path +
 *    verdict caches, plan-v3 §2.4)
 *  - S0 pre-turn context assembly (chat.message appends the digest as a text
 *    part — verified against the plugin docs/types 2026-09-20: the hook
 *    mutates the user message parts before the LLM turn; DECISIONKIT_S0=0 off)
 *  - read triage (tool.execute.after rewrite, phase-aware) + critic fast path
 *  - decisionkit_locate custom tool (with content-sweep fallback)
 * All logic lives in decisionkit-core (createDecisionKitHostHooks); this file
 * is pure translation.
 *
 * Install: `npx decisionkit init` (adds this package to opencode.json plugin).
 * Kill switch: DECISIONKIT_ENABLE=0. Receipts: .decisionkit/receipts.jsonl.
 */
export const DecisionKitPlugin: Plugin = async (ctx) => {
  const hooks = createDecisionKitHostHooks({
    worktree: ctx.worktree,
    host: "opencode",
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
