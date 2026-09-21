import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { DecisionKitCore } from "./decisionkit.js";
import { InMemoryLedger } from "./ledger.js";

const execFileAsync = promisify(execFile);

/**
 * MCP stdio server exposing `decisionkit_locate` — the Tier 2.5 pre-read
 * triage tool for hosts without plugin tool registration (Claude Code via
 * `.mcp.json`, Codex via `[mcp_servers.decisionkit]` in config.toml).
 *
 * Dependency-free: implements the MCP stdio transport directly (newline-
 * delimited JSON-RPC 2.0 per https://modelcontextprotocol.io — initialize,
 * tools/list, tools/call). Shares the same core, pack precedence and receipts
 * ledger as every other adapter (worktree = process cwd).
 */

const LOCATE_MAX_CANDIDATES = 30; // plan §2 Tier 2.5: ≤30 candidates per fan-out

const LOCATE_TOOL = {
  name: "decisionkit_locate",
  description:
    "Find files relevant to a query. Cheaper than multiple grep+read rounds: returns a ranked shortlist.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Filename or content pattern" },
      task: { type: "string", description: "What the current task needs from these files" },
    },
    required: ["query", "task"],
  },
};

/** Locate implementation shared with host-hooks.ts (rg filename candidates →
 * one fan-out score call → ranked shortlist). Fail-open to unranked. */
export async function runLocate(
  core: DecisionKitCore,
  worktree: string,
  args: { query?: unknown; task?: unknown },
): Promise<string> {
  const query = String(args.query ?? "");
  const task = String(args.task ?? "");
  let candidates: string[] = [];
  try {
    const rg = await execFileAsync("rg", ["--files", "-g", `*${query}*`], {
      cwd: worktree,
      timeout: 3000,
    });
    candidates = rg.stdout.split("\n").filter(Boolean).slice(0, LOCATE_MAX_CANDIDATES);
  } catch {
    candidates = [];
  }
  if (candidates.length === 0) {
    return `No files matching ${query}`;
  }
  const located = await core.locate({ task, candidates });
  return located.ranked.length > 0 ? located.ranked.join("\n") : candidates.join("\n");
}

export interface McpMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export type McpCore = Pick<DecisionKitCore, "locate">;

/** Pure message handler (unit-testable); `stdioMain` drives it over stdin/stdout. */
export function handleMcpMessage(worktree: string, msg: McpMessage): McpResponse | undefined {
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: String((msg.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2024-11-05"),
          capabilities: { tools: {} },
          serverInfo: { name: "decisionkit", version: "0.1.2" },
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: [LOCATE_TOOL] },
      };
    default:
      // `tools/call` is handled by stdioMain (async locate work) and never
      // reaches here. Unknown methods error per JSON-RPC.
      if (msg.method?.startsWith("notifications/")) return undefined;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(msg.method)}` } };
  }
}

async function locateText(worktree: string, args: Record<string, unknown>): Promise<string> {
  const ledger = new InMemoryLedger(resolve(worktree, ".decisionkit/receipts.jsonl"));
  const core = new DecisionKitCore(
    {
      enabled: process.env.DECISIONKIT_ENABLE !== "0",
      ...(process.env.DECISIONKIT_PACK !== undefined ? { packPath: resolve(process.env.DECISIONKIT_PACK) } : {}),
    },
    ledger,
  );
  return runLocate(core, worktree, args);
}

export async function stdioMain(): Promise<void> {
  const worktree = process.cwd();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === "") continue;
      void dispatch(line);
    }
  });
  process.stdin.on("end", () => process.exit(0));

  async function dispatch(line: string): Promise<void> {
    let msg: McpMessage;
    try {
      msg = JSON.parse(line) as McpMessage;
    } catch {
      return;
    }
    if (msg.method === "tools/call") {
      const params = msg.params ?? {};
      if (params.name !== "decisionkit_locate") {
        write({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32602, message: `unknown tool: ${String(params.name)}` } });
        return;
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      let result: unknown;
      try {
        const text = await locateText(worktree, args);
        result = { content: [{ type: "text", text }] };
      } catch (err) {
        result = {
          content: [{ type: "text", text: `decisionkit_locate failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
      write({ jsonrpc: "2.0", id: msg.id ?? null, result });
      return;
    }
    const response = handleMcpMessage(worktree, msg);
    if (response !== undefined) write(response);
  }

  function write(response: McpResponse): void {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

const invokedDirectly = (): boolean => {
  const here = resolve(process.argv[1] ?? "");
  return here.endsWith("mcp.js") || here.endsWith("mcp.mjs");
};

if (invokedDirectly()) {
  await stdioMain();
}
