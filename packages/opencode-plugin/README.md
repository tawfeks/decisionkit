# decisionkit-opencode-plugin

opencode plugin adapter for decisionkit-core:

- **S0 pre-turn context assembly**: the `chat.message` hook
  appends the S0 digest as a text part of the user message before the LLM's
  first turn (verified against https://opencode.ai/docs/plugins 2026-09-20).
  `DECISIONKIT_S0=0` disables; every failure fails open.
- **Guardrail** (`tool.execute.before` throw to block) with the static
  read-only fast path and per-command verdict caches.
- **Read triage + critic** (`tool.execute.after` rewrite), phase-aware: reads
  the S0 digest directed are never stubbed; non-empty results skip the critic
  call.
- **`decisionkit_locate`** via `tool()` registration, with a bounded
  content-sweep fallback when the filename search misses.

Turn routing (deleting whole LLM turns) is not possible on opencode — no
prompt-intercept hook — that stays pi-first.

Install via `npx decisionkit-cli init` (adds the npm plugin to `opencode.json`).

License: MIT
