# decisionkit-core

<p align="center"><b>A decision layer, pre-calibrated per coding agent, that cuts slow, expensive LLM turns.</b></p>

The host-agnostic core of DecisionKit: System-1 tiers (guardrail, S0 context, triage, critic — and pi-only turn routing via the pi adapter), data-calibrated question packs, and the receipts ledger. It bolts onto a frontier loop it doesn't own: the LLM only does work that requires generation, every decision is logged, and every tier fails open — if DecisionKit is slow or down, the agent behaves exactly like baseline.

## Quick start (as a user)

```sh
cd your-repo
npx decisionkit-cli init              # installs the adapter for your harness
echo "TYPESAFE_API_KEY=…" >> .env     # or OPENROUTER_API_KEY (fallback, same schema)
```

Restart your agent — guardrail, S0 pre-turn context, triage, critic, and receipts are live.

### Quick win: one prompt that shows it off

S0 assembles repo context before the frontier's first turn (local sweep → fan-out → candidate cards → outlines, zero model calls, then one batched typed call). It pays off most on discovery-heavy prompts — paste this in any repo:

```text
Audit this repo: map the entry points and data flow, list the main features, and flag the top 5 risks — with file:line anchors for everything.
```

Measured on real tasks: ↓2–4× input tokens, ↓13–45% cost per session, `file:line` anchors throughout.

## Quick start (as a library)

```sh
npm install decisionkit-core
echo "TYPESAFE_API_KEY=…" >> .env
```

```ts
import { DecisionKitCore, InMemoryLedger } from "decisionkit-core";

const dk = new DecisionKitCore({}, new InMemoryLedger(".decisionkit/receipts.jsonl"));
const decision = await dk.guardrail({ tool: "bash", toolInput: { command: "rm -rf ./" } });
// { action: "block", reason: …, receipt: … } — always fails open on errors.
```

## CLI

`npm install decisionkit-core` also installs the `decisionkit` binary:

- `decisionkit init` — detect/ask the coding agent, install the adapter
- `decisionkit remove` — undo an install
- `decisionkit test` — deterministic per-tier eval of the question packs against this repo
- `decisionkit matrix` — per-host capability matrix

## Tiers

| Tier | What it does |
|---|---|
| 1 Guardrail | blocks destructive tool calls (calibrated, steer-not-silent) |
| 2 Routing | deletes LLM turns for mechanical prompts (pi adapter only) |
| S0 Context | repo digest assembled pre-turn, cache-stable, on every host |
| 2.5 Triage | stubs irrelevant reads, scopes reads, `decisionkit_locate` ranking |
| 3 Critic | flags failed tool results in ~100ms |

Question wording + thresholds are **data** (`src/question-packs/`), pre-calibrated centrally and per coding agent (`src/question-packs/agents/<host>.json`). Precedence: `DECISIONKIT_PACK` (explicit override) > shipped agent-calibrated default.

## Subpath exports

- `decisionkit-core/host-hook` — JSON-on-stdin host hook handler
- `decisionkit-core/mcp` — `decisionkit_locate` MCP stdio server

## Shipped agent skills

Two agent-facing skills ship inside this package (`src/skills/`, published in `dist/skills/`). `decisionkit-cli init` copies them into the host's skills directory where one is verified (`kilo` → `.kilo/skills/`, `claude` → `.claude/skills/`, `opencode` → `.opencode/skill/`); pi and codex have no verified skills surface, so agents use the shipped copies in `dist/skills/` (npm: `node_modules/decisionkit-core/dist/skills/`). `remove` deletes the installed copies.

| Skill | What it does | When to use |
|---|---|---|
| `decisionkit-calibrate` | Calibrates the question pack for a repo: probes with eval sets, mutates wording/thresholds under holdout discipline, writes the winner to `.decisionkit/pack.json` (auto-loaded by the adapters) + a calibration report. | A gated tier fails `decisionkit test` on a repo, or an explicit override is wanted. Policy unchanged: a per-repo pack is an override; default-pack failures are fixed centrally. |
| `decisionkit-bench-fixture` | Authors a bench fixture for a repo: known-answer task, 2–3 shipped prompts, deterministic `verify()` pass/fail (gate only unambiguous facts; borderline is discretionary) + report gates, with a verify sanity check before paying for runs. | Benchmarking on a repo with no shipped fixture (`bench/run.ts --fixture <name>`). |

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

## License

MIT
