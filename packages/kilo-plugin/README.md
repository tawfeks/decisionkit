# decisionkit-kilo-plugin

Kilo plugin adapter for decisionkit-core (plugin API behaviorally identical to
opencode's; verified against https://kilo.ai/docs/automate/extending/plugins
2026-09-20):

- **S0 pre-turn context assembly**: the `chat.message` hook
  cannot skip the LLM (turn routing stays pi-first), but it CAN inject
  pre-turn context — it appends the S0 digest as a text part of the user
  message before the LLM's first turn. `DECISIONKIT_S0=0` disables.
- **Guardrail** (`tool.execute.before` throw to block) with the static
  read-only fast path and per-command verdict caches.
- **Read triage + critic** (`tool.execute.after` rewrite), phase-aware.
- **`decisionkit_locate`** via `tool()` registration, with a bounded
  content-sweep fallback.

Install via `npx decisionkit-cli init` (adds the npm plugin to `kilo.json`) —
or `kilo plugin decisionkit-kilo-plugin`, or the drop-in `.kilo/plugin/` dir.

License: MIT
