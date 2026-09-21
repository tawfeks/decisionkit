import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue, Questions, ScoreCriteria } from "@typesafe-ai/sdk";
import { createOpenRouterAsk, resolveProvider, type ProviderAskResult } from "./providers.js";
import {
  choiceOptions,
  loadDefaultPack,
  loadPackFile,
  s0Pack,
  type QuestionPack,
} from "./packs.js";
import {
  DEFAULT_THRESHOLDS,
  type CriticDecision,
  type GuardrailDecision,
  type DecisionKitAnswer,
  type DecisionKitConfig,
  type DecisionKitThresholds,
  type Ledger,
  type LocateDecision,
  type Receipt,
  type RoutingDecision,
  type S0AnswerDecision,
  type S0AssembleDecision,
  type S0GateDecision,
  type S0PickDecision,
  type S0SufficiencyDecision,
  type StateInput,
  type TriageDecision,
} from "./types.js";

const HARD_TIMEOUT_MS = 2000;

/**
 * One bounded retry for transient failures. The measured fragility (digest
 * lost to a single flaky s0 assemble call) came from `maxRetries: 0`: one
 * transient 422/5xx flipped a whole run to fail-open. Retries cover 408/429,
 * 5xx, and 422 (OpenRouter surfaces upstream provider flaps as 422) plus
 * connection errors; NOT the hard per-attempt timeout — an attempt that
 * already burned the full latency budget is unlikely to succeed on retry —
 * and NOT 401/403, which never recover.
 */
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set<number>([
  408, 422, 429,
  ...Array.from({ length: 100 }, (_, i) => 500 + i),
]);
const TRANSIENT_RETRY = {
  maxRetries: 1,
  backoffInitialMs: 150,
  backoffMaxMs: 1000,
  maxRetryAfterMs: 1000,
  apiTimeoutError: false,
  httpStatuses: RETRYABLE_HTTP_STATUSES,
} as const;

const asJson = (value: unknown): JsonValue => {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return String(value);
  }
};
const FAIL_OPEN_ANSWER: DecisionKitAnswer = {
  ok: false,
  latencyMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  model: "none",
  failOpen: true,
  answers: {},
};

/**
 * System-1 core: never throws, never takes the agent down.
 * Every judgment is a single batched systemOne call with a hard timeout and fail-open.
 */
export class DecisionKitCore {
  // `declare` so tsc emits no bare class fields: some loaders (pi's jiti path)
  // re-initialize fields AFTER the constructor body, wiping assignments made
  // there (this.ledger ended up undefined in the drop-in).
  declare readonly thresholds: DecisionKitThresholds;
  declare readonly pack: QuestionPack;
  declare readonly ledger: Ledger;
  private declare readonly providerKind: "openrouter" | "typesafe" | "none";
  private declare readonly timeoutMs: number;
  private declare readonly enabled: boolean;
  private declare readonly systemOne: (
    state: StateInput,
    questions: Questions,
  ) => Promise<DecisionKitAnswer>;

  constructor(config: DecisionKitConfig = {}, ledger: Ledger) {
    this.pack = s0Pack(config.pack ?? (config.packPath !== undefined ? loadPackFile(config.packPath) : loadDefaultPack(config.host)));
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...this.pack.thresholds, ...config.thresholds };
    this.ledger = ledger;
    this.enabled = config.enabled ?? (process.env.DECISIONKIT_ENABLE !== "0");
    this.timeoutMs = config.timeoutMs ?? HARD_TIMEOUT_MS;
    if (!this.enabled) {
      this.providerKind = "none";
      this.systemOne = async () => FAIL_OPEN_ANSWER;
      return;
    }
    let ask: ((state: StateInput, questions: Questions) => Promise<ProviderAskResult>) | undefined;
    try {
      const provider = resolveProvider(config);
      if (provider === undefined) {
        // No API key or bad provider config — fail open permanently for this instance.
        this.providerKind = "none";
        this.systemOne = async () => FAIL_OPEN_ANSWER;
        return;
      }
      this.providerKind = provider.kind;
      if (provider.kind === "openrouter") {
        ask = createOpenRouterAsk(provider, this.timeoutMs, config.fetch ?? globalThis.fetch);
      } else {
        const client = new TypeSafeClient({
          timeout: this.timeoutMs,
          retry: TRANSIENT_RETRY,
          ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
          apiKey: provider.apiKey,
          ...(provider.baseURL !== undefined ? { baseURL: provider.baseURL } : {}),
        });
        const model = provider.model;
        ask = async (state, questions) => {
          const { answers, usage, model: used } = await client.systemOne({ state, questions, model });
          return { answers: answers as Record<string, unknown>, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, model: used };
        };
      }
    } catch {
      this.providerKind = "none";
      this.systemOne = async () => FAIL_OPEN_ANSWER;
      return;
    }
    this.systemOne = async (state, questions) => {
      const started = Date.now();
      try {
        const result = await ask(state, questions);
        return {
          ok: true,
          latencyMs: Date.now() - started,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          model: result.model,
          failOpen: false,
          answers: result.answers,
        };
      } catch (err) {
        if (process.env.DECISIONKIT_DEBUG === "1") {
          console.error("[decisionkit] systemOne failed:", err);
        }
        return { ...FAIL_OPEN_ANSWER, latencyMs: Date.now() - started };
      }
    };
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Raw fail-open batched call for host-specific tiers (e.g. locate ranking). */
  async ask(state: StateInput, questions: Questions): Promise<DecisionKitAnswer> {
    return this.systemOne(state, questions);
  }

  private receipt(
    tier: Receipt["tier"],
    answer: DecisionKitAnswer,
    decision: string,
    detail?: Record<string, unknown>,
  ): Receipt {
    const receipt: Receipt = {
      ts: new Date().toISOString(),
      tier,
      decision,
      latencyMs: answer.latencyMs,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      model: answer.model,
      ok: answer.ok,
      ...(answer.failOpen ? { failOpen: true } : {}),
      ...(detail !== undefined ? { detail } : {}),
    };
    return receipt;
  }

  async guardrail(input: {
    tool: string;
    toolInput: unknown;
    recentAssistantIntent?: string;
  }): Promise<GuardrailDecision> {
    if (!this.enabled) {
      return { action: "allow", receipt: this.receipt("guardrail", FAIL_OPEN_ANSWER, "disabled") };
    }
    const answer = await this.systemOne(
      { tool: input.tool, input: asJson(input.toolInput), intent: input.recentAssistantIntent ?? null },
      {
        destructive: noul(this.pack.guardrail.destructive!.text),
        severity: score(
          this.pack.guardrail.severity.text,
          this.pack.guardrail.severity.levels as unknown as ScoreCriteria,
        ),
      },
    );
    if (!answer.ok) {
      const receipt = this.receipt("guardrail", answer, "fail-open-allow");
      this.ledger.record(receipt);
      return { action: "allow", receipt };
    }
    const destructive = (answer.answers.destructive as { noul?: number } | undefined)?.noul ?? 0;
    const severity = (answer.answers.severity as { score?: number } | undefined)?.score ?? 0;
    const block =
      destructive > this.thresholds.guardrailDestructive && severity > this.thresholds.guardrailSeverity;
    const decision = block
      ? `block(destructive=${destructive.toFixed(2)},severity=${severity.toFixed(2)})`
      : `allow(destructive=${destructive.toFixed(2)},severity=${severity.toFixed(2)})`;
    const receipt = this.receipt("guardrail", answer, decision, { destructive, severity });
    this.ledger.record(receipt);
    if (block) {
      return {
        action: "block",
        // Terminal wording: the reason is read by the agent as its next
        // instruction. "Narrow the target and retry" (measured) invited an
        // escalation loop — the model retried command variations until one
        // slipped under the threshold. Block reasons must end the attempt.
        reason: `DecisionKit guardrail: destructive operation blocked (p=${destructive.toFixed(2)}, severity=${severity.toFixed(2)}). Do not retry this or attempt alternative commands/workarounds — ask the user to confirm exactly what should be affected.`,
        receipt,
      };
    }
    return { action: "allow", receipt };
  }

  async routing(input: {
    prompt: string;
    cwd: string;
    registeredTools: string[];
    gitStatus?: string;
    fileListing?: string[];
  }): Promise<RoutingDecision> {
    if (!this.enabled || input.registeredTools.length === 0) {
      return { action: "passthrough", receipt: this.receipt("routing", FAIL_OPEN_ANSWER, "disabled") };
    }
    if (this.pack.routing === undefined) {
      // Agent pack without the routing tier (host cannot delete the LLM turn).
      return { action: "passthrough", receipt: this.receipt("routing", FAIL_OPEN_ANSWER, "no-routing-tier") };
    }
    const options: Record<string, null> = { none: null };
    for (const tool of input.registeredTools) options[tool] = null;
    const answer = await this.systemOne(
      {
        prompt: input.prompt,
        cwd: input.cwd,
        gitStatus: input.gitStatus ?? null,
        files: input.fileListing ?? null,
      },
      {
        bestTool: choice(
          this.pack.routing.bestTool!.text,
          options,
        ),
        confidence: score(
          this.pack.routing.confidence.text,
          this.pack.routing.confidence.levels as unknown as ScoreCriteria,
        ),
      },
    );
    if (!answer.ok) {
      const receipt = this.receipt("routing", answer, "fail-open-passthrough");
      this.ledger.record(receipt);
      return { action: "passthrough", receipt };
    }
    const bestToolChoice = (answer.answers.bestTool as { choice?: string } | undefined)?.choice;
    const confidence = (answer.answers.confidence as { score?: number } | undefined)?.score ?? 0;
    const route =
      bestToolChoice !== undefined && bestToolChoice !== "none" && confidence >= this.thresholds.routingConfidence;
    const decision = route
      ? `route(${bestToolChoice},conf=${confidence.toFixed(2)})`
      : `passthrough(${bestToolChoice ?? "?"},conf=${confidence.toFixed(2)})`;
    const receipt = this.receipt("routing", answer, decision, { bestTool: bestToolChoice, confidence });
    this.ledger.record(receipt);
    if (!route) return { action: "passthrough", receipt };
    return { action: "route", tool: bestToolChoice, receipt };
  }

  async triageRead(input: {
    path: string;
    taskContext: string;
  }): Promise<TriageDecision> {
    if (!this.enabled) {
      return { action: "allow", receipt: this.receipt("triage", FAIL_OPEN_ANSWER, "disabled") };
    }
    const answer = await this.systemOne(
      { file: input.path, task: input.taskContext },
      {
        isNeeded: noul(this.pack.triage.isNeeded!.text),
        scope: choice(this.pack.triage.scope!.text, choiceOptions(this.pack.triage.scope!)),
      },
    );
    if (!answer.ok) {
      const receipt = this.receipt("triage", answer, "fail-open-allow");
      this.ledger.record(receipt);
      return { action: "allow", receipt };
    }
    const isNeeded = (answer.answers.isNeeded as { noul?: number } | undefined)?.noul ?? 1;
    const scope = (answer.answers.scope as { choice?: string } | undefined)?.choice ?? "whole";
    let decision: TriageDecision;
    if (isNeeded < this.thresholds.readRelevanceStub) {
      const receipt = this.receipt("triage", answer, `stub(noul=${isNeeded.toFixed(2)})`, { isNeeded, scope });
      this.ledger.record(receipt);
      decision = {
        action: "stub",
        reason: `[decisionkit triage] ${input.path} exists but is likely irrelevant to the current task (p=${isNeeded.toFixed(2)}). Say so only if you still need it.`,
        receipt,
      };
    } else {
      const limit = scope === "head" ? 80 : scope === "tail" ? 80 : undefined;
      const receipt = this.receipt("triage", answer, `allow(${scope},noul=${isNeeded.toFixed(2)})`, { isNeeded, scope });
      this.ledger.record(receipt);
      decision = limit === undefined ? { action: "allow", receipt } : { action: "scope", limit, receipt };
    }
    return decision;
  }

  async critic(input: {
    tool: string;
    toolInput: unknown;
    resultPreview: string;
    isError: boolean;
    /** accepted for receipt metadata only — NOT sent to the model (measured:
     * task-context priming false-fires on exploratory calls, m3-critic-policy-probe) */
    taskContext?: string;
  }): Promise<CriticDecision> {
    if (!this.enabled) {
      return { action: "ok", receipt: this.receipt("critic", FAIL_OPEN_ANSWER, "disabled") };
    }
    // Three orthogonal questions in ONE batched call (parallel evaluation —
    // the core structural advantage; latency is unchanged). `error` is the
    // visible-failure floor, `failed`+`empty` gate the empty/missing mode, and
    // their conjunction suppresses the measured compound-command false fire
    // (cat succeeds + grep legitimately finds nothing → failed 0.86 live, but
    // error 0.04 / empty 0.02 → no note). Packs without the optional questions
    // keep the single-question policy.
    const { error: errorQ, empty: emptyQ } = this.pack.critic;
    const answer = await this.systemOne(
      {
        tool: input.tool,
        input: asJson(input.toolInput),
        result: input.resultPreview.slice(0, 4000),
        isError: input.isError,
      },
      {
        failed: noul(this.pack.critic.failed!.text),
        ...(errorQ !== undefined ? { error: noul(errorQ.text) } : {}),
        ...(emptyQ !== undefined ? { empty: noul(emptyQ.text) } : {}),
      },
    );
    if (!answer.ok) {
      const receipt = this.receipt("critic", answer, "fail-open-ok");
      this.ledger.record(receipt);
      return { action: "ok", receipt };
    }
    const failed = (answer.answers.failed as { noul?: number } | undefined)?.noul ?? 0;
    const error = (answer.answers.error as { noul?: number } | undefined)?.noul;
    const empty = (answer.answers.empty as { noul?: number } | undefined)?.noul;
    // isError is a recall floor: a thrown tool error always warrants the
    // corrective note (M2 demo D path), even if the scores land low.
    const visibleError = error !== undefined && error > this.thresholds.criticError;
    const failedAndEmpty =
      failed > this.thresholds.criticFailed &&
      empty !== undefined &&
      empty > this.thresholds.criticEmpty;
    const intervene =
      input.isError ||
      visibleError ||
      (error === undefined && empty === undefined
        ? failed > this.thresholds.criticFailed // legacy pack: single-question policy
        : failedAndEmpty);
    // Receipt carries what the critic actually saw — live-vs-probe score
    // discrepancies (e.g. an `ls` listing scoring 0.95 live, 0.02 probed) are
    // only diagnosable from the recorded input/result.
    const receipt = this.receipt(
      "critic",
      answer,
      intervene ? "intervene" : "ok",
      {
        failed,
        ...(error !== undefined ? { error } : {}),
        ...(empty !== undefined ? { empty } : {}),
        toolInput: asJson(input.toolInput),
        resultPreview: input.resultPreview.slice(0, 300),
      },
    );
    this.ledger.record(receipt);
    if (!intervene) return { action: "ok", receipt };
    return {
      action: "intervene",
      note: `[decisionkit critic] This tool result likely did not do what was intended (failed=${failed.toFixed(2)}). Re-check the output before building on it.`,
      receipt,
    };
  }

  /**
   * decisionkit_locate ranking: one batched call with one noul question per candidate
   * (all evaluated in parallel and independently — the core structural advantage).
   * Replaces the earlier index-as-score rubric, which was never validated:
   * a single ordinal score cannot express per-candidate relevance.
   */
  async locate(input: { task: string; candidates: string[] }): Promise<LocateDecision> {
    const passthrough = (): LocateDecision => ({
      ranked: input.candidates,
      scores: input.candidates.map(() => 1),
      ranked_: true,
      receipt: this.receipt("locate", FAIL_OPEN_ANSWER, "fail-open-unranked"),
    });
    if (!this.enabled || input.candidates.length <= 1) return passthrough();
    const questions: Questions = {};
    input.candidates.forEach((file, i) => {
      questions[`c${i}`] = noul(
        this.pack.locate.primary!.text.replaceAll("{file}", file),
      );
    });
    const answer = await this.systemOne({ task: input.task }, questions);
    const receipt = this.receipt("locate", answer, answer.ok ? `ranked(n=${input.candidates.length})` : "fail-open-unranked");
    this.ledger.record(receipt);
    if (!answer.ok) {
      return { ...passthrough(), receipt };
    }
    const scores: number[] = input.candidates.map((_, i) =>
      Math.max(0, Math.min(1, (answer.answers[`c${i}`] as { noul?: number } | undefined)?.noul ?? 0)),
    );
    const ranked = input.candidates
      .map((file, i) => ({ file, score: scores[i] as number }))
      .sort((a, b) => b.score - a.score)
      .map((c) => c.file);
    return { ranked, scores, ranked_: true, receipt };
  }

  // ==========================================================================
  // S0 — pre-turn context assembly (plan-v3 §2.1). Facts-only judgment calls
  // over locally-gathered state; the host (pi-ext s0.ts) owns all local work
  // (term extraction, fan-out, cards, verification, digest).
  // ==========================================================================

  /**
   * Batched S0 assembly (latency P1): gate + pick + pick-confidence +
   * sufficiency evaluated in ONE call over orthogonal questions — jev's
   * structural advantage. The host builds a digest draft locally first; the
   * single call decides explore / which candidate / is the draft enough.
   * Latency is one round trip (~500ms) instead of the sequential 3–5 calls it
   * replaces; token cost is one shared prefix.
   */
  async s0Assemble(input: {
    task: string;
    /** Gate state: the prompt itself, when present. */
    prompt?: string;
    cwd?: string;
    ids: string[];
    candidates: string[];
    digestSummary: string;
  }): Promise<S0AssembleDecision> {
    if (!this.enabled) {
      return { receipt: this.receipt("s0", FAIL_OPEN_ANSWER, "disabled"), confidence: 0 };
    }
    const s0 = s0Pack(this.pack);
    const options: Record<string, null> = { none: null };
    for (const id of input.ids) options[id] = null;
    const answer = await this.systemOne(
      {
        ...(input.prompt !== undefined
          ? { prompt: input.prompt, cwd: input.cwd ?? null }
          : { task: input.task }),
        candidates: input.candidates,
        digest: input.digestSummary,
      },
      {
        explore: noul(s0.s0.gate.text),
        pick: choice(s0.s0.pickFile.text, options),
        confidence: score(
          s0.s0.pickConfidence.text,
          s0.s0.pickConfidence.levels as unknown as ScoreCriteria,
        ),
        sufficiency: score(
          s0.s0.sufficiency.text,
          s0.s0.sufficiency.levels as unknown as ScoreCriteria,
        ),
      },
    );
    const exploreRaw = (answer.answers.explore as { noul?: number } | undefined)?.noul ?? 0;
    const pick = (answer.answers.pick as { choice?: string } | undefined)?.choice;
    const confidence = (answer.answers.confidence as { score?: number } | undefined)?.score ?? 0;
    const sufficiencyRaw = (answer.answers.sufficiency as { score?: number } | undefined)?.score ?? 0;
    const sufficiency = Math.max(0, Math.min(2, sufficiencyRaw));
    const acceptedPick =
      answer.ok && pick !== undefined && pick !== "none" && confidence >= this.thresholds.s0PickMin;
    const decision = answer.ok
      ? `assemble(explore=${exploreRaw.toFixed(2)},${acceptedPick ? `pick(${pick})` : "no-pick"},conf=${confidence.toFixed(2)},suff=${sufficiency})`
      : "fail-open";
    const receipt = this.receipt(
      "s0",
      answer,
      decision,
      {
        step: "assemble",
        explore: exploreRaw,
        pick,
        confidence,
        sufficiency,
      },
    );
    this.ledger.record(receipt);
    if (!answer.ok) return { receipt, confidence: 0 };
    const out: S0AssembleDecision = {
      explore: exploreRaw >= this.thresholds.s0ExploreMin,
      confidence,
      sufficiency,
      receipt,
    };
    if (acceptedPick && pick !== undefined) out.pick = pick;
    return out;
  }

  /** Gate: does this task need repo files at all? (1 jev call, or 0 when disabled.) */
  async s0Gate(input: { prompt: string; cwd: string }): Promise<S0GateDecision> {
    if (!this.enabled) {
      return { explore: false, receipt: this.receipt("s0", FAIL_OPEN_ANSWER, "disabled") };
    }
    const s0 = s0Pack(this.pack);
    const answer = await this.systemOne(
      { prompt: input.prompt, cwd: input.cwd },
      { explore: noul(s0.s0.gate.text) },
    );
    const explore = (answer.answers.explore as { noul?: number } | undefined)?.noul ?? 0;
    const decision = explore >= this.thresholds.s0ExploreMin;
    const receipt = this.receipt("s0", answer, `${decision ? "explore" : "skip"}(noul=${explore.toFixed(2)})`, {
      step: "gate",
      explore,
    });
    this.ledger.record(receipt);
    return { explore: decision, receipt };
  }

  /**
   * Pick: one choice question over candidate ids (+none) with an orthogonal
   * confidence score, in ONE batched call. `ids` are the short choice options
   * (matched back to candidates by the host); `candidates` are the compact
   * card descriptions carried in the state. The host calls this up to 3×
   * (excluding already-picked candidates each round) per plan-v3 §2.1.
   */
  async s0Pick(input: { task: string; ids: string[]; candidates: string[] }): Promise<S0PickDecision> {
    if (!this.enabled || input.ids.length === 0) {
      return { confidence: 0, receipt: this.receipt("s0", FAIL_OPEN_ANSWER, "disabled") };
    }
    const s0 = s0Pack(this.pack);
    const options: Record<string, null> = { none: null };
    for (const id of input.ids) options[id] = null;
    const answer = await this.systemOne(
      { task: input.task, candidates: input.candidates },
      {
        pick: choice(s0.s0.pickFile.text, options),
        confidence: score(
          s0.s0.pickConfidence.text,
          s0.s0.pickConfidence.levels as unknown as ScoreCriteria,
        ),
      },
    );
    const pick = (answer.answers.pick as { choice?: string } | undefined)?.choice;
    const confidence = (answer.answers.confidence as { score?: number } | undefined)?.score ?? 0;
    const accepted = answer.ok && pick !== undefined && pick !== "none" && confidence >= this.thresholds.s0PickMin;
    const decision = accepted
      ? `pick(${pick},conf=${confidence.toFixed(2)})`
      : `no-pick(${pick ?? "?"},conf=${confidence.toFixed(2)})`;
    const receipt = this.receipt("s0", answer, decision, { step: "pick", pick, confidence });
    this.ledger.record(receipt);
    return accepted && pick !== undefined ? { pick, confidence, receipt } : { confidence, receipt };
  }
  /** Sufficiency: is the digest enough to plan the work? (score axis none/some/high.) */
  async s0Sufficiency(input: { task: string; digestSummary: string }): Promise<S0SufficiencyDecision> {
    if (!this.enabled) {
      return { score: 0, receipt: this.receipt("s0", FAIL_OPEN_ANSWER, "disabled") };
    }
    const s0 = s0Pack(this.pack);
    const answer = await this.systemOne(
      { task: input.task, digest: input.digestSummary },
      {
        sufficiency: score(
          s0.s0.sufficiency.text,
          s0.s0.sufficiency.levels as unknown as ScoreCriteria,
        ),
      },
    );
    const raw = (answer.answers.sufficiency as { score?: number } | undefined)?.score ?? 0;
    const scoreVal = Math.max(0, Math.min(2, raw));
    const receipt = this.receipt("s0", answer, `sufficiency(${scoreVal})`, { step: "sufficiency", score: scoreVal });
    this.ledger.record(receipt);
    return { score: scoreVal, receipt };
  }

  /**
   * Answer-only tier (plan-v3 §2.2, M5, default off): is the verbatim answer
   * literally in the digest, and which line is it? Never used for
   * why/debug/prose tasks — the confidence gate plus the host's scope check
   * bound misclassification (measured in evals, not assumed).
   */
  async s0Answer(input: { task: string; digestLines: string[] }): Promise<S0AnswerDecision> {
    if (!this.enabled || input.digestLines.length === 0) {
      return { confidence: 0, receipt: this.receipt("s0", FAIL_OPEN_ANSWER, "disabled") };
    }
    const s0 = s0Pack(this.pack);
    const options: Record<string, null> = { none: null };
    input.digestLines.forEach((_line, i) => {
      options[`L${i}`] = null;
    });
    const answer = await this.systemOne(
      { task: input.task, digest: input.digestLines.join("\n") },
      {
        present: noul(s0.s0.isAnswerPresent.text),
        line: choice(s0.s0.answerLine.text, options),
      },
    );
    const present = (answer.answers.present as { noul?: number } | undefined)?.noul ?? 0;
    const lineIdxRaw = (answer.answers.line as { choice?: string } | undefined)?.choice;
    const lineIdx = lineIdxRaw !== undefined && /^L\d+$/.test(lineIdxRaw) ? Number(lineIdxRaw.slice(1)) : undefined;
    const accepted =
      answer.ok && present >= this.thresholds.s0AnswerMin && lineIdx !== undefined && lineIdx < input.digestLines.length;
    const receipt = this.receipt("s0", answer, accepted ? `answer(L${lineIdx})` : `no-answer(p=${present.toFixed(2)})`, {
      step: "answer",
      present,
      line: lineIdx,
    });
    this.ledger.record(receipt);
    if (!accepted || lineIdx === undefined) return { confidence: present, receipt };
    return { verbatim: { line: input.digestLines[lineIdx] as string, idx: lineIdx }, confidence: present, receipt };
  }
}
