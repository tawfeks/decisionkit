# DecisionKit

<p align="center"><b>A decision layer, pre-calibrated per coding agent, that cuts slow, expensive LLM turns.</b></p>

DecisionKit turns your coding agent into a System-1/System-2 pair: cheap, fast, typed judgments — guardrail gating, tool-result critique, file-location triage — move to ~100ms typed calls, and the frontier LLM only does work that requires generation. On pi it goes further: Tier 2 turn routing deletes whole LLM round trips for mechanical requests. Every decision is logged to `.decisionkit/receipts.jsonl`.

This package is the CLI / npx entry.

## Quick start

```sh
cd your-repo
npx decisionkit-cli init              # detects (or --agent asks) your harness, installs the adapter
echo "TYPESAFE_API_KEY=…" >> .env     # DecisionKit reads .env from the repo root automatically
```

Restart your agent. Done.

No TypeSafe key? `OPENROUTER_API_KEY` works as a fallback transport with the same questions schema — an agent that already runs on OpenRouter is reused with zero extra setup.

### Quick win: one prompt that shows it off

S0 (pre-turn repo context, on every host) pays off most on discovery-heavy prompts. Paste this into your agent, in any repo:

```text
Audit this repo: map the entry points and data flow, list the main features, and flag the top 5 risks — with file:line anchors for everything.
```

The baseline burns a dozen discovery turns re-reading the repo before answering; DecisionKit assembles the map before the frontier's first turn. Measured on real tasks: ↓2–4× input tokens, ↓13–45% cost per session.

## Commands

- `init` — detect/ask the coding agent, install the adapter
- `remove` — undo an install
- `test` — deterministic per-tier eval of the question packs against this repo
- `matrix` — per-host capability matrix

## What you get per host

All five hosts get S0 pre-turn context + guardrail + triage + critic + `decisionkit_locate`. Tier 2 turn routing is pi-only (no other host exposes a turn-intercept hook). Full matrix: `npx decisionkit-cli matrix`.

| Host | Install target | Turn routing | Skills installed to |
|---|---|---|---|
| pi | drop-in at `.pi/extensions/decisionkit/` | ✅ | — (no verified skills surface) |
| opencode | npm plugin in `opencode.json` | — | `.opencode/skill/` |
| Kilo | npm plugin in `kilo.json` | — | `.kilo/skills/` |
| Claude Code | hooks in `.claude/settings.json` + `decisionkit_locate` MCP in `.mcp.json` | — | `.claude/skills/` |
| Codex | hooks in `.codex/hooks.json` + MCP in `.codex/config.toml` (one-time `/hooks` trust review) | — | — (no verified skills surface) |

## Verify

```sh
npx decisionkit-cli test            # deterministic eval; exit 1 = a tier failed its gate
npx decisionkit-cli test --agent kilo --json   # eval an agent's shipped pack
```

## Calibration (central, per coding agent)

Packs ship pre-calibrated per coding agent (pi, opencode, kilo, claude, codex): the tier set is shaped by each host's verified hook surface (routing ships only on pi — it is the only host whose input event can delete the LLM turn), and wording/thresholds are measured once on the central rigs (`decisionkit-core` scripts) and shipped identical across agents. There is no per-repo calibration: if a tier fails its gate on your repo, that is a default-pack bug to fix in the central harness, never per repo. `DECISIONKIT_PACK=<path>` remains an explicit override for central benchmarks and experiments.

## Shipped agent skills

`init` also installs the two agent skills shipped with `decisionkit-core` (source: `packages/core/src/skills/`, published in `dist/skills/`) into the host's skills directory where one is verified — see the "Skills installed to" column above; pi and codex have no verified skills surface, so their agents use the shipped copies in `node_modules/decisionkit-core/dist/skills/`. `remove` deletes the installed copies.

| Skill | What it does | When to use |
|---|---|---|
| `decisionkit-calibrate` | Calibrates the question pack for your repo: probes with eval sets, mutates question wording/thresholds under holdout discipline, writes the winner to `.decisionkit/pack.json` (auto-loaded by the adapters) + a calibration report. | A gated tier fails `npx decisionkit-cli test` on your repo, or you explicitly want to try to beat the shipped default. A per-repo pack is an explicit override — default-pack failures are fixed centrally. |
| `decisionkit-bench-fixture` | Authors a bench fixture for your repo: known-answer task, 2–3 shipped prompts, deterministic `verify()` pass/fail (gate only unambiguous facts; borderline is discretionary) + report gates, with a verify sanity check before paying for runs. | Benchmarking DecisionKit on a repo with no shipped fixture (`bench/run.ts --fixture <name>`). |

Use them by asking your agent by name or by pointing it at the `SKILL.md` path.

## Environment variables

All DecisionKit configuration is environment-driven; keys are read from the process env or `.env` in the repo root (auto-parsed, no dotenv dependency).

| Variable | Default | Purpose |
|---|---|---|
| `TYPESAFE_API_KEY` | unset | Preferred provider — direct typed-questions API, lowest latency. Required unless `OPENROUTER_API_KEY` is set |
| `OPENROUTER_API_KEY` | unset | Fallback transport — OpenRouter Decisions, same questions schema (only used when `TYPESAFE_API_KEY` is unset) |
| `DECISIONKIT_ENABLE` | `1` (all tiers on) | Kill switch — set to `0` to disable all tiers; agent behaves exactly like baseline |
| `DECISIONKIT_S0` | `1` (on) | Set to `0` to disable S0 pre-turn context only (other tiers stay on) |
| `DECISIONKIT_PACK` | unset → shipped agent-calibrated pack for your host | Path to a question-pack JSON — explicit override (central benchmarks/experiments) |
| `DECISIONKIT_DEBUG` | `0` (off) | Set to `1` for verbose debug output |

Note: the off-switches match the exact string `0` — any other value (including unset) leaves the feature enabled.

## Packages

- `decisionkit-cli` — this CLI / npx entry
- `decisionkit-core` — tiers, policies, question packs, receipts ledger, shipped agent skills
- `decisionkit-pi-ext` / `decisionkit-opencode-plugin` / `decisionkit-kilo-plugin` — adapters
- `decisionkit-demo` — standalone mini-agent showcase (`npx decisionkit-demo`)

## License

MIT
