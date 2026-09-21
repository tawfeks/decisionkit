import { describe, expect, it } from "vitest";
import { runEval, formatReport } from "../src/eval.js";
import type { DecisionKitConfig } from "../src/types.js";

const okBody = (answers: Record<string, unknown>) => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 10, output_tokens: 0 },
});

const stubFetch = (failedForError: number, failedForOk: number): DecisionKitConfig["fetch"] =>
  (async (_input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state?: { isError?: boolean; result?: string } };
    const isError = Boolean(body.state?.isError);
    const empty = body.state?.result === "";
    const visibleError =
      isError || /command exited with code|command not found/i.test(String(body.state?.result ?? ""));
    const failed = isError || empty || visibleError ? failedForError : failedForOk;
    return new Response(
      JSON.stringify(
        okBody({
          failed: { type: "noul", noul: failed },
          error: { type: "noul", noul: visibleError ? failedForError : failedForOk },
          empty: { type: "noul", noul: empty ? failedForError : failedForOk },
        }),
      ),
      { status: 200 },
    );
  }) as typeof fetch;

describe("runEval (decisionkit test primitive)", () => {
  it("passes the critic tier when ground truth is separated from the threshold", async () => {
    const report = await runEval({ tier: "critic", config: { apiKey: "test-key", fetch: stubFetch(0.9, 0.05) } });
    const critic = report.tiers.critic;
    expect(critic).toBeDefined();
    expect(critic!.cases).toBe(17);
    expect(critic!.accuracy).toBe(1);
    expect(critic!.verdict).toBe("pass");
    expect(critic!.gates.failRecall).toEqual({ value: 1, gate: 0.9, pass: true });
    expect(critic!.advisories.falseFireRate).toBe(0);
    expect(critic!.separation.separated).toBe(true);
  });

  it("fails the gate when failures are missed and reports separation overlap", async () => {
    const report = await runEval({ tier: "critic", config: { apiKey: "test-key", fetch: stubFetch(0.1, 0.1) } });
    const critic = report.tiers.critic;
    expect(critic!.verdict).toBe("fail");
    expect(report.allPass).toBe(false);
    expect(critic!.failures.length).toBeGreaterThan(0);
    expect(Number.isNaN(critic!.separation.suggestedThreshold)).toBe(true);
    const text = formatReport(report);
    expect(text).toContain("GATE FAILED");
  });

  it("reports fail-opens as misses", async () => {
    const failFetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const report = await runEval({ tier: "critic", config: { apiKey: "test-key", fetch: failFetch } });
    const critic = report.tiers.critic;
    expect(critic!.failOpens).toBe(17);
    expect(critic!.verdict).toBe("fail");
  });
});
