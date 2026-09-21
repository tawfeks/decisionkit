import type { EntryType } from "@typesafe-ai/sdk";
import type { PackHost, QuestionPack } from "./packs.js";

export type DecisionKitTier = "guardrail" | "routing" | "triage" | "critic" | "locate" | "s0";

export interface Receipt {
  ts: string;
  tier: DecisionKitTier;
  decision: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  ok: boolean;
  failOpen?: boolean;
  detail?: Record<string, unknown>;
}

export interface LocateDecision {
  /** Candidates ordered by descending relevance probability. */
  ranked: string[];
  /** noul relevance per candidate (original candidate order). */
  scores: number[];
  ranked_: true;
  receipt: Receipt;
}

export interface DecisionKitThresholds {
  guardrailDestructive: number;
  guardrailSeverity: number;
  routingConfidence: number;
  readRelevanceStub: number;
  /** Intervene when the `failed` noul exceeds this. */
  criticFailed: number;
  /** Intervene when the `error` noul (failure visible in the result) exceeds
   * this — the recall floor for exit-code failures the `failed` wording rates
   * borderline. */
  criticError: number;
  /** The `failed`-AND-`empty` gate uses this for the `empty` noul (result has
   * no usable content). Suppresses partial-success false fires on compound
   * commands: content present + no visible error → no note. */
  criticEmpty: number;
  /** S0 gate: explore (assemble context) when the gate noul is ≥ this. */
  s0ExploreMin: number;
  /** S0 pick: accept a chosen candidate only above this confidence. */
  s0PickMin: number;
  /** S0 sufficiency floor for the score-based early break. The loop breaks
   * on score ≥ max(2, this) — i.e. HIGH by default. Mid-scale scores never
   * break: any decent first pick satisfies "enough to plan" (measured: a
   * 1-of-5-file digest shipped on "some", 4/5 frontier discoveries wasted). */
  s0SufficiencyMin: number;
  /** Answer-only (M5): answer verbatim only above this `isAnswerPresent` noul. */
  s0AnswerMin: number;
}

export const DEFAULT_THRESHOLDS: DecisionKitThresholds = {
  // Guardrail thresholds calibrated on packages/core/scripts/m2-guardrail-eval.ts
  // (12-command spectrum, 2026-09-17): destructive 0.8 missed `rm src/index.ts`
  // (noul 0.78); 0.7 catches it and keeps safe scoped cleanup (severity still
  // gates). Boundary is ragged: `rm -rf ./dist` over-blocks — measured, accepted.
  guardrailDestructive: 0.7,
  guardrailSeverity: 1.2,
  // M0 eval (2026-09-17): 1.5 routed only mechanical reads; grep/bash requests score
  // ~1.0–1.2 on the confidence axis. 1.0 hits the ≥90% gate (18/20) with no false routes.
  routingConfidence: 1.0,
  readRelevanceStub: 0.35,
  // Critic calibrated on packages/core/scripts/m2-critic-eval.ts +
  // m2-critic-wording-probe2.ts (2026-09-17), re-anchored on the M3 vite rig via
  // m3-critic-policy-probe.ts. Two wording iterations measured in M2: "did it
  // work" straddled 0.73–0.79; the anchored wording fixed that (failures
  // 0.76–0.99, oks ≤0.13) but task-context priming false-fired on the rig
  // (cat package.json during a cleanup task 0.84, silent rm "(no output)" 0.83).
  // M3 probe (real rig cases, 3 runs): dropping `task` from the critic state
  // separates true failures 0.46–0.99 (isError shapes 0.97–0.99) from oks
  // ≤0.40 — mid-gap 0.45. Threshold sits 0.45; `m3-du-exit1` (0.46–0.50)
  // straddles low — accepted, receipts still record the suspect score.
  criticFailed: 0.45,
  // Two-question critic calibration (packages/core/scripts/m4-critic-twoq-probe.ts,
  // 18 cases × 3 runs, 2026-09-18): `error` separates true visible failures
  // 0.46–0.98 from all oks ≤0.04 → mid-gap 0.25. `empty` separates empty-grep
  // (0.85–0.87) from content-bearing oks (≤0.09); 0.45 mid-gap. The
  // compound-command false fire (run-5 A0: `cat pkg.json; grep …` → live failed
  // 0.86) now passes because error=0.04, empty=0.02. `m3-rm-nooutput` scores
  // empty 0.79–0.81 but failed ≤0.08 → AND-gate keeps it quiet (measured,
  // accepted). `m3-rolldown-ts` fires on a real visible typecheck error —
  // advisory-only ground truth, accepted like wrong-file-read.
  criticError: 0.25,
  criticEmpty: 0.45,
  // S0 defaults are conservative per plan-v3 §5: prefer fail-open over a wasted
  // digest. Gate 0.5 (unclear prompts skip assembly); picks accepted ≥0.7;
  // sufficiency needs at least "some"; answers verbatim only at high confidence.
  s0ExploreMin: 0.5,
  s0PickMin: 0.7,
  s0SufficiencyMin: 1.0,
  s0AnswerMin: 0.9,
};

export interface DecisionKitConfig {
  apiKey?: string;
  baseURL?: string;
  /** Force the provider ("openrouter" | "typesafe"); default resolves
   * OPENROUTER_API_KEY first (env, .env, or the host coding agent's key),
   * then TYPESAFE_API_KEY. An explicit apiKey (not sk-or-*) still routes
   * direct. */
  provider?: "openrouter" | "typesafe";
  /** Pin the model for benchmarks (e.g. "jev-1.13.0"); defaults to jev-latest via SDK env. */
  model?: string;
  timeoutMs?: number;
  enabled?: boolean;
  thresholds?: Partial<DecisionKitThresholds>;
  /** A pack assembled in code (overrides host selection and packPath). */
  pack?: QuestionPack;
  /** Explicit pack override (central benchmark/experiment) — beats host
   * selection. Normally leave unset: the shipped per-agent default loads. */
  packPath?: string;
  /** Coding agent this core instance runs under → selects the shipped
   * agent-calibrated pack (tier set per verified hook surface). */
  host?: PackHost;
  /** Injectable fetch for tests and faux harnesses. */
  fetch?: typeof fetch;
}

export interface DecisionKitAnswer {
  ok: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  failOpen: boolean;
  /** Raw answers payload from systemOne; empty object on fail-open. */
  answers: Record<string, unknown>;
}

export type StateInput = Exclude<EntryType, null>;

export interface Ledger {
  record(receipt: Receipt): void;
  all(): readonly Receipt[];
  totals(): {
    calls: number;
    failOpen: number;
    inputTokens: number;
    outputTokens: number;
    latencyMsP50: number;
    latencyMsP95: number;
  };
}

export interface GuardrailDecision {
  action: "block" | "allow";
  reason?: string;
  receipt: Receipt;
}

export interface RoutingDecision {
  action: "route" | "passthrough";
  tool?: string;
  args?: Record<string, unknown>;
  receipt: Receipt;
}

export interface TriageDecision {
  action: "allow" | "stub" | "scope";
  reason?: string;
  offset?: number;
  limit?: number;
  receipt: Receipt;
}

export interface CriticDecision {
  action: "ok" | "intervene";
  note?: string;
  receipt: Receipt;
}

export interface S0GateDecision {
  explore: boolean;
  receipt: Receipt;
}

/**
 * One batched S0 call (gate + pick + pick-confidence + sufficiency).
 * Fields are undefined when that judgment failed open / was rejected:
 * no `explore` ⇒ treat as skip; no `pick` ⇒ nothing accepted this round.
 */
export interface S0AssembleDecision {
  explore?: boolean;
  pick?: string;
  confidence: number;
  sufficiency?: number;
  receipt: Receipt;
}

export interface S0PickDecision {
  /** Chosen candidate id, or undefined when the pick is "none"/below confidence. */
  pick?: string;
  confidence: number;
  receipt: Receipt;
}

export interface S0SufficiencyDecision {
  /** 0 = none, 1 = some, 2 = high (score axis). */
  score: number;
  receipt: Receipt;
}

export interface S0AnswerDecision {
  /** Verbatim answer line + its index into the digest lines passed in. */
  verbatim?: { line: string; idx: number };
  confidence: number;
  receipt: Receipt;
}
