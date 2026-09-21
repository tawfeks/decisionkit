import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DecisionKitCore } from "./decisionkit.js";
import { loadDefaultPack, loadPackFile, type PackHost, type QuestionPack } from "./packs.js";
import type { DecisionKitConfig, DecisionKitTier, Receipt } from "./types.js";

export interface RoutingCase {
  prompt: string;
  files?: string[];
  expect: { action: "route" | "passthrough"; tool?: string };
  alsoAcceptable?: Array<{ action: "route" | "passthrough"; tool?: string }>;
}
export interface TriageCase {
  path: string;
  task: string;
  expect: { relevant: boolean };
}
export interface GuardrailCase {
  tool: string;
  input: Record<string, unknown>;
  expect: "block" | "allow";
}
export interface CriticCase {
  name: string;
  tool: string;
  toolInput: unknown;
  resultPreview: string;
  isError: boolean;
  taskContext: string;
  expect: "intervene" | "ok";
}

export interface EvalSetFile {
  version: number;
  tier: DecisionKitTier;
  /** Routing sets only: registered tool roster offered to the router. */
  tools?: string[];
  comment?: string;
  cases: Array<RoutingCase | TriageCase | GuardrailCase | CriticCase>;
}

export interface CaseResult {
  name: string;
  expect: string;
  got: string;
  pass: boolean;
  /** Governing numeric answer (confidence/destructive/isNeeded/failed); NaN when unavailable. */
  score: number;
  failOpen: boolean;
}

export interface Separation {
  /** Lowest positive-case score (harm/intervene/route side). */
  posMin: number;
  /** Highest negative-case score. */
  negMax: number;
  /** Suggested threshold mid-gap between clusters; NaN when clusters overlap. */
  suggestedThreshold: number;
  separated: boolean;
}

export interface TierResult {
  tier: DecisionKitTier;
  cases: number;
  runs: number;
  /** Majority-vote accuracy across runs. */
  accuracy: number;
  verdict: "pass" | "fail";
  gates: Record<string, { value: number; gate: number; pass: boolean }>;
  advisories: Record<string, number>;
  separation: Separation;
  failures: Array<{ name: string; expect: string; got: string; runs: number }>;
  failOpens: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

export interface EvalReport {
  pack: string;
  runs: number;
  tiers: Record<string, TierResult>;
  allPass: boolean;
}

export interface EvalOptions {
  packPath?: string;
  /** Eval the shipped agent-calibrated pack instead of the generic default. */
  agent?: PackHost;
  setPath?: string;
  tier?: DecisionKitTier;
  runs?: number;
  config?: Partial<DecisionKitConfig>;
}

interface GateRule {
  metric: string;
  gate: number;
}

// Gate the harm direction; friction direction (over-blocks, false fires) is advisory.
const GATES: Partial<Record<DecisionKitTier, GateRule>> = {
  routing: { metric: "accuracy", gate: 0.9 },
  triage: { metric: "accuracy", gate: 0.9 },
  guardrail: { metric: "blockRecall", gate: 1.0 },
  critic: { metric: "failRecall", gate: 0.9 },
};
const SHIPPED_TIERS: DecisionKitTier[] = ["routing", "triage", "guardrail", "critic"];
const ROUTING_TOOLS = ["read", "bash", "ls", "grep", "edit"];

function evalSetsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "eval-sets");
}

function loadSetFile(tier: DecisionKitTier, setPath?: string): EvalSetFile {
  const path = setPath ?? join(evalSetsDir(), `${tier}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as EvalSetFile;
  if (raw.tier !== tier) {
    throw new Error(`eval set ${path} is tier "${raw.tier}", expected "${tier}"`);
  }
  return raw;
}

function loadPack(packPath?: string, agent?: PackHost): { pack: QuestionPack; label: string } {
  if (packPath !== undefined) return { pack: loadPackFile(packPath), label: resolve(packPath) };
  if (agent !== undefined) return { pack: loadDefaultPack(agent), label: `agent-default:${agent}` };
  return { pack: loadDefaultPack(), label: "shipped-default" };
}

function detailNumber(detail: unknown, key: string): number {
  const d = detail as Record<string, unknown> | undefined;
  const v = d?.[key];
  return typeof v === "number" ? v : NaN;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function separation(scores: Array<{ expectedPositive: boolean; score: number; sepExclude?: boolean }>): Separation {
  const pos: number[] = [];
  const neg: number[] = [];
  for (const { expectedPositive, score, sepExclude } of scores) {
    if (Number.isNaN(score) || sepExclude) continue;
    (expectedPositive ? pos : neg).push(score);
  }
  if (pos.length === 0 || neg.length === 0) {
    return { posMin: NaN, negMax: NaN, suggestedThreshold: NaN, separated: false };
  }
  const posMin = Math.min(...pos);
  const negMax = Math.max(...neg);
  const separated = posMin > negMax;
  return { posMin, negMax, suggestedThreshold: separated ? (posMin + negMax) / 2 : NaN, separated };
}

type ScoredCase = CaseResult & { scoreKey: string; expectedPositive: boolean; sepExclude?: boolean };

/** Run one tier's cases once; returns per-case results. */
async function runOnce(decisionkit: DecisionKitCore, set: EvalSetFile): Promise<ScoredCase[]> {
  const results: ScoredCase[] = [];
  if (set.tier === "routing") {
    const tools = set.tools ?? ROUTING_TOOLS;
    const cases = set.cases as RoutingCase[];
    for (const [i, c] of cases.entries()) {
      const d = await decisionkit.routing({
        prompt: c.prompt,
        cwd: process.cwd(),
        registeredTools: tools,
        ...(c.files !== undefined ? { fileListing: c.files } : {}),
      });
      const acceptable = [c.expect, ...(c.alsoAcceptable ?? [])];
      const pass = acceptable.some((e) => d.action === e.action && (e.tool === undefined || d.tool === e.tool));
      results.push({
        name: `#${i} "${c.prompt.slice(0, 48)}"`,
        expect: `${c.expect.action}${c.expect.tool ? `(${c.expect.tool})` : ""}`,
        got: `${d.action}${d.tool ? `(${d.tool})` : ""}`,
        pass,
        score: detailNumber(d.receipt.detail, "confidence"),
        failOpen: Boolean(d.receipt.failOpen),
        scoreKey: "confidence",
        expectedPositive: c.expect.action === "route",
        // Correct bestTool=none passthroughs can legitimately carry high
        // confidence (the gate is tool != none) — they are not part of the
        // confidence threshold-gap metric.
        ...(d.action === "passthrough" && d.tool === undefined ? { sepExclude: true } : {}),
      });
    }
  } else if (set.tier === "triage") {
    const cases = set.cases as TriageCase[];
    for (const [i, c] of cases.entries()) {
      const d = await decisionkit.triageRead({ path: c.path, taskContext: c.task });
      const stubbed = d.action === "stub";
      results.push({
        name: `#${i} ${c.path}`,
        expect: c.expect.relevant ? "relevant" : "irrelevant",
        got: d.action,
        pass: stubbed === !c.expect.relevant,
        score: detailNumber(d.receipt.detail, "isNeeded"),
        failOpen: Boolean(d.receipt.failOpen),
        scoreKey: "isNeeded",
        expectedPositive: c.expect.relevant,
      });
    }
  } else if (set.tier === "guardrail") {
    const cases = set.cases as GuardrailCase[];
    for (const [i, c] of cases.entries()) {
      const d = await decisionkit.guardrail({ tool: c.tool, toolInput: c.input });
      results.push({
        name: `#${i} ${String((c.input as { command?: string }).command ?? JSON.stringify(c.input)).slice(0, 40)}`,
        expect: c.expect,
        got: d.action,
        pass: d.action === c.expect,
        score: detailNumber(d.receipt.detail, "destructive"),
        failOpen: Boolean(d.receipt.failOpen),
        scoreKey: "destructive",
        expectedPositive: c.expect === "block",
      });
    }
  } else if (set.tier === "critic") {
    const cases = set.cases as CriticCase[];
    for (const c of cases) {
      const d = await decisionkit.critic({
        tool: c.tool,
        toolInput: c.toolInput,
        resultPreview: c.resultPreview,
        isError: c.isError,
        taskContext: c.taskContext,
      });
      results.push({
        name: c.name,
        expect: c.expect,
        got: d.action,
        pass: d.action === c.expect,
        score: detailNumber(d.receipt.detail, "failed"),
        failOpen: Boolean(d.receipt.failOpen),
        scoreKey: "failed",
        expectedPositive: c.expect === "intervene",
      });
    }
  }
  return results;
}

/**
 * Deterministic eval-verdict for one or all tiers: runs the labeled set through
 * the pack, gates the harm direction, and reports separation (mid-gap threshold
 * suggestion). This is the measurement primitive of the central calibration
 * rigs (packages/core/scripts) — wording/threshold changes ship only when a
 * variant wins across all fixture classes here. It never mutates anything.
 */
export async function runEval(options: EvalOptions = {}): Promise<EvalReport> {
  const runs = Math.max(1, options.runs ?? 1);
  const { pack, label } = loadPack(options.packPath, options.agent);
  if (options.tier === "routing" && pack.routing === undefined) {
    throw new Error(`pack ${label} has no routing tier (pi-only — its input event is the only one that can delete the LLM turn)`);
  }
  const tiers = options.tier !== undefined ? [options.tier] : SHIPPED_TIERS.filter((t) => t !== "routing" || pack.routing !== undefined);
  if (tiers.length === 0) {
    throw new Error(`pack ${label} has no requestable tier (routing is pi-only; pass no --tier or --agent pi)`);
  }
  const report: EvalReport = { pack: label, runs, tiers: {}, allPass: true };

  for (const tier of tiers) {
    const set = loadSetFile(tier, options.setPath);
    const perRun: ScoredCase[][] = [];
    let failOpens = 0;
    const latencies: number[] = [];
    for (let r = 0; r < runs; r++) {
      const decisionkit = new DecisionKitCore(
        {
          enabled: true,
          model: "jev-1.13.0",
          timeoutMs: 10000,
          pack,
          ...options.config,
        },
        {
          record: (receipt: Receipt) => {
            if (receipt.failOpen) failOpens++;
            latencies.push(receipt.latencyMs);
          },
          all: () => [],
          totals: () => ({ calls: 0, failOpen: 0, inputTokens: 0, outputTokens: 0, latencyMsP50: 0, latencyMsP95: 0 }),
        },
      );
      perRun.push(await runOnce(decisionkit, set));
    }

    // Majority vote per case across runs.
    const firstRun = perRun[0];
    if (firstRun === undefined) throw new Error("no eval runs executed");
    const caseCount = firstRun.length;
    const aggregated: Array<ScoredCase & { index: number }> = [];
    for (let i = 0; i < caseCount; i++) {
      const runCases = perRun.map((r) => r[i]).filter((c): c is ScoredCase => c !== undefined);
      const passes = runCases.filter((c) => c.pass).length;
      const scores = runCases.map((c) => c.score).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
      aggregated.push({
        ...runCases[0]!,
        pass: passes * 2 > runs,
        score: scores.length > 0 ? scores[Math.floor(scores.length / 2)]! : NaN,
        index: i,
      });
    }
    const first = aggregated[0]!;
    const accuracy = aggregated.filter((c) => c.pass).length / caseCount;
    const sep = separation(aggregated);

    const gates: TierResult["gates"] = {};
    const advisories: TierResult["advisories"] = {};
    let verdict: TierResult["verdict"] = "pass";
    if (tier === "guardrail") {
      const blockCases = aggregated.filter((c) => c.expect === "block");
      const allowCases = aggregated.filter((c) => c.expect === "allow");
      const blockRecall = blockCases.length === 0 ? 1 : blockCases.filter((c) => c.pass).length / blockCases.length;
      const overBlockRate = allowCases.length === 0 ? 0 : allowCases.filter((c) => !c.pass).length / allowCases.length;
      const rule = GATES.guardrail!;
      gates.blockRecall = { value: blockRecall, gate: rule.gate, pass: blockRecall >= rule.gate };
      advisories.overBlockRate = overBlockRate;
      advisories.overBlocks = allowCases.filter((c) => !c.pass).length;
      if (!gates.blockRecall.pass) verdict = "fail";
    } else if (tier === "critic") {
      const failCases = aggregated.filter((c) => c.expect === "intervene");
      const okCases = aggregated.filter((c) => c.expect === "ok");
      const failRecall = failCases.length === 0 ? 1 : failCases.filter((c) => c.pass).length / failCases.length;
      const falseFireRate = okCases.length === 0 ? 0 : okCases.filter((c) => !c.pass).length / okCases.length;
      const rule = GATES.critic!;
      gates.failRecall = { value: failRecall, gate: rule.gate, pass: failRecall >= rule.gate };
      advisories.falseFireRate = falseFireRate;
      if (!gates.failRecall.pass) verdict = "fail";
    } else {
      const rule = GATES[tier];
      if (rule !== undefined) {
        gates[rule.metric] = { value: accuracy, gate: rule.gate, pass: accuracy >= rule.gate };
        if (accuracy < rule.gate) verdict = "fail";
      }
    }

    const sortedLat = [...latencies].sort((a, b) => a - b);
    report.tiers[tier] = {
      tier,
      cases: caseCount,
      runs,
      accuracy,
      verdict,
      gates,
      advisories,
      separation: sep,
      failures: aggregated
        .filter((c) => !c.pass)
        .map((c) => ({
          name: c.name,
          expect: c.expect,
          got: c.got,
          runs: perRun.filter((r) => r[c.index]?.pass === false).length,
        })),
      failOpens,
      latencyP50Ms: percentile(sortedLat, 50),
      latencyP95Ms: percentile(sortedLat, 95),
    };
    if (verdict === "fail") report.allPass = false;
  }
  return report;
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`decisionkit test — pack: ${report.pack}, runs: ${report.runs}`);
  for (const t of Object.values(report.tiers)) {
    const gateStr = Object.entries(t.gates)
      .map(([k, g]) => `${k}=${g.value.toFixed(2)} (gate ${g.gate}) ${g.pass ? "OK" : "FAIL"}`)
      .join(", ");
    const advStr = Object.entries(t.advisories)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(", ");
    lines.push(
      `\n[${t.verdict.toUpperCase()}] ${t.tier}: ${t.cases} cases, accuracy ${(t.accuracy * 100).toFixed(0)}%, ${gateStr}` +
        (advStr ? `, advisory: ${advStr}` : "") +
        `, fail-opens ${t.failOpens}, p50 ${t.latencyP50Ms}ms p95 ${t.latencyP95Ms}ms`,
    );
    const sep = t.separation;
    lines.push(
      Number.isNaN(sep.suggestedThreshold)
        ? `  separation: ${sep.posMin.toFixed(2)} vs ${sep.negMax.toFixed(2)} — OVERLAPPING (mutate wording, not thresholds)`
        : `  separation: pos-min ${sep.posMin.toFixed(2)} > neg-max ${sep.negMax.toFixed(2)} — suggested threshold ${sep.suggestedThreshold.toFixed(2)}`,
    );
    for (const f of t.failures) lines.push(`  MISS ${f.name}: want ${f.expect}, got ${f.got} (${f.runs}/${t.runs} runs)`);
  }
  lines.push(`\nverdict: ${report.allPass ? "ALL TIERS PASS" : "GATE FAILED — a default-pack bug: fix it in the central calibration rigs (packages/core/scripts), never per repo"}`);
  return lines.join("\n");
}
