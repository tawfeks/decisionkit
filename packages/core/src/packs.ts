import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DecisionKitThresholds } from "./types.js";

/** Coding agents DecisionKit ships pre-calibrated packs for. */
export type PackHost = "pi" | "opencode" | "kilo" | "claude" | "codex";

export interface NoulQuestion {
  kind: "noul";
  text: string;
}
export interface ScoreQuestion {
  kind: "score";
  text: string;
  levels: string[];
}
export interface ChoiceQuestion {
  kind: "choice";
  text: string;
  /** null = options are supplied at call time (routing: registered tools + none). */
  options: string[] | null;
}
export type PackQuestion = NoulQuestion | ScoreQuestion | ChoiceQuestion;

export interface GuardrailQuestions {
  destructive: NoulQuestion;
  severity: ScoreQuestion;
}
/** Routing ships only in packs for hosts whose input hook can delete the LLM
 * turn (pi, verified against each host's docs 2026-09-21). Optional so the
 * agent packs for claude/codex/opencode/kilo omit it entirely; callers
 * (core.routing()) fail-open passthrough when missing. */
export interface RoutingQuestions {
  bestTool: ChoiceQuestion;
  confidence: ScoreQuestion;
}
export interface TriageQuestions {
  isNeeded: NoulQuestion;
  scope: ChoiceQuestion;
}
export interface CriticQuestions {
  failed: NoulQuestion;
  /** Optional orthogonal signals (m4-critic-twoq-probe calibration). Legacy
   * calibrated packs without them keep the single-question policy. */
  error?: NoulQuestion;
  empty?: NoulQuestion;
}
export interface LocateQuestions {
  primary: NoulQuestion;
}
export interface S0Questions {
  gate: NoulQuestion;
  pickFile: ChoiceQuestion;
  pickConfidence: ScoreQuestion;
  sufficiency: ScoreQuestion;
  /** Answer-only tier (M5, behind DECISIONKIT_ANSWER_ONLY). */
  isAnswerPresent: NoulQuestion;
  answerLine: ChoiceQuestion;
}

export interface QuestionPack {
  version: number;
  guardrail: GuardrailQuestions;
  /** pi-only tier (see RoutingQuestions). */
  routing?: RoutingQuestions;
  triage: TriageQuestions;
  critic: CriticQuestions;
  locate: LocateQuestions;
  /** S0 tier. Optional so packs calibrated before S0 keep loading; callers
   * use s0Pack(pack) which fills the in-code defaults below. */
  s0?: S0Questions;
  thresholds?: Partial<DecisionKitThresholds>;
}

const S0_FALLBACK: S0Questions = {
  gate: { kind: "noul", text: "Does completing this task require reading or changing files in this repository? Answer no only for pure conversation, general knowledge questions, or opinions that need no repo access." },
  pickFile: { kind: "choice", text: "Given the digest above, which single candidate file is most likely still needed for this task? Answer none only if no candidate could contain anything the task needs beyond what the digest already covers.", options: null },
  pickConfidence: { kind: "score", text: "How confident are you that the chosen candidate is needed for this task?", levels: ["none", "some", "high"] },
  sufficiency: { kind: "score", text: "Does this digest cover the files needed for the WHOLE task, so the work could be finished without further repo discovery (listing or searching to locate files)? Reading the listed files again later is expected; having to discover unlisted files is not. Rate the digest as a whole.", levels: ["none", "some", "high"] },
  isAnswerPresent: { kind: "noul", text: "Is the complete, verbatim answer to the task literally present in this digest — not derivable, not requiring reasoning or any further file access?" },
  answerLine: { kind: "choice", text: "Which digest line contains the verbatim answer? Answer none if no single line is the complete answer.", options: null },
};

/** Pack with the S0 tier guaranteed (in-code defaults when the pack predates S0). */
export function s0Pack(pack: QuestionPack): QuestionPack & { s0: S0Questions } {
  return pack.s0 !== undefined ? (pack as QuestionPack & { s0: S0Questions }) : { ...pack, s0: S0_FALLBACK };
}

/** Shipped default calibration (v0.1.2): the canonical combined pack embedded
 * in code — the folder itself is NOT shipped in the npm packages. Primary
 * source stays the per-tier question-packs/*.json files plus the per-agent
 * packs in question-packs/agents/ (calibrated centrally, per coding agent);
 * this fallback is behavior-identical to the canonical pack file so System 1
 * never goes down over a missing data file. S0 questions are filled by
 * s0Pack() below; the critic's orthogonal `error`/`empty` questions are
 * optional and legacy packs keep the single-question policy. */
const FALLBACK: QuestionPack = {
  version: 1,
  guardrail: { "destructive": { "kind": "noul", "text": "Could this cause destructive, hard-to-reverse side effects?" }, "severity": { "kind": "score", "text": "How much harm if unintended?", "levels": ["none", "minor", "serious"] } },
  routing: {
    "bestTool": { "kind": "choice", "text": "Which registered tool fully handles this request without LLM reasoning?", "options": null },
    "confidence": { "kind": "score", "text": "Confidence that the tool fully resolves it with no further reasoning?", "levels": ["none", "some", "high"] }
  },
  triage: { "isNeeded": { "kind": "noul", "text": "Is this file needed for the current task?" }, "scope": { "kind": "choice", "text": "Read whole file, head, tail, or a line range?", "options": ["whole", "head", "tail", "range"] } },
  critic: {
    "failed": { "kind": "noul", "text": "Did this tool call fail, error, or otherwise not accomplish what it was invoked to do? Answer yes only if the result itself shows an error, an empty/missing outcome, or incomplete execution — not merely because the output is unremarkable." }
  },
  locate: { "primary": { "kind": "noul", "text": "Is \"{file}\" the primary file for this task? Prefer implementation and documentation files over tests and fixtures." } }
};

const TIERS = ["guardrail", "routing", "triage", "critic", "locate", "s0"] as const;

function parseTierQuestions<T>(raw: unknown, required: Partial<Record<keyof T, PackQuestion["kind"]>>): T {
  if (raw === null || typeof raw !== "object") {
    throw new Error("pack tier is not an object");
  }
  const out: Record<string, PackQuestion> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") {
      throw new Error(`pack question ${key} is not an object`);
    }
    const q = value as Record<string, unknown>;
    if (q.kind === "noul" && typeof q.text === "string") {
      out[key] = { kind: "noul", text: q.text };
    } else if (
      q.kind === "score" &&
      typeof q.text === "string" &&
      Array.isArray(q.levels) &&
      q.levels.length >= 2 &&
      q.levels.every((l) => typeof l === "string")
    ) {
      out[key] = { kind: "score", text: q.text, levels: q.levels as string[] };
    } else if (
      q.kind === "choice" &&
      typeof q.text === "string" &&
      (q.options === null || (Array.isArray(q.options) && q.options.length > 0 && q.options.every((o) => typeof o === "string")))
    ) {
      out[key] = { kind: "choice", text: q.text, options: q.options === null ? null : (q.options as string[]) };
    } else {
      throw new Error(`pack question ${key} has an invalid shape`);
    }
  }
  for (const [key, kind] of Object.entries(required)) {
    const question = out[key];
    if (question === undefined || question.kind !== kind) {
      throw new Error(`pack tier is missing a ${kind} question "${key}"`);
    }
  }
  return out as T;
}

export function parsePack(raw: unknown): QuestionPack {
  if (raw === null || typeof raw !== "object") throw new Error("pack is not an object");
  const obj = raw as Record<string, unknown>;
  const pack: QuestionPack = {
    version: typeof obj.version === "number" ? obj.version : 1,
    guardrail: parseTierQuestions<GuardrailQuestions>(obj.guardrail, {
      destructive: "noul",
      severity: "score",
    }),
    triage: parseTierQuestions<TriageQuestions>(obj.triage, {
      isNeeded: "noul",
      scope: "choice",
    }),
    critic: parseTierQuestions<CriticQuestions>(obj.critic, { failed: "noul" }),
    locate: parseTierQuestions<LocateQuestions>(obj.locate, { primary: "noul" }),
  };
  if (obj.routing !== undefined && obj.routing !== null && typeof obj.routing === "object") {
    pack.routing = parseTierQuestions<RoutingQuestions>(obj.routing, {
      bestTool: "choice",
      confidence: "score",
    });
  }
  if (obj.s0 !== undefined && obj.s0 !== null && typeof obj.s0 === "object") {
    pack.s0 = parseTierQuestions<S0Questions>(obj.s0, {
      gate: "noul",
      pickFile: "choice",
      pickConfidence: "score",
      sufficiency: "score",
      isAnswerPresent: "noul",
      answerLine: "choice",
    });
  }
  if (obj.thresholds !== undefined && obj.thresholds !== null && typeof obj.thresholds === "object") {
    const t: Partial<DecisionKitThresholds> = {};
    for (const key of [
      "guardrailDestructive",
      "guardrailSeverity",
      "routingConfidence",
      "readRelevanceStub",
      "criticFailed",
      "criticError",
      "criticEmpty",
      "s0ExploreMin",
      "s0PickMin",
      "s0SufficiencyMin",
      "s0AnswerMin",
    ] as const) {
      const value = (obj.thresholds as Record<string, unknown>)[key];
      if (typeof value === "number") t[key] = value;
    }
    if (Object.keys(t).length > 0) pack.thresholds = t;
  }
  return pack;
}

function packsDir(): string {
  // Works from src (vitest) and dist (tsc build copies question-packs/ next to the JS).
  return join(dirname(fileURLToPath(import.meta.url)), "question-packs");
}

function readTierFile(tier: (typeof TIERS)[number]): unknown {
  return JSON.parse(readFileSync(join(packsDir(), `${tier}.json`), "utf8"));
}

let cachedDefault: QuestionPack | undefined;
const cachedAgentPacks = new Map<PackHost, QuestionPack>();

/**
 * Load the shipped default pack, optionally keyed by the coding agent it runs
 * under. Agent packs (`question-packs/agents/<host>.json`) are calibrated
 * centrally — tier set per verified hook surface, wording measured once on the
 * central rigs and shipped identical across agents. There is no per-repo
 * calibration: a wording that wins in one context but loses in another must
 * not ship (measured 2026-09-20 — the per-repo calibrated routing wording
 * misfired conf 0.98–1.03 on a natural prompt the shipped default passes at
 * 0.58–0.65). The generic per-tier merge is the behavior-identical fallback so
 * System 1 never goes down over a missing data file.
 */
export function loadDefaultPack(host?: PackHost): QuestionPack {
  if (host === undefined) {
    if (cachedDefault !== undefined) return cachedDefault;
    try {
      const merged: Record<string, unknown> = { version: 1 };
      for (const tier of TIERS) {
        const raw = readTierFile(tier) as Record<string, unknown>;
        merged[tier] = raw[tier];
        if (raw.thresholds !== undefined) merged.thresholds = raw.thresholds;
      }
      cachedDefault = parsePack(merged);
    } catch (err) {
      if (process.env.DECISIONKIT_DEBUG === "1") {
        console.error("[decisionkit] default question-pack files unreadable, using in-code fallback:", err);
      }
      cachedDefault = FALLBACK;
    }
    return cachedDefault;
  }
  const cached = cachedAgentPacks.get(host);
  if (cached !== undefined) return cached;
  try {
    const pack = parsePack(JSON.parse(readFileSync(join(packsDir(), "agents", `${host}.json`), "utf8")));
    cachedAgentPacks.set(host, pack);
    return pack;
  } catch (err) {
    if (process.env.DECISIONKIT_DEBUG === "1") {
      console.error(`[decisionkit] agent pack for ${host} unreadable, falling back to the generic default:`, err);
    }
    const generic = loadDefaultPack();
    cachedAgentPacks.set(host, generic);
    return generic;
  }
}

/** Load an explicit pack override (central benchmark/experiment) from a JSON
 * file. Throws on invalid input. */
export function loadPackFile(path: string): QuestionPack {
  return parsePack(JSON.parse(readFileSync(path, "utf8")));
}

export function choiceOptions(question: ChoiceQuestion): Record<string, null> {
  const options: Record<string, null> = {};
  for (const option of question.options ?? []) options[option] = null;
  return options;
}
