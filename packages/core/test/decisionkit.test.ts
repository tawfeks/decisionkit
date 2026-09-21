import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryLedger } from "../src/ledger.js";
import { loadDefaultPack, parsePack } from "../src/packs.js";
import { DecisionKitCore } from "../src/decisionkit.js";

type Handler = (body: unknown) => { status: number; body: unknown };

const makeCore = (handler: Handler, ledger = new InMemoryLedger()): DecisionKitCore =>
  new DecisionKitCore(
    {
      enabled: true,
      apiKey: "test-key",
      timeoutMs: 500,
      model: "jev-1.13.0",
      fetch: (async (_input: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const res = handler(body);
        return new Response(JSON.stringify(res.body), { status: res.status });
      }) as typeof fetch,
    },
    ledger,
  );

const okBody = (answers: Record<string, unknown>) => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 10, output_tokens: 0 },
});

describe("question packs", () => {
  it("ships a parseable default pack whose tiers match the on-disk JSON", () => {
    const pack = loadDefaultPack();
    expect(pack.version).toBe(1);
    const tiers = ["guardrail", "routing", "triage", "critic", "locate"] as const;
    const merged: Record<string, unknown> = { version: 1 };
    for (const tier of tiers) {
      const file = JSON.parse(
        readFileSync(join("src", "question-packs", `${tier}.json`), "utf8"),
      ) as Record<string, unknown>;
      merged[tier] = file[tier];
    }
    const parsed = parsePack(merged);
    for (const tier of tiers) {
      expect(parsed[tier]).toEqual(pack[tier]);
    }
  });

  it("uses custom pack questions via config.pack", async () => {
    const seen: unknown[] = [];
    const pack = loadDefaultPack();
    const decisionkit = new DecisionKitCore(
      {
        enabled: true,
        apiKey: "test-key",
        timeoutMs: 500,
        model: "jev-1.13.0",
        pack: {
          ...pack,
          version: 2,
          guardrail: {
            destructive: { kind: "noul", text: "CUSTOM destructive?" },
            severity: { kind: "score", text: "CUSTOM severity?", levels: ["none", "minor", "serious"] },
          },
          thresholds: { criticFailed: 0.5 },
        },
        fetch: (async (_input: string, init?: RequestInit) => {
          seen.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify(okBody({ destructive: { type: "noul", noul: 0.9 }, severity: { type: "score", score: 2 } })),
            { status: 200 },
          );
        }) as typeof fetch,
      },
      new InMemoryLedger(),
    );
    expect(decisionkit.thresholds.criticFailed).toBe(0.5);
    await decisionkit.guardrail({ tool: "bash", toolInput: {} });
    const questions = (seen[0] as { questions: Record<string, { instructions?: string }> }).questions;
    expect(questions.destructive?.instructions).toBe("CUSTOM destructive?");
    expect(questions.severity?.instructions).toBe("CUSTOM severity?");
  });
});

describe("S0 tier", () => {
  it("s0Gate explores at/above threshold 0.5 and skips below", async () => {
    const explore = makeCore(() => ({
      status: 200,
      body: okBody({ explore: { type: "noul", noul: 0.5 } }),
    }));
    const d = await explore.s0Gate({ prompt: "fix the greenland map issue", cwd: "/tmp" });
    expect(d.explore).toBe(true);
    expect(d.receipt.tier).toBe("s0");
    expect(d.receipt.decision).toContain("explore");

    const skip = makeCore(() => ({
      status: 200,
      body: okBody({ explore: { type: "noul", noul: 0.49 } }),
    }));
    const d2 = await skip.s0Gate({ prompt: "hello", cwd: "/tmp" });
    expect(d2.explore).toBe(false);
    expect(d2.receipt.decision).toContain("skip");
  });

  it("s0Pick accepts a non-none pick with conf ≥0.7 and rejects none / low confidence", async () => {
    const accept = makeCore(() => ({
      status: 200,
      body: okBody({
        pick: { type: "choice", choice: "F1", confidence: 0.7 },
        confidence: { type: "score", score: 2 },
      }),
    }));
    const d = await accept.s0Pick({ task: "t", ids: ["F1", "F2"], candidates: ["F1: card", "F2: card"] });
    expect(d.pick).toBe("F1");
    expect(d.confidence).toBe(2);
    expect(d.receipt.decision).toContain("pick(F1");

    const none = makeCore(() => ({
      status: 200,
      body: okBody({
        pick: { type: "choice", choice: "none", confidence: 0.9 },
        confidence: { type: "score", score: 2 },
      }),
    }));
    const d2 = await none.s0Pick({ task: "t", ids: ["F1"], candidates: ["F1: card"] });
    expect(d2.pick).toBeUndefined();

    const lowConf = makeCore(() => ({
      status: 200,
      body: okBody({
        pick: { type: "choice", choice: "F1", confidence: 0.5 },
        confidence: { type: "score", score: 0 },
      }),
    }));
    const d3 = await lowConf.s0Pick({ task: "t", ids: ["F1"], candidates: ["F1: card"] });
    expect(d3.pick).toBeUndefined();
    expect(d3.receipt.decision).toContain("no-pick");
  });

  it("s0Sufficiency clamps the score axis to 0..2", async () => {
    const high = makeCore(() => ({
      status: 200,
      body: okBody({ sufficiency: { type: "score", score: 2 } }),
    }));
    expect((await high.s0Sufficiency({ task: "t", digestSummary: "d" })).score).toBe(2);

    const over = makeCore(() => ({
      status: 200,
      body: okBody({ sufficiency: { type: "score", score: 5 } }),
    }));
    expect((await over.s0Sufficiency({ task: "t", digestSummary: "d" })).score).toBe(2);

    const negative = makeCore(() => ({
      status: 200,
      body: okBody({ sufficiency: { type: "score", score: -1 } }),
    }));
    expect((await negative.s0Sufficiency({ task: "t", digestSummary: "d" })).score).toBe(0);
  });

  it("s0Answer accepts a verbatim digest line at ≥0.9 and rejects low presence / out-of-range", async () => {
    const accept = makeCore(() => ({
      status: 200,
      body: okBody({
        present: { type: "noul", noul: 0.95 },
        line: { type: "choice", choice: "L1", confidence: 0.9 },
      }),
    }));
    const d = await accept.s0Answer({ task: "what port", digestLines: ["Files: a.ts", "Dev server: port 5173"] });
    expect(d.verbatim).toEqual({ line: "Dev server: port 5173", idx: 1 });
    expect(d.receipt.decision).toContain("answer(L1)");

    const low = makeCore(() => ({
      status: 200,
      body: okBody({
        present: { type: "noul", noul: 0.4 },
        line: { type: "choice", choice: "L1", confidence: 0.9 },
      }),
    }));
    const d2 = await low.s0Answer({ task: "what port", digestLines: ["a"] });
    expect(d2.verbatim).toBeUndefined();
    expect(d2.receipt.decision).toContain("no-answer");

    const badLine = makeCore(() => ({
      status: 200,
      body: okBody({
        present: { type: "noul", noul: 0.95 },
        line: { type: "choice", choice: "L9", confidence: 0.9 },
      }),
    }));
    const d3 = await badLine.s0Answer({ task: "what port", digestLines: ["a"] });
    expect(d3.verbatim).toBeUndefined();
  });

  it("s0 tiers fail open when disabled (answers lost ⇒ explore=false, no pick, score 0)", async () => {
    const decisionkit = new DecisionKitCore({ enabled: false }, new InMemoryLedger());
    const gate = await decisionkit.s0Gate({ prompt: "fix map", cwd: "/tmp" });
    expect(gate.explore).toBe(false);
    expect(gate.receipt.decision).toBe("disabled");

    const pick = await decisionkit.s0Pick({ task: "t", ids: ["F1"], candidates: ["F1: card"] });
    expect(pick.pick).toBeUndefined();
    expect(pick.confidence).toBe(0);

    const suff = await decisionkit.s0Sufficiency({ task: "t", digestSummary: "d" });
    expect(suff.score).toBe(0);

    const answer = await decisionkit.s0Answer({ task: "t", digestLines: ["a"] });
    expect(answer.verbatim).toBeUndefined();
    expect(answer.confidence).toBe(0);
  });

  it("s0 tiers fail open when the API loses the answers, and record detail.step", async () => {
    const ledger = new InMemoryLedger();
    const decisionkit = makeCore(() => ({ status: 500, body: { error: "boom" } }), ledger);
    const gate = await decisionkit.s0Gate({ prompt: "fix map", cwd: "/tmp" });
    expect(gate.explore).toBe(false);
    expect(gate.receipt.failOpen).toBe(true);

    const pick = await decisionkit.s0Pick({ task: "t", ids: ["F1"], candidates: ["F1: card"] });
    expect(pick.pick).toBeUndefined();

    await decisionkit.s0Sufficiency({ task: "t", digestSummary: "d" });
    await decisionkit.s0Answer({ task: "t", digestLines: ["a", "b"] });

    for (const r of ledger.all()) {
      expect(r.tier).toBe("s0");
      expect((r.detail as { step?: string } | undefined)?.step).toBeDefined();
    }
    expect(ledger.totals().calls).toBe(4);
  });
});

describe("DecisionKitCore", () => {
  it("blocks destructive high-severity tool calls", async () => {
    const decisionkit = makeCore(() => ({
      status: 200,
      body: okBody({ destructive: { type: "noul", noul: 0.95 }, severity: { type: "score", score: 2 } }),
    }));
    const d = await decisionkit.guardrail({ tool: "bash", toolInput: { command: "rm -rf ./" } });
    expect(d.action).toBe("block");
    expect(d.reason).toContain("guardrail");
  });

  it("allows safe tool calls", async () => {
    const decisionkit = makeCore(() => ({
      status: 200,
      body: okBody({ destructive: { type: "noul", noul: 0.1 }, severity: { type: "score", score: 0 } }),
    }));
    const d = await decisionkit.guardrail({ tool: "read", toolInput: { path: "a.ts" } });
    expect(d.action).toBe("allow");
  });

  it("routes high-confidence tool requests", async () => {
    const decisionkit = makeCore(() => ({
      status: 200,
      body: okBody({
        bestTool: { type: "choice", choice: "read", confidence: 0.9 },
        confidence: { type: "score", score: 2 },
      }),
    }));
    const d = await decisionkit.routing({
      prompt: "what port is the dev server on",
      cwd: "/tmp",
      registeredTools: ["read", "ls"],
    });
    expect(d.action).toBe("route");
    expect(d.tool).toBe("read");
  });

  it("fails open on API errors", async () => {
    const decisionkit = makeCore(() => ({ status: 500, body: { error: "boom" } }));
    const d = await decisionkit.guardrail({ tool: "bash", toolInput: { command: "rm -rf /" } });
    expect(d.action).toBe("allow");
    expect(d.receipt.failOpen).toBe(true);
  });

  it("recovers from one transient HTTP failure via a single retry (no digest lost)", async () => {
    let calls = 0;
    const decisionkit = new DecisionKitCore(
      {
        enabled: true,
        apiKey: "test-key",
        timeoutMs: 500,
        model: "jev-1.13.0",
        fetch: (async () => {
          calls++;
          if (calls === 1) return new Response(JSON.stringify({ error: "transient flap" }), { status: 502 });
          return new Response(
            JSON.stringify(okBody({ destructive: { type: "noul", noul: 0.9 }, severity: { type: "score", score: 2 } })),
            { status: 200 },
          );
        }) as typeof fetch,
      },
      new InMemoryLedger(),
    );
    const d = await decisionkit.guardrail({ tool: "bash", toolInput: { command: "rm -rf ." } });
    expect(calls).toBe(2);
    expect(d.action).toBe("block");
    expect(d.receipt.failOpen).toBeUndefined();
  });

  it("retries a transient 422 the same way (OpenRouter surfaces upstream flaps as 422)", async () => {
    let calls = 0;
    const decisionkit = new DecisionKitCore(
      {
        enabled: true,
        apiKey: "test-key",
        timeoutMs: 500,
        model: "jev-1.13.0",
        fetch: (async () => {
          calls++;
          if (calls === 1) return new Response(JSON.stringify({ error: "unprocessable" }), { status: 422 });
          return new Response(
            JSON.stringify(okBody({ destructive: { type: "noul", noul: 0.9 }, severity: { type: "score", score: 2 } })),
            { status: 200 },
          );
        }) as typeof fetch,
      },
      new InMemoryLedger(),
    );
    const d = await decisionkit.guardrail({ tool: "bash", toolInput: { command: "rm -rf ." } });
    expect(calls).toBe(2);
    expect(d.action).toBe("block");
  });

  it("fails open when disabled", async () => {
    const decisionkit = new DecisionKitCore({ enabled: false }, new InMemoryLedger());
    const d = await decisionkit.guardrail({ tool: "bash", toolInput: { command: "rm -rf /" } });
    expect(d.action).toBe("allow");
  });

  it("stubs irrelevant reads", async () => {
    const decisionkit = makeCore(() => ({
      status: 200,
      body: okBody({ isNeeded: { type: "noul", noul: 0.05 }, scope: { type: "choice", choice: "whole" } }),
    }));
    const d = await decisionkit.triageRead({ path: "unrelated.txt", taskContext: "fix auth" });
    expect(d.action).toBe("stub");
  });

  it("critic intervenes on failed results", async () => {
    const decisionkit = makeCore(() => ({
      status: 200,
      body: okBody({ failed: { type: "noul", noul: 0.9 } }),
    }));
    const d = await decisionkit.critic({
      tool: "edit",
      toolInput: {},
      resultPreview: "module not found",
      isError: true,
      taskContext: "fix import",
    });
    expect(d.action).toBe("intervene");
    expect(d.note).toContain("decisionkit critic");
  });

  it("critic stays quiet on compound partial success (content, no visible error)", async () => {
    // Run-5 A0 false fire of the single-question policy: cat succeeded + grep
    // legitimately found nothing → `failed` ran 0.86 live, but the orthogonal
    // signals (error low, empty low) must suppress the note.
    const ledger = new InMemoryLedger();
    const decisionkit = makeCore(
      () => ({
        status: 200,
        body: okBody({
          failed: { type: "noul", noul: 0.86 },
          error: { type: "noul", noul: 0.04 },
          empty: { type: "noul", noul: 0.02 },
        }),
      }),
      ledger,
    );
    const d = await decisionkit.critic({
      tool: "bash",
      toolInput: { command: "cat package.json 2>/dev/null; grep -rE 'port' vite.config.* 2>/dev/null" },
      resultPreview: '{ "name": "@vitejs/vite-monorepo", "private": true }',
      isError: false,
      taskContext: "what port is the dev server configured on?",
    });
    expect(d.action).toBe("ok");
  });

  it("critic fires on empty results via the failed-AND-empty gate", async () => {
    const decisionkit = makeCore(() => ({
      status: 200,
      body: okBody({
        failed: { type: "noul", noul: 0.9 },
        error: { type: "noul", noul: 0.03 },
        empty: { type: "noul", noul: 0.9 },
      }),
    }));
    const d = await decisionkit.critic({
      tool: "bash",
      toolInput: { command: "grep -rn 'handleSubmit' src/" },
      resultPreview: "",
      isError: false,
      taskContext: "rename handleSubmit",
    });
    expect(d.action).toBe("intervene");
  });

  it("critic fires on visible errors via the error floor (exit-code failures)", async () => {
    const decisionkit = makeCore(() => ({
      status: 200,
      body: okBody({
        failed: { type: "noul", noul: 0.51 },
        error: { type: "noul", noul: 0.9 },
        empty: { type: "noul", noul: 0.02 },
      }),
    }));
    const d = await decisionkit.critic({
      tool: "bash",
      toolInput: { command: "du -ah packages/vite/dist" },
      resultPreview: "4.0K\tpackages/vite/dist\n\nCommand exited with code 1",
      isError: false,
      taskContext: "clean up the build artifacts",
    });
    expect(d.action).toBe("intervene");
  });

  it("records receipts in the ledger", async () => {
    const ledger = new InMemoryLedger();
    const decisionkit = makeCore(
      () => ({
        status: 200,
        body: okBody({ destructive: { type: "noul", noul: 0.9 }, severity: { type: "score", score: 2 } }),
      }),
      ledger,
    );
    await decisionkit.guardrail({ tool: "bash", toolInput: {} });
    expect(ledger.all().length).toBe(1);
    expect(ledger.all()[0]?.tier).toBe("guardrail");
    expect(ledger.totals().calls).toBe(1);
  });
});
