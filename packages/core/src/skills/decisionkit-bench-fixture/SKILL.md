---
name: decisionkit-bench-fixture
description: Create or rewrite a bench/ fixture preset for the jev-harness A/B benchmark — turning any repo into a reproducible benchmark with a shipped prompt set and a deterministic verify() pass/fail plus gates(). Use when the user wants to benchmark DecisionKit on a new repo, add a fixture for their own repo, author bench prompts, or define fix-quality pass/fail criteria. Not for running the bench (use bench/run.ts directly) or for calibrating question packs (use decisionkit-calibrate).
---

# Authoring a bench fixture

You are creating a fixture preset under `bench/fixtures/` so
`npx tsx bench/run.ts --fixture <name>` benchmarks a specific repo end-to-end:
pinned clone source, shipped prompts, deterministic task-success `verify()`,
and gate verdicts in `bench/report.ts` output.

Reference example (read it first, mirror its structure exactly):
`bench/fixtures/outbidlaunch.ts`. Contract: `bench/fixture-api.ts` (`Fixture`,
`FixturePrompt`, `VerifyResult`, `GateRun`). Registration point: `FIXTURES`
in `bench/run.ts` (~line 46).

## Step 1 — Study the repo and pick a benchmark task

Before writing anything, read the target repo enough to answer:

1. What is a **mechanical, single-spot defect or change** with a **known,
   unambiguous correct answer**? Good classes: a missing table entry/mapping,
   a missing import/export, a constant that must change, a config key absent,
   a documented API not wired. Bad classes: anything where "correct" is
   subjective, multi-solution, or graded by taste.
2. Where does the change land (exact file, exact region)? You need a
   **narrow allowed-edit region** to write the "don't edit anything else"
   constraint check.
3. What protected files/regions must remain untouched? These become
   byte-identical or diff-scoped checks.

If no such task exists in the repo, stop and tell the user: a fixture needs a
known-answer task; a purely exploratory prompt gets metrics-only (no verify),
which the rig already supports without a fixture.

## Step 2 — Write the prompt set (2–3 prompts)

Write 2–3 phrasings of the same task (the outbidlaunch fixture uses 3: `pA`,
`pB`, `pC`). Rules:

- **Natural, user-voiced wording** — how a real user would phrase it, including
  one loosely-phrased and one constraint-carrying variant. Never "add these 10
  exact entries" (that tests diffing, not the agent); the task must require
  *discovery* (find which entries are missing) so the A/B measures discovery
  turns.
- **Constraints go in the prompt only when they are the thing being tested.**
  outbidlaunch `pA` carries "don't edit anything else" precisely so the
  baseline's collateral-edit behavior is measured against s0. Keep at least one
  prompt constraint-free so a baseline that solves it honestly still passes.
- Keys are `pA`, `pB`, … — they become artifact file names
  (`run{N}-{arm}-{pA}.json`).
- Record the **known answer** in the header comment: what exactly is
  missing/broken, where, and what the correct end state is. Cite counts you
  verified (e.g. "180 features, table size 191, missing 10").

## Step 3 — Write verify() — the pass/fail stage

Signature: `verify(copyDir: string, editedFiles: string[], pristineDir: string):
VerifyResult`. It runs after each arm finishes, on a fresh run copy, against an
unmutated pristine copy. It must be **deterministic**: `readFileSync` +
regex/parse + `spawnSync("diff", …)`. Never call an LLM, never hit the
network, never depend on wall-clock.

Structure it in three layers, like `outbidlaunch.ts`:

**a) Required gate (hard pass/fail).** The unambiguous known answer only.
Parse the artifact the task targets and assert every required element exists.
Rules:
- Gate **only** on facts every honest solution must produce. Anything
  borderline — an alternate fix, an edge case where the baseline itself flips
  run-to-run, a judgment call — is **discretionary, never gated** (Kosovo /
  Antarctica / `-99` in outbidlaunch). This is the single most important rule:
  a gate the baseline sometimes legitimately fails on a judgment call measures
  the judge, not the agent.
- Parse leniently on format, strictly on presence (e.g. regex the table
  entries, not exact whitespace).

**b) Discretionary record.** A `Record<string, unknown>` of
interesting-but-nongating observations. Always populated, never contributes
to `ok`.

**c) Constraint checks ("don't edit anything else").** Recorded in
`constraint` and combined into `ok`:
- `editedFiles` ⊆ allowed file set (strip leading `./`).
- Protected files byte-identical to pristine (`statSync` size +
  `readFileSync(...).equals(...)`).
- Soft diff signal: `spawnSync("diff", ["-u", pristineFile, copyFile])`, count
  `+`/`-` lines, and flag removals **outside** the allowed region — this is
  the collateral-edit violation signal. If diff/parse data is unavailable,
  record `added/removed = -1` and `removedOutsideTable=false` as unknown — a
  soft check's absence of data is recorded, never fatal.

Return shape:
`{ ok, required: "human-readable pass/MISSING…", discretionary, constraint: "human-readable summary" }`.
`ok = requiredPass && constraintPass`.

## Step 4 — Write gates()

`gates(runs: GateRun[])` prints PASS/FAIL lines from run artifacts. Rules:
- Header comment states the **baseline reference numbers** you observed
  (e.g. "baseline 8/8/9 turns, ↑31–43k") — gates are deltas against those.
- Gate on: turns ceiling, input-token ceiling, `s0Wasted` rate (<10%),
  `s0FailOpens` (<5%), and verify pass rate (must be 100% of s0 runs).
- If no s0-arm runs exist, print "gates not evaluable" and return — don't
  crash.
- Print the base arm's verify pass rate as an informational line, not a gate.

## Step 5 — Register and sanity-check verify()

1. Add the fixture to `FIXTURES` in `bench/run.ts`.
2. **Sanity-check verify() before paying for runs** — this is the step
   everyone skips. Write a throwaway script (or a temporary fixture run) that
   calls `verify()` twice:
   - On the untouched pristine copy → must return `ok: false` with
     `required: "MISSING: …"` (the task is actually broken).
   - On a copy where you apply the known fix by hand → must return `ok: true`.
   If verify passes on the broken repo or fails on the fixed one, the fixture
   is measuring nothing. Fix it before running the A/B.
3. `npx tsx bench/smoke.ts --fixture <name> "…prompt…"` for a near-free digest
   dry run.
4. First real run: `npx tsx bench/run.ts --fixture <name> --runs 1`, then
   `npx tsx bench/report.ts`.
5. Run `npm run typecheck` — fixtures are typechecked with the workspace.
6. Only after the gates have real baseline+s0 numbers, write the observed
   baseline reference into the gates header comment.
