# DecisionKit

<p align="center"><b>A decision layer, pre-calibrated per coding agent, that deletes slow, expensive LLM turns.</b></p>

## Why it exists

Coding agents spend frontier-model turns on work that needs no generation: gating a `bash` command, re-reading files, discovering the repo from scratch, noticing a failed tool call. DecisionKit moves those judgments to cheap, fast, typed calls (~100ms) and logs every decision to a receipts ledger you can inspect. The frontier LLM only does work that actually requires generation.

**The headline: turn deletion.** On pi, mechanical prompts ("read package.json") skip the LLM entirely — measured ~8× faster on that turn class. On every host, S0 assembles repo context *before* the frontier's first turn, deleting discovery round trips (measured ↓2–4× input tokens on real tasks).

## Tiers

| Tier | What it does | Mechanism |
|---|---|---|
| 1 Guardrail | blocks destructive tool calls (calibrated) | `bash`/tool gate, steer-not-silent, static read-only fast path |
| 2 Routing | deletes LLM turns for mechanical prompts (pi only) | turn intercept → tool executed directly |
| S0 Context | assembles repo context BEFORE the frontier's first turn | local sweep (terms → fan-out → candidate cards → outlines, 0 model calls) + one batched typed call; digest injected pre-turn, cache-stable |
| 2.5 Triage | stubs irrelevant reads, scopes reads, `decisionkit_locate` ranking | tool-result rewrite + tool, phase-aware + caches |
| 3 Critic | flags failed tool results in ~100ms | corrective note injected, non-empty fast path |
| Receipts | every decision logged with probabilities, latency, tokens | JSONL (`.decisionkit/receipts.jsonl`) + session entries |

Question wording + thresholds are **data** (`packages/core/src/question-packs/`), pre-calibrated centrally and **per coding agent** (`question-packs/agents/<host>.json`). Precedence: `DECISIONKIT_PACK` (explicit override) > shipped agent-calibrated default. System 1 fails open: if DecisionKit is slow or down, the agent behaves exactly like baseline — fail-opens are reported as a metric, never hidden.

## Quick start

```sh
cd your-repo
npx decisionkit-cli init              # detects (or --agent asks) your harness, installs the adapter
echo "TYPESAFE_API_KEY=…" >> .env     # DecisionKit reads .env from the repo root automatically
```

Restart your agent. Done — guardrail, S0 context, triage, critic, and receipts are live. See "Installing" below for the full host → install-target table.

No TypeSafe key? `OPENROUTER_API_KEY` works as a fallback transport with the same questions schema — e.g. a coding agent that already runs on OpenRouter is reused with zero extra setup.

### Quick win: one prompt that shows it off

S0 pays off most on discovery-heavy prompts. Paste this into your agent, in any repo:

```text
Audit this repo: map the entry points and data flow, list the main features, and flag the top 5 risks — with file:line anchors for everything.
```

Why this prompt: the baseline burns a dozen discovery turns re-reading the repo before it can answer; with DecisionKit the digest is assembled before the frontier's first turn (local sweep, then one batched typed call), so the frontier starts with the map already drawn. Measured on real tasks: ↓2–4× input tokens, ↓13–45% cost per session, with `file:line` anchors throughout.

## Installing — one command for all five hosts

```sh
npx decisionkit-cli init                # auto-detects your agent (pi, opencode, kilo, claude, codex)
npx decisionkit-cli init --agent kilo   # or pick the agent explicitly
npx decisionkit-cli remove --agent kilo # undo an install
```

`init` prints the capability matrix, installs the adapter, and tells you exactly where it landed. Restart your agent. Done — guardrail, S0 context, triage, critic, and receipts are live.

| `--agent` value | Where the adapter is installed | Turn routing feature |
|---|---|---|
| `pi` | `.pi/extensions/decisionkit/` (or `~/.pi/agent/extensions/`) | ✅ only host with a turn-intercept hook |
| `opencode` | npm plugin entry in `opencode.json` | — |
| `kilo` | npm plugin entry in `kilo.json` (or `kilo plugin <pkg>`, or drop-in `.kilo/plugin/`) | — |
| `claude` | hooks in `.claude/settings.json` + MCP in `.mcp.json` | — |
| `codex` | hooks in `.codex/hooks.json` + MCP in `.codex/config.toml` (one-time `/hooks` trust review) | — |

If multiple hosts are detected, `init` asks you to pick or you pass `--agent`. `init` also
installs the shipped agent skills — details in "Shipped agent skills" below.
Full per-tier detail: [docs/capability-matrix.md](docs/capability-matrix.md) (maintainer verification record — re-verified 2026-09-20).

## Check your repo (one command)

```sh
npx decisionkit-cli test              # all tiers, shipped eval sets, default pack
npx decisionkit-cli test --tier guardrail --runs 3
npx decisionkit-cli test --agent kilo --json   # eval an agent's shipped pack
```

Prints per-tier accuracy, gate verdicts, cluster separation with a suggested mid-gap threshold, and fail-opens. Exit 0 = defaults pass; exit 1 = a tier failed its gate. Gates check the harm direction (guardrail = block-recall, critic = fail-recall); friction is reported as advisory.

## Calibration (central, per coding agent)

There is no per-repo calibration. Packs ship pre-calibrated per coding agent — pi, opencode, kilo, claude, codex — with the tier set shaped by each host's verified hook surface (routing ships only on pi, whose input event can delete the LLM turn). Wording and thresholds are measured once on the central rigs (`packages/core/scripts`) and shipped identical across agents: the scoring model is DecisionKit's own, so a wording change ships only when it wins across all fixture classes. A wording that wins in one context but loses in another does not ship (measured: the retired per-repo calibrated routing wording scored conf 0.98–1.03 on a natural prompt the shipped default passes at 0.58–0.65).

If a tier fails its gate on your repo, that is a default-pack bug: fix it in the central harness, never per repo. `DECISIONKIT_PACK=<path>` stays as an explicit override for central benchmarks and experiments.

## Measured field results, runs 4–6 — S0 on a focused code-change prompt (A/B, 2026-09-21)

Three more independent A/B sessions (runs 4–6) on the same outbidlaunch Astro/Cloudflare leaderboard app as the 2026-09-20 section below, same repo both arms, one prompt in both arms: a focused code change — *"fix the issue of having greenland and some other countries are not showing in 3d map (don't edit anything else like changing how ocean or water in earth)"*. Both arms ran on **pi** — already the famously minimal harness — so this is debloating an already-minimal baseline, not trimming a bloated one. Model: `openrouter/z-ai/glm-5.3-flash:low`. Raw per-run metrics: `.bench-run/run{4,5,6}-{base,s0}-pA.json`. ↑ = session-cumulative input tokens.

| Metric | with DecisionKit | baseline | headline |
|---|---|---|---|
| ↑ input tokens | 4.5k / 7.4k / 10.6k | 50.9k / 57.7k / 26.6k | **↓ 2.5–11×** — the digest deletes discovery re-sends |
| LLM turns | 5 / 5 / 3 | 17 / 19 / 8 | **↓ 2.7–3.8×** |
| Wall clock | 27.9 / 23.6 / 23.8 s | 76.0 / 109.0 / 53.2 s | **↓ 2.2–4.6×** |
| $ per session (provider-reported) | 0.0010 / 0.0012 / 0.0011 | 0.0068 / 0.0088 / 0.0032 | **↓ 61–85%** incl. DecisionKit tax (frontier-only ↓ 2.9–7.0×) |
| Cache-read tokens | 15.7k / 12.8k / 0 | 47.9k / 139.5k / 6.9k | s0 arm reads cached digest-first context (~10× cheaper/token) |
| Output tokens (incl. reasoning) | 1.10k / 1.05k / 0.65k | 5.01k / 4.97k / 2.80k | **↓ 4.3–4.7×** |
| Max single-turn input | 2.1k / 3.8k / 4.4k | 8.4k / 10.8k / 5.2k | no per-turn context blowout in either arm |
| Tool calls | 1 read + 1 edit + 2 bash (all 3 runs) | run 4: 1r/6e/9b · run 5: 2r/1e/16b · run 6: 2r/1e/5b | s0 lands one focused edit every time |
| Verify gate (all 10 entries + no-collateral-edit) | **3/3 ok** — VisitMap diffs +2/-1, +1/-1, +1/-0 | 2/3 ok — diffs +15/-10, +1/-1, **+20/-1 (run 6 failed: missing TF→ATF, edits outside the table)** | s0 never violated the "don't edit anything else" constraint |
| DecisionKit (jev) tax | $0.00019 / 0.00016 / 0.00015 | — | 4–6 calls/session, p50 427–942ms/call, p95 1040–1581ms, **0 fail-opens** |
| S0 digest | injected, 1245 chars, `s0.wasted = 0` (vs 4–5 on the 2026-09-20 runs) | — | picked exactly `world.geo.json` + `VisitMap.tsx`; s0 latency 3.5–3.8s total across 3 calls (~1.2s each) |

Honest caveats: N=1 prompt × 3 runs, one fixture class, one model (`glm-5.3-flash:low`) — the eval protocol (N≥3, ≥2 fixture classes) is still the ship gate; baseline is stock pi, already the most minimal harness around — a heavier host would likely show a larger delta, not a smaller one; the ↓13–45% cost delta of the 2026-09-20 runs became ↓61–85% here because this prompt class is a single-file edit the digest hits exactly — do not generalize the ratio; baseline's 2/3 verify-gate score is a single sample, not an accuracy claim; DecisionKit tax is a larger share (~12–16%) of the much smaller s0 session cost than in the 2026-09-20 runs.

## Measured field results — S0 on real pi terminal (A/B, v0.1.2 — 2026-09-20)

Three independent A/B sessions on a real fixture (an Astro/Cloudflare leaderboard app), same repo both arms, same two prompts (launch audit + a code change). Details: [docs/s0-field-results.md](docs/s0-field-results.md). ↑ = session-cumulative input tokens.

| Metric | with DecisionKit | baseline | headline |
|---|---|---|---|
| ↑ input tokens | 23k / 19k / 19k | 75k / 81k / 31k | **↓ 2–4×** — the digest deletes discovery re-sends |
| $ per session | 0.013 / 0.006 / 0.007 | 0.015 / 0.011 / 0.011 | **↓ 13–45%** |
| DecisionKit tax | $0.0003–0.0008 / session, p50 544–617ms/call | — | ~3–7% of session cost; pays for itself every time |
| Accuracy | comparable, precise `file:line` anchors | comparable | no regression observed (single sample) |

Honest caveats: N=1 per prompt per arm × 3 runs, one fixture class — direction validated, the full protocol (N≥3, ≥2 fixture classes) is still the ship gate; multi-file edit prompts left `s0.wasted = 4–5` (the biggest remaining lever); one p95 outlier of 2102ms brushes the ≤2s added-latency budget.

## Measured results (pi faux-provider bench, v0.1.1 — 2026-09-17)

| demo | baseline | with DecisionKit | headline |
|---|---|---|---|
| A routing | 2 LLM turns | **0 turns** | 2/2 turns deleted on routed prompts |
| B guardrail | ran `rm -rf ./build ../.env` | blocked, executed nothing | agent self-corrected |
| C triage | 2221 tok peak turn | **860 tok** | ~2.6× input-token divergence |
| D critic | 3 turns failure→fix | **1 turn** | critic flags failure in ~100ms |

Honest caveat: wall-clock claims aren't honest on this rig (the faux baseline pays no real API latency); turn/token deltas are the measured signal.

## Benchmark it on any repo

The `bench/` harness A/Bs the same prompt on any repo with receipts, not vibes: identical repo both arms, identical prompts, the only delta is the extension.

```sh
git clone https://github.com/fastlaunch/outbidlaunch.git tested-repo   # or --repo ./my-app / --clone <url>
npx tsx bench/smoke.ts "audit this repo: entry points, data flow, top 5 risks"   # near-free digest dry-run
npx tsx bench/run.ts "audit this repo: entry points, data flow, top 5 risks"     # real A/B (real spend)
npx tsx bench/report.ts                                                # aggregate distributions
```

Details and fixtures: [bench/README.md](bench/README.md). To add a fixture for
your own repo (shipped prompts + a deterministic verify pass/fail), use the
`decisionkit-bench-fixture` skill shipped with core
(`packages/core/src/skills/decisionkit-bench-fixture/`). The scripted four-demo
benchmark (routing / guardrail / triage / critic) is `bench/demo-vite/`, with a
zero-cost faux-provider variant in `packages/pi-ext/bench/faux-provider.ts`.

## Shipped agent skills

`decisionkit-core` ships two agent-facing skills (source: `packages/core/src/skills/`, published in `dist/skills/`). `npx decisionkit-cli init` copies them into your host's skills directory where one is verified (`kilo` → `.kilo/skills/`, `claude` → `.claude/skills/`, `opencode` → `.opencode/skill/`); pi and codex have no verified skills surface, so point your agent at the shipped copies in `node_modules/decisionkit-core/dist/skills/`. `remove` deletes the installed copies.

| Skill | What it does | When to use |
|---|---|---|
| `decisionkit-calibrate` | Calibrates the question pack for your repo: probes with eval sets, mutates question wording/thresholds under holdout discipline (70/30 cal/val split, ≤6 wording variants, max 10 iterations), writes the winner to `.decisionkit/pack.json` (auto-loaded by every adapter) and a report to `.decisionkit/calibration-report.md`. | A gated tier fails `npx decisionkit-cli test` on your repo, or you explicitly want to try to beat the shipped default. Policy unchanged: a per-repo pack is an explicit override — if the default fails its gate, that is still a default-pack bug to fix centrally. |
| `decisionkit-bench-fixture` | Authors a bench fixture for your repo: picks a known-answer task, writes the 2–3 shipped prompts, and builds the deterministic `verify()` pass/fail (hard gate on unambiguous facts, borderline recorded as discretionary, "don't edit anything else" constraints) plus report gates — including the sanity check that verify fails on the pristine repo and passes on a hand-applied fix. | You are benchmarking DecisionKit on a repo with no shipped fixture (`bench/run.ts --fixture <name>`). Without a fixture the bench still runs, but verify reports `n/a — metrics only`. |

Use them by asking your agent by name ("use the `decisionkit-bench-fixture` skill to add a fixture for this repo") or by pointing the agent at the `SKILL.md` path.

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

| package | purpose |
|---|---|
| `decisionkit-cli` | npx entry (`init` / `remove` / `test` / `matrix`) |
| `decisionkit-core` | host-agnostic tiers, question packs, receipts ledger, hook + MCP surfaces, shipped agent skills |
| `decisionkit-pi-ext` | pi extension adapter (single-source, also used by the bench drop-in) |
| `decisionkit-opencode-plugin` | opencode plugin adapter |
| `decisionkit-kilo-plugin` | Kilo plugin adapter |
| `decisionkit-demo` | standalone mini-agent showcase (`npx decisionkit-demo`) |

## Development

```sh
npm install
npm run build --workspace packages/core   # pi-ext resolves built dist/, not source
npm run typecheck
npm run test
```

Benchmark and calibration rigs live in [`bench/`](bench/README.md) and `packages/core/scripts/`; `bench/fixtures/` shows how to add a preset for your repo.

## Roadmap: context routing with jev

The shipped v0.1.x bolts onto a frontier loop it doesn't own — every decision rides a frontier turn or adds serial latency, and savings are capped by digest hit-rate on an uncontrolled prompt distribution. The next architecture **owns the loop**: turns assembled from the cheapest sufficient context, parallel jev waves instead of serial tax, replayable offline from receipts. The hard problem is cache invalidation (provider caches key on the exact prompt prefix), so the design keeps a stable, append-only context spine and treats re-prefixing as a priced failure mode. Stated costs: deeper host coupling, wrong picks compound within a planned batch, per-agent calibration (central harness — already the shipped model for question packs). Status: design proposal with falsification gates — not shipped. Details: [docs/design/context-routing.md](docs/design/context-routing.md).

## Honest-claims policy

- All published numbers come from measured runs; no projections.
- Pin `jev-1.13.0` for benchmarks; note alias drift risk.
- The TypeSafe API is the preferred transport; OpenRouter Decisions is the fallback (same schema).
- DecisionKit cannot generate — it selects, gates, and scores. The LLM does all reasoning and writing.
- Failure mode, stated plainly: System 1 must never take the agent down.

## License

MIT
