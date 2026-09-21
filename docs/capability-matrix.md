# Harness capability matrix — re-verified 2026-09-20 (integration v0.1.2)

> **Looking for install instructions?** This is the maintainer verification
> record, not a how-to. Installation is always one command, for every host:
>
> ```sh
> npx decisionkit-cli init                # auto-detects the agent
> npx decisionkit-cli init --agent <pi|opencode|kilo|claude|codex>
> ```
>
> `init` prints this matrix and installs the adapter at the target listed in
> the "Install surface" column. Undo with `npx decisionkit-cli remove
> --agent <name>`. See the README's "Installing" section for the condensed
> host → install-target table.

Sources checked at verification time (docs win over the docs/plans/ integration plans on any conflict):

- pi: `pi/packages/coding-agent/docs/extensions.md` (local clone, ground truth)
- opencode: https://opencode.ai/docs/plugins (last updated Sep 20, 2026)
- Kilo: https://kilo.ai/docs/automate/extending/plugins (checked Sep 20, 2026)
- Claude Code: https://code.claude.com/docs/en/hooks (checked Sep 20, 2026)
- Codex: https://developers.openai.com/codex/hooks (checked Sep 20, 2026) and /codex/extend/mcp

**v0.1.2 integration status: the S0 plan (docs/plans/pi-extension-s0-context.md) parity ships on ALL five hosts.** S0
pre-turn context assembly, the tax-removal fast paths (static read-only
guardrail allowlist, critic non-empty fast path, verdict caches), and the
locate content-sweep fallback now live in `decisionkit-core`
(`src/s0.ts`, `src/tax-fastpath.ts`, `src/host-hooks.ts`, `src/host-hook.ts`);
every adapter is a thin translation layer.

## Tier support per host

| Host | T1 Guardrail | T2 Turn routing | S0 Context | T2.5 Triage | T3 Critic | `decisionkit_locate` | Install surface | Adapter |
|---|---|---|---|---|---|---|---|---|
| pi | yes — `tool_call` block, fast path + caches | **YES** — `input` event → `{action:"handled"}` deletes LLM turns | yes — input transform merges the digest (cache-stable) + full run state (frontier turns, s0.wasted) | yes — phase-aware scoping | yes — fast path | yes — `registerTool` + content fallback | drop-in `.pi/extensions/decisionkit/` | `decisionkit-pi-ext` (full adapter) |
| opencode | yes — throw from `tool.execute.before` (documented `.env`-protection pattern), fast path + caches | **no** — plugin event list still has no prompt-intercept hook (re-checked Sep 20, 2026) | **yes — `chat.message` appends the digest as a text part of the user message** (found in plugin types + docs; upgraded from the Sep 18 "no injection" reading) | yes — `tool.execute.after` rewrite, phase-aware + caches | yes — fast path | yes — `tool()` (plugin tools override built-ins on name collision) + content fallback | npm plugin entry in `opencode.json` | `decisionkit-opencode-plugin` |
| Kilo | yes — throw from `tool.execute.before`, fast path + caches | **no** — `chat.message` still only inspects/modifies parts, cannot skip the LLM | **yes — same `chat.message` digest part as opencode** | yes — `tool.execute.after` + caches | yes — fast path | yes — `tool()` + content fallback | npm plugin entry in `kilo.json` (or `kilo plugin <pkg>`, or drop-in `.kilo/plugin/`) | `decisionkit-kilo-plugin` |
| Claude Code | yes — `PreToolUse` → `permissionDecision: "deny"` (+ reason shown to the model); read-only fast path | **no** hook can answer without the LLM | **yes — `UserPromptSubmit` `hookSpecificOutput.additionalContext`** (digest injected before the frontier's first turn; verified in docs Sep 20, 2026) | advisory (PostToolUse `additionalContext` note on stub-worthy reads; `updatedToolOutput` result-rewrite exists in the docs — a future upgrade, blocked on each tool's undocumented response shape) | yes — fast path, `PostToolUse` `additionalContext` | yes — MCP server | hooks in `.claude/settings.json` (now incl. `UserPromptSubmit`) + MCP in `.mcp.json` — **implemented** | `decisionkit-cli init --agent claude` |
| Codex | yes — `PreToolUse` deny (same `hookSpecificOutput` shape; requires `/hooks` trust review); read-only fast path | **no** — `UserPromptSubmit` can block a prompt but not answer it | **yes — `UserPromptSubmit` `additionalContext`** (added as extra developer context; verified Sep 20, 2026) | result-replace **capability** — `PostToolUse` `decision:"block"` swaps the model-visible result; ships critic-only today (reads go through `Bash`, so a read stub cannot be targeted reliably) | result-replace (stronger than advisory, fast path) | yes — MCP server in `config.toml` | `.codex/hooks.json` (now incl. `UserPromptSubmit`) + `[mcp_servers.decisionkit]` — **implemented** (trust review surfaced at install) | `decisionkit-cli init --agent codex` |

S0 caveats per host: pi keeps the full run state (frontier-turn counter,
`s0.wasted` receipts). The plugin hosts track waste per prompt boundary in the
factory (a `s0: waste(n/m)` receipt per prompt). The Claude/Codex stdin hooks
are process-per-event, so no cross-call state: the digest injection is the
lever there, waste accounting is receipt-only.

## Verification notes (2026-09-20)

- **opencode (docs updated Sep 20, 2026)**: hook list unchanged — no
  prompt-intercept/turn-skip event; `.env`-protection throw pattern still the
  documented guardrail idiom; plugin tools still override built-ins on name
  collision. The S0 upgrade comes from the `chat.message` hook
  ("Called when a new message is received", mutates `output.parts`), present
  in `@opencode-ai/plugin` types (checked against 1.18.31 locally).
- **Kilo (checked Sep 20, 2026)**: hooks reference matches opencode's
  behaviorally; `chat.message` = "Fires when a new user message arrives.
  Inspect or modify `parts`" — no LLM skip (routing stays pi-only) but digest
  injection works. Install surfaces: `plugin` array in `kilo.json`/
  `opencode.json`, `.kilo/plugin/` drop-in dir, `kilo plugin <pkg>` command.
- **Claude Code (checked Sep 20, 2026)**: `PreToolUse` deny shape unchanged;
  `PostToolUse` gained `updatedToolOutput` (result rewrite — must match each
  tool's undocumented output shape, still a future triage upgrade) and a
  `PostToolUseFailure` event. `UserPromptSubmit` accepts plain-text stdout or
  `hookSpecificOutput.additionalContext` as context injection — that is the
  S0 mechanism (installed via `decisionkit-cli init --agent claude`).
- **Codex (checked Sep 20, 2026)**: hooks in `.codex/hooks.json` or inline
  `[hooks]` in `config.toml`, project-scoped, per-definition trust review via
  `/hooks` before they run (printed at install time). `PreToolUse` deny +
  `PostToolUse` `decision:"block"` result-replace unchanged.
  `UserPromptSubmit` supports `hookSpecificOutput.additionalContext`
  ("added as extra developer context") — the S0 mechanism. MCP:
  `[mcp_servers.<name>]` in `config.toml` (absolute wrapper path baked at
  install time). Install: `decisionkit-cli init --agent codex`.
- **pi**: unchanged (local docs are ground truth).

## Shared-factory note

opencode + kilo adapters are pure translation over `decisionkit-core`'s
`createDecisionKitHostHooks()` (S0 `chat.message` injection, guardrail
before-hook with fast path + caches, read triage + critic after-hook with fast
path + caches, `decisionkit_locate` with content fallback); all policy lives in
core. The Claude/Codex hooks share the same policies via
`decisionkit-core/host-hook` (`UserPromptSubmit` → S0, `PreToolUse` →
guardrail + fast path, `PostToolUse` → triage/critic + fast path). The pi
adapter keeps its own full-tier adapter because turn routing is pi-only; its
S0 state machine and fast path moved INTO core in 0.1.2
(`decisionkit-core` exports `s0LocalPrep` / `finishS0` /
`bashCommandIsReadOnly` / `extractDiscoveryPaths`).

`npx decisionkit-cli init` prints this matrix, then installs any of the five hosts
(pi / opencode / kilo / claude / codex) plus the shipped agent skills. A tarball-only
acceptance check (build → npm pack → init per host from tarballs, no registry publish,
no workspace `file:` links) runs before each release in the maintainer workspace.

All packages publish as **0.1.2**.
