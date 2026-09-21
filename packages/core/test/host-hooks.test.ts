import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionKitHostHooks } from "../src/host-hooks.js";

const prevKill = process.env.DECISIONKIT_ENABLE;
const prevPack = process.env.DECISIONKIT_PACK;
const dir = mkdtempSync(join(tmpdir(), "dk-host-hooks-"));
process.env.DECISIONKIT_ENABLE = "0"; // disabled → fail-open everywhere, no API calls

describe("createDecisionKitHostHooks (shared opencode/kilo adapter logic)", () => {
  afterAll(() => {
    if (prevKill === undefined) delete process.env.DECISIONKIT_ENABLE;
    else process.env.DECISIONKIT_ENABLE = prevKill;
    if (prevPack === undefined) delete process.env.DECISIONKIT_PACK;
    else process.env.DECISIONKIT_PACK = prevPack;
    rmSync(dir, { recursive: true, force: true });
  });

  const schema = { string: () => ({ describe: (d: string) => d }) };
  const hooks = createDecisionKitHostHooks({ worktree: dir, schema });

  it("builds locate args from the injected schema builder", () => {
    expect(Object.keys(hooks.locateTool.args)).toEqual(["query", "task"]);
    expect(hooks.locateTool.description).toContain("ranked shortlist");
  });

  it("before-hook fails open when disabled (never throws)", async () => {
    await expect(
      hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "rm -rf /" } }),
    ).resolves.toBeUndefined();
  });

  it("after-hook passes results through when disabled", async () => {
    const output = { output: "ok" };
    await hooks["tool.execute.after"]({ tool: "read", args: { filePath: "src/a.ts" } }, output);
    expect(output.output).toBe("ok");
  });

  it("locate falls back to unranked candidates when rg finds nothing", async () => {
    const out = await hooks.locateTool.execute({ query: "no-such-file-xyzzy", task: "t" }, undefined);
    expect(out).toContain("No files matching");
  });

  it("locate returns candidates joined when rg finds files (disabled core keeps order)", async () => {
    writeFileSync(join(dir, "sample-target-file.ts"), "x\n");
    const out = await hooks.locateTool.execute({ query: "sample-target-file", task: "t" }, undefined);
    const lines = out.split("\n");
    if (lines.includes("No files matching sample-target-file")) {
      expect(lines).toEqual(["No files matching sample-target-file"]); // rg not installed → documented fallback
    } else {
      expect(lines).toContain("sample-target-file.ts");
    }
  });
});

describe("createDecisionKitHostHooks — plan-v3 fast paths + S0 injection", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "dk-host-hooks-s0-"));
  let jevCalls = 0;
  const prevS0 = process.env.DECISIONKIT_S0;
  beforeAll(() => {
    delete process.env.DECISIONKIT_ENABLE;
    process.env.DECISIONKIT_S0 = "1";
    writeFileSync(join(dir2, "widget.ts"), "export const widget = 1;\n// widget mounting logic\n");
  });
  afterAll(() => {
    if (prevS0 === undefined) delete process.env.DECISIONKIT_S0;
    else process.env.DECISIONKIT_S0 = prevS0;
    rmSync(dir2, { recursive: true, force: true });
  });

  const makeHooks = () => {
    jevCalls = 0;
    return createDecisionKitHostHooks({
      worktree: dir2,
      schema: { string: () => ({ describe: (d: string) => d }) },
      config: {
        enabled: true,
        timeoutMs: 500,
        // explicit key → OpenRouter transport, so config.fetch is the jev transport
        apiKey: "sk-or-v1-test",
        // No provider key resolves → core fails open per call; the count
        // still tells us whether a jev round trip was attempted. A 5xx is
        // transient per the retry policy, so one failing attempt costs 2
        // transport calls (initial + bounded retry) before failing open.
        fetch: (async () => {
          jevCalls++;
          return new Response("{}", { status: 500 });
        }) as typeof fetch,
      },
    });
  };

  it("guardrail fast path allows read-only bash without a jev call", async () => {
    const h = makeHooks();
    await expect(
      h["tool.execute.before"]({ tool: "bash" }, { args: { command: "ls src && cat package.json | head -20" } }),
    ).resolves.toBeUndefined();
    expect(jevCalls).toBe(0);
  });

  it("destructive bash still goes to jev (fails open → no throw)", async () => {
    const h = makeHooks();
    await expect(
      h["tool.execute.before"]({ tool: "bash" }, { args: { command: "rm -rf /" } }),
    ).resolves.toBeUndefined();
    expect(jevCalls).toBe(2); // 5xx → one bounded retry, then fail-open
  });

  it("critic fast path skips jev on a non-empty result, runs on empty", async () => {
    const h = makeHooks();
    const ok = { output: "did the thing" };
    await h["tool.execute.after"]({ tool: "bash", args: { command: "npm test" } }, ok);
    expect(jevCalls).toBe(0);
    expect(ok.output).toBe("did the thing");
    const empty = { output: "" };
    await h["tool.execute.after"]({ tool: "bash", args: { command: "npm test" } }, empty);
    expect(jevCalls).toBe(2); // 5xx → one bounded retry, then fail-open
  });

  it("chat.message fails open without a digest part when no candidates exist", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dk-host-hooks-empty-"));
    try {
      const h = createDecisionKitHostHooks({
        worktree: empty,
        schema: { string: () => ({ describe: (d: string) => d }) },
        config: { enabled: true, timeoutMs: 500, fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch },
      });
      const parts: unknown[] = [{ type: "text", text: "hello" }];
      await h["chat.message"]({ sessionID: "s1" }, { parts });
      expect(parts).toHaveLength(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("chat.message injects the S0 digest as an appended text part", { timeout: 20000 }, async () => {
    const h = createDecisionKitHostHooks({
      worktree: dir2,
      schema: { string: () => ({ describe: (d: string) => d }) },
      config: {
        enabled: true,
        timeoutMs: 500,
        // explicit key → OpenRouter transport, so config.fetch is the jev transport
        apiKey: "sk-or-v1-test",
        fetch: (async () =>
          new Response(
            JSON.stringify({
              answers: {
                explore: { type: "noul", noul: 0.9 },
                pick: { type: "choice", choice: "F1" },
                confidence: { type: "score", score: 2 },
                sufficiency: { type: "score", score: 0 },
              },
              usage: { input_tokens: 10, output_tokens: 0 },
              model: "jev-test",
            }),
            { status: 200 },
          )) as typeof fetch,
      },
    });
    const parts: unknown[] = [{ type: "text", text: "fix the widget mounting logic" }];
    await h["chat.message"]({ sessionID: "s2" }, { parts });
    expect(parts.length).toBeGreaterThan(1);
    const injected = parts[parts.length - 1] as { type: string; text: string };
    expect(injected.type).toBe("text");
    expect(injected.text).toContain("[decisionkit context");
    expect(injected.text).toContain("widget.ts");
  });

  it("chat.message with DECISIONKIT_S0=0 appends nothing and calls no jev", async () => {
    process.env.DECISIONKIT_S0 = "0";
    const h = makeHooks();
    const parts: unknown[] = [{ type: "text", text: "fix the widget mounting logic" }];
    await h["chat.message"]({ sessionID: "s3" }, { parts });
    expect(parts).toHaveLength(1);
    expect(jevCalls).toBe(0);
    process.env.DECISIONKIT_S0 = "1";
  });
});
