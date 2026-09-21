/**
 * M2: validate decisionkit_locate ranking on real queries against a real repo (pi clone).
 *
 * Each case: a task description + a filename token to gather candidates from
 * `find`. Ground truth = known target file. Reports top-1 / top-3 accuracy,
 * per-case scores, and latency. Real DecisionKit calls.
 *
 * 2026-09-17 run: top1 6/8, top3 7/8, lat p50 ~470ms (noul fan-out rubric).
 * The two top-1 misses are ground-truth-ambiguous (multiple genuinely relevant
 * files: 11 harness.* files; transform-messages.ts also answers the messages
 * task). No case had the target ranked below 3 except the (removed) directory
 * target case. Index-as-score rubric was replaced by per-candidate noul.
 *
 * Run: npx tsx --env-file=.env packages/core/scripts/m2-locate-eval.ts   (repo root)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InMemoryLedger, DecisionKitCore } from "decisionkit-core";

const execFileAsync = promisify(execFile);

interface Case {
  task: string;
  token: string;
  target: string;
}

const PI_ROOT = "pi";

const CASES: Case[] = [
  {
    task: "zero-cost A/B benchmark harness using a faux provider",
    token: "harness",
    target: "packages/coding-agent/test/suite/harness.ts",
  },
  {
    task: "documentation of the extension API for coding agents",
    token: "extension",
    target: "packages/coding-agent/docs/extensions.md",
  },
  {
    task: "provider implementation used by tests to fake model responses",
    token: "faux",
    target: "packages/ai/src/providers/faux.ts",
  },
  {
    task: "core session logic that drives the agent loop and tool execution",
    token: "agent-session",
    target: "packages/coding-agent/src/core/agent-session.ts",
  },
  {
    task: "reads and writes user settings for the coding agent",
    token: "settings",
    target: "packages/coding-agent/src/core/settings-manager.ts",
  },
  {
    task: "converts internal messages to the LLM wire format",
    token: "messages",
    target: "packages/coding-agent/src/core/messages.ts",
  },
  {
    task: "session persistence and storage",
    token: "session-manager",
    target: "packages/coding-agent/src/core/session-manager.ts",
  },
  {
    task: "shared test helpers for the coding agent test suite",
    token: "utilities",
    target: "packages/coding-agent/test/utilities.ts",
  },
  {
    task: "test for the agent core tool loop",
    token: "agent.test",
    target: "packages/agent/test/agent.test.ts",
  },
];

async function candidatesFor(token: string): Promise<string[]> {
  // No ripgrep dependency here: plain find keeps the eval runnable anywhere.
  const { stdout } = await execFileAsync(
    "find",
    [
      PI_ROOT,
      "-name",
      `*${token}*`,
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
      "-not",
      "-path",
      "*/dist/*",
    ],
    { timeout: 3000 },
  );
  const files = stdout.split("\n").filter((f) => f.includes("."));
  // Normalize out the repo root prefix so targets match extension-facing paths.
  return files.map((f) => f.replace(/^pi\//, "")).slice(0, 30);
}

async function main(): Promise<void> {
  const ledger = new InMemoryLedger();
  const decisionkit = new DecisionKitCore({ enabled: true, model: "jev-1.13.0" }, ledger);
  let top1 = 0;
  let top3 = 0;
  let cases = 0;
  const latencies: number[] = [];
  for (const c of CASES) {
    const candidates = await candidatesFor(c.token);
    if (candidates.length < 2) {
      console.log(`[locate-eval] SKIP token=${c.token} (only ${candidates.length} candidates)`);
      continue;
    }
    cases++;
    const decision = await decisionkit.locate({ task: c.task, candidates });
    latencies.push(decision.receipt.latencyMs);
    const rankOf = decision.ranked.findIndex((f) => f === c.target);
    if (rankOf === 0) top1++;
    if (rankOf >= 0 && rankOf < 3) top3++;
    const scores = decision.scores
      .map((s, i) => `${candidates[i]}=${s.toFixed(2)}`)
      .filter((_, i) => decision.scores[i] > 0.2)
      .join(" ");
    console.log(
      `[locate-eval] token=${c.token} target=${c.target} rank=${rankOf < 0 ? "miss" : rankOf} ` +
        `lat=${decision.receipt.latencyMs}ms ok=${decision.receipt.ok}` +
        (decision.receipt.failOpen ? " FAIL-OPEN" : "") +
        `\n  scores: ${scores || "(none > 0.2)"}`,
    );
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(
    `\n[locate-eval] RESULT: cases=${cases} top1=${top1}/${cases} top3=${top3}/${cases} lat-p50=${p50}ms`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
