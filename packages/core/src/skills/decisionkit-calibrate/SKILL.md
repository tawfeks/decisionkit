---
name: decisionkit-calibrate
description: Calibrate the DecisionKit question pack for the current repository. Use when the user asks to calibrate, tune, or fit DecisionKit to this repo — probes the repo with eval sets, mutates question wording/thresholds, and writes .decisionkit/pack.json.
---

# DecisionKit question-pack calibration

You are calibrating the DecisionKit question pack for THIS repository. DecisionKit is the
System-1 layer (guardrail / routing / triage / critic) that runs typed
judgments via the `decisionkit` CLI. Your job: mutate a copy of the question
pack so the eval verdict passes on this repo's eval set — or conclude the
shipped default is already fine.

## Rules (hard, do not violate)

1. **Never edit the shipped default pack.** Work on a copy of the shipped
   pack data (for an npm install: `node_modules/decisionkit-core/dist/question-packs/`;
   in this repo: `packages/core/src/question-packs/`) and write the calibrated
   result to **`.decisionkit/pack.json`** — exactly this path, one combined pack file
   `{"version":1,"guardrail":{…},"routing":{…},"triage":{…},"critic":{…},"locate":{…}}`
   (validate shape with the same schema the CLI enforces; it rejects invalid
   packs). This path is the contract: the harness adapters auto-load
   `.decisionkit/pack.json` from the target repo's root when present, so no extra
   configuration is needed after calibration. Use `DECISIONKIT_PACK=<path>` only to
   point at a non-canonical pack (e.g. an experiment) — never as the primary
   way to ship a calibrated pack.
2. **Holdout discipline.** Split the eval set: calibrate on ~70% of cases
   (write `.decisionkit/eval-cal.json`), validate on the remaining ~30%
   (`.decisionkit/eval-val.json`, same schema as the shipped sets, both via `--set`).
   A pack only ships if it wins on the VALIDATION set too. If you changed
   the eval split this session, say so in the report.
3. **≤6 wording variants per question.** Track variants tried per question;
   stop mutating a question after 6 distinct wordings.
4. **Margins.** The repo pack must beat the shipped default's accuracy on the
   validation set by ≥5 percentage points, or the answer is "default is fine".
5. **Threshold placement.** Place thresholds mid-gap between measured clusters
   (the CLI prints `suggested threshold` from the measured separation), never
   at cluster edges. If separation reports OVERLAPPING, mutate wording —
   threshold moves cannot fix overlap.
6. **Gate the harm direction.** For guardrail, the gate is block-recall (every
   dangerous command must block); over-blocks are advisory. For critic, the
   gate is fail-recall; false fires are advisory. Do not "fix" a gate by
   trading safety for friction.
7. **Max 10 calibration iterations.** An iteration = one wording/threshold
   mutation + one eval run. After 10 without passing gate + margin, stop and
   report best-so-far.

## Tools

- Verdict per tier:
  `npx decisionkit-cli test --tier <routing|triage|guardrail|critic> [--pack .decisionkit/pack.json] [--set .decisionkit/eval-cal.json] [--runs 3] --json`
- Omit `--tier` to run all four shipped sets. `--runs 3` majority-votes out
  API jitter; use it for final validation, `--runs 1` while iterating.
- The `--json` output contains per-tier accuracy, gates, advisories
  (overBlockRate / falseFireRate), separation (posMin, negMax,
  suggestedThreshold), failures with per-case scores, and fail-opens. Read the
  failures and separation BEFORE mutating — mutate the specific question whose
  cluster overlaps or whose cases miss.
- Requires `TYPESAFE_API_KEY` in the environment. Each iteration costs real
  API calls (~30–60 per full run); keep iterations purposeful.

## Procedure

1. Baseline: run `npx decisionkit-cli test --runs 3 --json` (shipped default, all
   tiers). Record accuracy + separation per tier.
2. For each tier failing its gate (or above margin potential), inspect
   `failures` and `separation` in the JSON, then mutate ONE thing per
   iteration: a question wording (plain phrasing, no hedged reasoning paths,
   no negations) or a threshold (only if separated — move to mid-gap).
3. Re-run the tier's cal set. Keep the mutation only if the cal set improves;
   otherwise revert and try a different wording.
4. When a tier looks good on cal, validate on the holdout set
   (`--set .decisionkit/eval-val.json --runs 3`).
5. Stop when: all gated tiers pass AND the pack beats default by the margin on
   holdout — OR after 10 iterations.
6. Wire the winning pack (see "Wire it" below) and verify it live.

## Report (end product, save to `.decisionkit/calibration-report.md`)

- Baseline vs final: per-tier accuracy, gates, advisories, fail-opens, latency.
- Chosen wording variants (before → after) and final thresholds.
- Separation numbers (posMin/negMax per tier) proving mid-gap placement.
- Verdict per tier: "calibrated pack ships" (with the pack path to set as
  `packPath` in the harness config) or "default is fine".
- The receipts: iteration count, eval runs, which mutations were reverted.

## Wire it (final step — do not skip)

If the verdict is "calibrated pack ships", make the operating harness actually
USE the pack; a report alone changes nothing:

1. **Write the pack to `.decisionkit/pack.json`** in the target repo's root if it
   isn't there already (the calibration rules require exactly this path).
   That is the whole wiring for pi / the DecisionKit drop-in: the adapter auto-loads
   `.decisionkit/pack.json` from its working directory at startup — no env var, no
   config edit. `DECISIONKIT_PACK` exists only as an override for non-canonical
   packs; don't set it for the normal flow.
2. **Programmatic config**: `packPath` in the `DecisionKitConfig` object (adapters
   accept it via `options.decisionkit` / plugin config). Custom packs are loaded with
   `loadPackFile()` from `decisionkit-core`.
3. **Verify the wiring**, not just the eval: run one prompt the calibrated
   wording fixed (from your failures list) through the live harness and
   confirm the receipt in the ledger shows the new decision — eval passing
   with the pack still not loaded is the failure mode this step prevents.
4. If the verdict is "default is fine", delete any stale `.decisionkit/pack.json` so
   the harness falls back to the shipped default, and say so in the report.
