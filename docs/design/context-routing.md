# DecisionKit — Plan v4: a jev-native agent loop ("the agent as a decision fabric")

Status: proposal. v3 (the pi extension) stays as the evidence rig and calibration harness.
This is the architecture for a new agent whose **loop itself** is built around jev — not an
ext bolted onto pi's frontier loop.

## 0. Why the ext stopped moving the needle (measured 2026-09-19/20)

Ext arm ≈ baseline arm on real prompts. The reasons are structural, not bugs:

1. **The loop is serial and frontier-shaped.** Every decision (route, pick, verify, judge)
   rides a frontier turn or adds latency between turns. S0 deletes discovery turns only
   when the digest happens to replace them; a miss costs a full frontier re-discovery turn.
   Savings are capped by digest hit-rate on an uncontrolled distribution.
2. **The loop's cost structure is fixed by pi.** Append-everything history → prefix re-send
   every turn (↑31k for 8 turns); in-loop tools re-enter the model with full history;
   reasoning tokens are spent re-verifying things already verified (R4.6k, mostly
   zero-reasoning turns doing mechanical work).
3. **Tax layers ride serially.** Guardrail/critic/triage added ~11.3s over 18 calls because
   they sit *between* frontier turns, not beside them.
4. **One jev call is cheap; the loop's shape makes it expensive.** 3–5s serial latency and
   ~$0.0002/call is fine only if calls run in waves *concurrent with* frontier work. In the
   ext they can't, because the ext doesn't own the loop.

Conclusion: the lever was never "delete turns from a fixed loop." It is **own the loop and
change what shape the work is.** Frontier turns are the scarce serial resource; everything
else should be deterministic or jev-parallel.

## 1. Ground truths the design is built on

- **T1 — Frontier turns are the unit of cost.** A turn costs its latency (10–40s wall),
  its output/reasoning tokens, AND a re-send of the whole prefix. 8 turns ≠ 8× a 1-turn
  cost; it's superlinear in history. Fewer turns dominates every other optimization
  (cache warmth included).
- **T2 — jev is ~1000× cheaper and ~10× faster than a frontier turn** ($0.0002 vs
  ~$0.01–0.03/turn; 0.3–1s/call vs 10–40s), and its outputs are **constrained**
  (noul / choice / score): no hallucinated paths, no prose drift, no reasoning-token
  bloat. It arbitrates; it does not generate.
- **T3 — jev parallelism is embarrassingly parallel.** A choice over N candidate cards
  fans out to N independent calls; a question batch rides one systemOne round trip.
  A wave of 30 jev calls costs one call's latency and ~$0.002.
- **T4 — Ensembles of parallel cheap models beat one expensive vote.** 3 independent
  90%-accurate votes under majority rule ≈ 97% accuracy, at +0 latency (parallel) and
  +$0.0004. (Independence is an assumption — must be falsified in M1; correlated votes
  degrade to the single-vote rate.)
- **T5 — Deterministic tools are exact and free.** rg, tree-sitter outlines, diff,
  tests, wc. Models should only do what those cannot: semantics, editing, arbitration.
- **T6 — Frontier accuracy peaks on narrow contexts.** Attention dilutes over long
  prefixes; but edit quality needs the *actual file*, not a summary (the v3 blind-edit
  footgun). So: narrow context for planning, full file for the edit call, never a digest
  as the basis of an edit.
- **T7 — Frontier reasoning is scarce.** It belongs to planning, edit content, and
  ambiguity arbitration. It does not belong to discovery, verification, triage, routing,
  or lookup — all of which are classification problems jev already solves at ≥90%
  (calibrated) accuracy.

## 1.1 The pick boundary (what jev targets, and what it must not)

The whole v4 bet is that pick accuracy holds at ≥90% on *unseen* prompts; every decision
about jev's scope flows from the asymmetry below.

- **Realistic**: file-level pick (rg fan-out → closed choice over ~30 cards → deterministic
  term-verify) and symbol-level navigation (deterministic outline + closed choice over
  symbols in the picked file). Both are classification over bounded candidate sets — the
  measured path (M1 gate).
- **Deliberately excluded**: line-level edit targeting and unbounded agentic jev search.
  Line picking is open-world semantics (intent, not matching), and the failure economics
  are asymmetric: a wrong file pick is bounded (receipt; frontier falls back to baseline
  discovery — the gain is lost, accuracy is not). A wrong edit line is unbounded (broken
  code → a frontier debug turn → the deleted turn returns with interest). jev gets the
  frontier to the right file with anchors; the frontier reads the file and picks the
  edit location (T6).
- **Bounded search only**: sufficiency loop re-sweeps with new terms, ≤2–3 waves. No
  unbounded jev-driven query loops: at 90%/hop, a 5-hop chain succeeds ~59% of the time,
  and latency accumulates per hop. Bounded waves, fail-open to the frontier.
- The realistic ceiling is implied by the measured trace: 6 of 8 turns were mechanical
  (ls/grep/read/python) — deletable in principle. 2 turns (plan, edit) are the frontier
  floor. Hence 8→2–4, not 8→0. If real-world pick accuracy lands well below 90% (say 70%),
  v4 repeats the v3 ext result — no net gain, because misses cost full re-discovery turns —
  and the binding constraint was hit-rate, not loop architecture.

## 2. Architecture: five layers

```
L0  substrate (0 calls)     file graph, symbol outlines, import closure, git state,
                            test commands, receipt ledger — maintained incrementally
                            on fs/git events, never rebuilt from scratch
L1  decision fabric (jev)   route, gate, pick, sufficiency, guardrail, critic, triage,
                            answer-present, diff-check, fix-choice — batched via
                            systemOne; fanned out in parallel waves
L2  ensemble (jev ×3)       the same question asked of 3 independent jev calls,
                            majority + confidence; only for consequential decisions
                            (pick-file, diff-accept, answer-fire)
L3  frontier executors      plan / edit / arbitrate / answer — the ONLY big-model calls,
                            each a fresh narrow context (task + digest + one file)
L4  scheduler               the loop itself: a state machine that runs L1/L2 waves
                            concurrently with L3 calls and escalates on low confidence
L5  receipts/ledger         unchanged doctrine: every decision receipted, wasted is
                            first-class, fail-open everywhere
```

Key inversion vs pi: **history is not the frontier's context.** The full history lives in
L0 as receipts and state; the frontier never sees it. Each executor call gets a fresh,
small, purpose-built context. This deletes the prefix re-send cost class entirely (T1)
at the price of cache warmth — arithmetic below says that trade wins when turns shrink
from 8 to ~3.

## 3. The loop

```
prompt
  → WAVE 0 (parallel, ~1s, ~$0.0005)
      route (jev) · local prep (0 calls: terms, fan-out, cards, outlines)
  → route says "task"
      → PLAN (frontier, fresh ctx: prompt + digest + candidate cards)   ~10–20s
  → WAVE 1 (parallel jev, hidden inside plan latency where possible)
      pick-verify ×N (ensemble) · sufficiency · edit-target risk (noul per target)
      low confidence → targeted fan-out wave, re-plan once; then fail-open to today's loop
  → per edit target (independent files may run concurrently):
      READ target file (unscoped, deterministic)
      EDIT (frontier, fresh ctx: file + anchors + constraint list)       ~15–30s
      DIFF-GATE (jev ensemble, parallel): does diff match intent? touches
      forbidden regions? deterministic: git diff + outline delta
  → VERIFY (0 frontier calls): tests/build deterministically
      fail → WAVE 2: jev fix-choice over failing output ×N hypotheses (parallel)
      fail again → escalate ONE frontier debug call (this is the loop's floor)
  → ANSWER (frontier, small) — or jev verbatim excerpt for lookup class, no frontier at all
```

Frontier calls per greenland-class prompt: **2–4** (plan, 1–2 edits, answer — often
merged). Everything else is waves that cost one call's latency each.

## 4. Where the parallelism actually is (and isn't)

Parallel: discovery fan-out, ensemble votes, per-target diff gates, fix-hypothesis waves,
S0 sweep concurrent with routing. NOT parallel: plan→edit dependency, edits touching the
same file, test runs. The wall clock therefore converges to
`max(frontier call latencies) + #serial-frontier-calls × latency + wave overhead`,
not the sum of everything.

## 5. Cost / speed / accuracy model (arithmetic on the measured session)

Greenland-class (measured baseline: 8 frontier turns, ↑31k, R4.6k, ~2.5–5 min wall):

| metric | baseline | jev-native est. | mechanism |
|---|---|---|---|
| frontier turns | 8 | **2–4** | discovery/verify/triage deleted by construction (T7) |
| ↑ in-tokens | 31k (~3.1k cached-equiv ≈ $0.01) | **10–16k with stable-prefix caching (~6k cached-equiv ≈ $0.02)** | 3 fresh ~4–6k ctxs, shared prefix across executor calls; input is NOT the lever — see cache honesty below |
| R tokens | 4.6k | ~1.5–2.5k | frontier only plans/edits; mechanical turns had zero reasoning anyway |
| wall | 2.5–5 min | **50–90s** | jev waves (≤1s each) hide inside/between 2–4 frontier calls |
| frontier $ | ~$0.10–0.15 (mostly output × 8 turns) | **~$0.06–0.09 (output × 2–4 turns; input ≈ parity)** | output tokens are the uncached lever, not input |
| jev $ | — | ~$0.001–0.002 | ~15–30 calls across waves, all parallel |
| accuracy | — | **≥ baseline** | T5/T6: deterministic verify + ensemble gates + fresh narrow edit ctx; constraint preservation becomes a diff-gate, not a hope |

Lookup-class: 1 frontier turn → **0** (jev verbatim answer wave), sub-2s, ~$0.0004.
Debug/test-fail class: −30–50% (verify loop absorbs 1–2 iterations before escalating);
this is the least certain estimate and must be measured first.

Cache honesty (corrected 2026-09-20): cache-priced input is ~10% of list price, so the
baseline's 31k at ~99% hit costs ≈3.1k-equiv ≈ $0.01 — input tokens are NOT where the
savings are, and my earlier framing over-weighted them. The savings are (a) **wall time**:
cache makes turns cheaper, not shorter — 8 serial decode latencies vs 2–4 is the win and
cache cannot buy it back; (b) **output tokens** (never cacheable, 5× price): 8 turns of
reasoning/prose vs 2–4 is most of the $ delta. Additionally, v4 executor contexts are
built **stable-prefix first** (system + digest + task, then the one file) so plan→edit→
answer share a cached prefix within a run; input cost lands ≈6k-equiv ≈ $0.02 — same
order as baseline. The rule inherited from the P0-1 fix stands: digest computed once per
run, append-only, stable block order, or the 74.9% CH regression returns.

## 6. What the frontier keeps, and why

- **Plan**: decomposition and strategy — needs world knowledge and reasoning.
- **Edit content**: code generation — T6 says give it the real file, not a digest.
- **Arbitrate**: anything the ensemble gates as low-confidence (rare).
- jev never writes code, never edits, never summarizes. It classifies, picks, scores,
  gates. Deterministic tools never model.

## 7. Escalation cascade (multi-layer decision doctrine)

Every decision climbs the cheapest layer that can answer it, and never skips a layer:

```
D0 deterministic   file exists? term in file? diff applies? test passes?  (0 ms, exact)
D1 jev single      route/gate/score — reversible decisions only           (~0.5s)
D2 jev ensemble    consequential decisions: pick, diff-accept, answer-fire (~1s, +$0.0004, ≈97% vs 90%)
D3 frontier        planning, editing, D2-tiebreak ambiguity                (seconds, dollars)
```

Fail-open at every layer: any D0/D1/D2 failure or budget breach degrades to the v3
behavior (plain pi loop), so the **worst case is today's agent + ~$0.002 and ~2s**.

## 8. Build shape

- `packages/agent` — the new loop: a state machine owning waves, escalation, budgets.
  Uses pi's SDK pieces as a library (message types, tool executors, permissions) — not a
  fork of the runner; the runner is what we're replacing.
- Reuses from v3 unchanged: `s0.json` packs, calibration rig, ledger/receipt path,
  `s0LocalPrep` (terms → fan-out → cards → outlines), tax fast-paths.
- The v3 ext remains the control arm: every v4 eval runs both arms on the same fixtures.

## 9. Stages & falsification gates

| Stage | Deliverable | Gate (kill criteria included) |
|---|---|---|
| V1 | L0 substrate + loop skeleton (D0/D3 only) | parity with baseline on greenland-class; no regression on fixture edit suite |
| V2 | L1 fabric + waves (route, pick, sufficiency, diff-gate) | frontier turns ≤4; ↑ ≤16k; wasted <10% |
| V3 | L2 ensembles on consequential decisions | ensemble accuracy > single-vote accuracy on labeled set (else drop D2 — T4 falsified) |
| V4 | verify loop (tests + fix-choice waves) | debug-class −30% turns without accuracy loss |
| V5 | lookup path (0-frontier answers) | 0 false answers, ≥90% recall |

## 10. Risks (stated, priced)

- **Ensemble correlation** (T4): jev votes may share biases → no accuracy gain, pure cost.
  Cheap to measure in V3; D2 is removable.
- **Plan misses the target**: pick accuracy compounds through planning. Mitigated by
  deterministic verify + one bounded re-plan; miss shows up as `s0.wasted` receipts.
- **Edit ctx bloat**: large files make per-target read expensive; bounded by the existing
  ≤24KB read budget and outline-guided ranged reads.
- **Scheduler complexity** is the real engineering cost of this plan; the mitigation is
  that every wave is a pure function over receipts, so the whole loop is replayable
  offline — which is also what makes V1–V5 gates cheap to run.
