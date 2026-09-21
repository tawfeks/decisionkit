import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostHookHandler } from "../src/host-hook.js";
import { handleMcpMessage, runLocate, type McpMessage } from "../src/mcp.js";
import { DecisionKitCore } from "../src/decisionkit.js";
import { InMemoryLedger } from "../src/ledger.js";

const prevKill = process.env.DECISIONKIT_ENABLE;
const dir = mkdtempSync(join(tmpdir(), "dk-host-hook-"));
process.env.DECISIONKIT_ENABLE = "0"; // disabled → fail-open everywhere, no API calls

describe("createHostHookHandler (claude/codex stdin-hook path)", () => {
  afterAll(() => {
    if (prevKill === undefined) delete process.env.DECISIONKIT_ENABLE;
    else process.env.DECISIONKIT_ENABLE = prevKill;
    rmSync(dir, { recursive: true, force: true });
  });

  const handler = createHostHookHandler({ worktree: dir });

  it("pre (disabled core) returns no decision for either host", async () => {
    await expect(
      handler("claude", "pre", { tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    ).resolves.toBeUndefined();
    await expect(
      handler("codex", "pre", { tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    ).resolves.toBeUndefined();
  });

  it("post (disabled core) returns no decision", async () => {
    await expect(
      handler("claude", "post", { tool_name: "Bash", tool_input: {}, tool_response: "boom" }),
    ).resolves.toBeUndefined();
  });

  it("prompt (S0) fails open with no context when core is disabled", async () => {
    await expect(handler("claude", "prompt", { prompt: "fix the widget" })).resolves.toBeUndefined();
  });
});

describe("createHostHookHandler — S0 prompt injection (UserPromptSubmit)", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "dk-host-hook-s0-"));
  let prevS0: string | undefined;
  beforeAll(() => {
    delete process.env.DECISIONKIT_ENABLE;
    prevS0 = process.env.DECISIONKIT_S0;
    process.env.DECISIONKIT_S0 = "1";
    writeFileSync(join(dir2, "widget.ts"), "export const widget = 1;\n// widget mounting logic\n");
  });
  afterAll(() => {
    if (prevS0 === undefined) delete process.env.DECISIONKIT_S0;
    else process.env.DECISIONKIT_S0 = prevS0;
    rmSync(dir2, { recursive: true, force: true });
  });

  it("injects the digest as UserPromptSubmit additionalContext for both hosts", { timeout: 20000 }, async () => {
    const h = createHostHookHandler({
      worktree: dir2,
      config: {
        enabled: true,
        timeoutMs: 500,
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
    for (const host of ["claude", "codex"] as const) {
      const out = await h(host, "prompt", { prompt: "fix the widget mounting logic" });
      expect(out).toBeDefined();
      const hookOut = (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
      expect(hookOut?.hookEventName).toBe("UserPromptSubmit");
      const ctx = String(hookOut?.additionalContext);
      expect(ctx).toContain("[decisionkit context");
      expect(ctx).toContain("widget.ts");
    }
  });
});

describe("mcp message handler", () => {
  const respond = (msg: Partial<McpMessage>) => handleMcpMessage(dir, msg as McpMessage);

  it("initialize returns server info + tools capability", () => {
    const res = respond({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const result = (res as { result?: { serverInfo?: { name?: string } } } | undefined)?.result;
    expect(result?.serverInfo?.name).toBe("decisionkit");
  });

  it("tools/list exposes decisionkit_locate", () => {
    const res = respond({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = ((res as { result?: { tools?: { name: string }[] } }).result?.tools ?? []);
    expect(tools.map((t) => t.name)).toEqual(["decisionkit_locate"]);
  });

  it("unknown methods error; notifications stay silent", () => {
    expect(respond({ jsonrpc: "2.0", id: 3, method: "nope" })?.error?.code).toBe(-32601);
    expect(respond({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });

  it("runLocate fails open to rg candidates (or the documented no-match fallback)", async () => {
    const core = new DecisionKitCore({ enabled: false }, new InMemoryLedger(join(dir, "r.jsonl")));
    const text = await runLocate(core, dir, { query: "no-such-file-xyzzy", task: "t" });
    expect(text).toContain("No files matching");
  });
});
