# Bench — benchmark DecisionKit against stock pi on any repo

Every script here A/Bs the same question with receipts, not vibes: identical
repo, identical prompts, the only delta between arms is the DecisionKit
extension. Artifacts are kept per run and aggregated by `report.ts`.

```
bench/
  run.ts                   generic A/B rig — works on any repo
  report.ts                aggregates run artifacts into distributions + gates
  smoke.ts                 digest-only probe (no frontier, near-free dry run)
  fixture-api.ts           the fixture contract (repo + prompts + verify + gates)
  fixtures/                shipped fixture presets
    outbidlaunch.ts        the real-task fixture (Astro/Cloudflare leaderboard)
  demo-vite/               scripted A–D demo rig (vite @ a pinned commit)
  dropin/                  the pi extension drop-in both rigs install
```

The zero-cost faux-provider bench (Demo A–D shapes, real DecisionKit calls +
faux frontier) lives with the pi extension adapter it drives:
`packages/pi-ext/bench/faux-provider.ts`.

## Prereqs

- node 20+, git
- a pi build: `pi/packages/coding-agent/dist/bundle/cli.js` (the workspace `pi/` clone, built)
- keys in the workspace `.env`: `TYPESAFE_API_KEY` for DecisionKit, plus a
  frontier provider key for pi itself (e.g. `ANTHROPIC_API_KEY`)

**Cost warning: every prompt runs real LLM calls on both arms.**

## Quickstart (any repo)

```sh
# 1. give the rig a repo — any of:
git clone https://github.com/fastlaunch/outbidlaunch.git tested-repo   # shipped fixture repo
# … or pass it directly: --repo ./my-app   or   --clone <git-url>

# 2. dry-run the digest first (near-free; no frontier model)
npx tsx bench/smoke.ts "the 3d map is missing some countries, fix it"

# 3. the real A/B — paste the prompt straight into the command (quote it)
npx tsx bench/run.ts "the 3d map is missing some countries, fix it"

# 4. aggregate all runs
npx tsx bench/report.ts
```

## Ways to pass the prompt

| How | Command |
|---|---|
| Positional (easiest) | `npx tsx bench/run.ts "audit the launch flow and list risks"` |
| Explicit, repeatable | `npx tsx bench/run.ts --prompt "audit the flow" --prompt "find the broken import"` |
| Shipped fixture set | `npx tsx bench/run.ts --fixture outbidlaunch` |
| Fixture subset | `npx tsx bench/run.ts --fixture outbidlaunch --prompts pA,pB` |

Quotes matter: a prompt with spaces must be one argument (`"like this"`),
otherwise the shell splits it into separate arguments.

## Ways to pick the repo

| How | Example |
|---|---|
| Default | drop/clone the repo into `tested-repo/` |
| Local path | `--repo ./my-app` |
| Clone a URL | `--clone https://github.com/fastlaunch/outbidlaunch.git` |
| Pinned ref | `--clone <url> --ref <commit-or-branch>` |
| Shipped fixture (pinned repo + prompts + fix-quality verify + gates) | `--fixture outbidlaunch` |

Without a fixture you still get full metrics (turns, tokens, wall, jev calls,
digest injection, fail-opens) — you just skip the fixture's task-success
verification, so verify shows `n/a`.

## Options

```
--runs N          runs per (prompt, arm); default 3
--arms base,s0    default both; pass --arms s0 to iterate without paying for baseline
--model <id>      frontier model (env BENCH_MODEL; default openrouter/z-ai/glm-5.3-flash:low)
--timeout-ms N    per-prompt timeout; default 300000
--dir .bench-run  artifact directory
```

Artifacts accumulate: run numbering continues across invocations, and
`report.ts` aggregates everything in `--dir`. Copy naming:
`.bench-run/run{N}-{arm}-{promptKey}/` (kept — each test is its own saved copy).

## Adding a fixture for your own repo

**Use the `decisionkit-bench-fixture` skill** — shipped with core at
`packages/core/src/skills/decisionkit-bench-fixture/` (npm installs:
`node_modules/decisionkit-core/dist/skills/`). It walks through choosing a
known-answer task, writing the 2–3 prompts, and authoring the deterministic
verify pass/fail + gates, including the sanity check (verify must fail on the
pristine copy and pass on a hand-applied fix) before you pay for runs.

Manually: copy `bench/fixtures/outbidlaunch.ts` and fill in: `name`, `clone` (URL +
optional pinned ref), `prompts`, and — for fix-quality gating — a `verify()`
that checks the repo's end state deterministically. Register it in
`bench/run.ts` (`FIXTURES`). The outbidlaunch fixture is the reference example:
10 unambiguous table entries are the gate; borderline answers are recorded as
discretionary, never gated.

## The scripted demo rig (vite)

`bench/demo-vite/` is the original scripted benchmark: vitejs/vite pinned to
one commit, demo shapes A–D (routing / guardrail / triage / critic), its own
setup with rig-generated bait files, and a cost-split report.

```sh
npx tsx bench/demo-vite/setup.ts                 # clone pin → .bench-cache/vite, build both arms
npx tsx bench/demo-vite/run.ts --runs 3          # scripted A–D sequence, both arms
npx tsx bench/demo-vite/report.ts                # distributions + cost split
```

Zero-cost variant: `BENCH_RUNS=3 npx tsx --env-file=.env packages/pi-ext/bench/faux-provider.ts`.
