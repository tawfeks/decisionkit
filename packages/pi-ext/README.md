# decisionkit-pi-ext

pi extension adapter for decisionkit-core — the only full-tier adapter, and
the only host where Tier 2 turn routing exists: the `input` event can return
`{ action: "handled" }` and skip the frontier LLM entirely for mechanical
requests. Also ships:

- **S0 pre-turn context assembly**: local sweep (terms →
  fan-out → candidate cards → outlines, zero model calls) + one batched jev
  round trip per assemble round; the digest is merged into the user prompt
  via an input transform (cache-stable, append-only).
- Guardrail gating with the read-only fast path + verdict caches, phase-aware
  read scoping, critic fast path, `decisionkit_locate` via `registerTool`,
  receipts ledger, frontier-turn / s0.wasted widget counters.

Install via `npx decisionkit-cli init` (drop-in at `.pi/extensions/decisionkit/`).

License: MIT
