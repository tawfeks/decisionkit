import { resolve } from "node:path";
import { InMemoryLedger } from "./ledger.js";
import { DecisionKitCore } from "./decisionkit.js";
import type { DecisionKitConfig, Receipt } from "./types.js";
import { bashCommandIsReadOnly } from "./tax-fastpath.js";
import { finishS0, s0LocalPrep } from "./s0.js";

/**
 * Hook-handler path for JSON-on-stdin hosts (Claude Code, Codex). The install
 * action (init.ts) drops a tiny `hook.mjs` into the repo that reads stdin and
 * calls `handleHostHook` from the installed decisionkit-core; all policy lives
 * here. Schemas verified against upstream docs 2026-09-20:
 *
 * - Claude Code https://code.claude.com/docs/en/hooks — PreToolUse deny via
 *   `hookSpecificOutput.permissionDecision: "deny"`; PostToolUse advisory via
 *   `hookSpecificOutput.additionalContext`; S0 via `UserPromptSubmit`
 *   `hookSpecificOutput.additionalContext` (context injected before the
 *   frontier's first turn). `updatedToolOutput` result rewriting also exists
 *   (recorded in the capability matrix as a future triage upgrade — replacing
 *   output requires matching each tool's undocumented response shape).
 * - Codex https://developers.openai.com/codex/hooks — same `hookSpecificOutput`
 *   PreToolUse deny shape; PostToolUse `decision: "block"` replaces the
 *   model-visible result with `reason` (critic result-replace); S0 via
 *   `UserPromptSubmit` `hookSpecificOutput.additionalContext` (verified
 *   2026-09-20: added as extra developer context).
 *
 * Read triage (Tier 2.5) is Claude-side only: Codex has no dedicated read tool
 * (reads go through `Bash`), so a read stub cannot be targeted reliably.
 *
 * Fast paths (plan-v3 §2.4): a static read-only bash allowlist skips the jev
 * guardrail call, and a non-empty tool result skips the jev critic call.
 * Verdict caches are not useful here (each hook invocation is a fresh
 * process); the fast paths are the latency lever that applies.
 */

export type HookHost = "claude" | "codex";
export type HookEvent = "pre" | "post" | "prompt";

export interface HostHookPayload {
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  cwd?: string;
}

const CLAUDE_READ_TOOLS = new Set(["Read", "View", "read"]);
/** Guardrail-visible tool names (side-effecting), lowercased for checks. */
const SIDE_EFFECT_TOOLS = new Set(["bash", "powershell", "edit", "write", "multiedit", "applypatch", "patch", "notebookedit"]);

const stringifyResult = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value);
  }
};

const claudePreDeny = (reason: string): Record<string, unknown> => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

const claudePostContext = (note: string): Record<string, unknown> => ({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: note,
  },
});

const codexPreDeny = claudePreDeny; // same hookSpecificOutput deny shape (verified)

const codexPostReplace = (reason: string): Record<string, unknown> => ({
  decision: "block",
  reason,
});

const promptContext = (note: string): Record<string, unknown> => ({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: note,
  },
});

const localReceipt = (tier: Receipt["tier"], decision: string, detail?: Record<string, unknown>): Receipt => ({
  ts: new Date().toISOString(),
  tier,
  decision,
  latencyMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  model: "local-fastpath",
  ok: true,
  ...(detail !== undefined ? { detail } : {}),
});

export interface HostHookHandler {
  (host: HookHost, event: HookEvent, payload: HostHookPayload): Promise<Record<string, unknown> | undefined>;
}

/** Testable seam: build a handler bound to a worktree (ledger) + core config.
 * The shipped agent-calibrated pack is selected per call's host (claude/codex
 * differ only in tier availability, so each gets its own core lazily). */
export function createHostHookHandler(opts: {
  worktree: string;
  config?: DecisionKitConfig;
  ledgerDir?: string;
}): HostHookHandler {
  const ledger = new InMemoryLedger(
    resolve(opts.ledgerDir ?? `${opts.worktree}/.decisionkit/receipts.jsonl`),
  );
  const cores = new Map<HookHost, DecisionKitCore>();
  const coreFor = (host: HookHost): DecisionKitCore => {
    const existing = cores.get(host);
    if (existing !== undefined) return existing;
    const core = new DecisionKitCore(
      {
        enabled: process.env.DECISIONKIT_ENABLE !== "0",
        ...(process.env.DECISIONKIT_PACK !== undefined
          ? { packPath: resolve(process.env.DECISIONKIT_PACK) }
          : { host }),
        ...opts.config,
      },
      ledger,
    );
    cores.set(host, core);
    return core;
  };

  return async (host, event, payload) => {
    // S0 — pre-turn context assembly (plan-v3 §2.1) via UserPromptSubmit on
    // both hosts. DECISIONKIT_S0=0 disables; every failure fails open (no
    // context injected, the prompt proceeds untouched).
    if (event === "prompt") {
      if (process.env.DECISIONKIT_S0 === "0") return undefined;
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      if (prompt.trim() === "" || prompt.length > 4000) return undefined;
      try {
        const prep = await s0LocalPrep(prompt, opts.worktree);
        const s0 = await finishS0({ decisionkit: coreFor(host) }, prep);
        ledger.record(localReceipt("s0", s0.digest !== undefined ? `digest(ms=${s0.ms},calls=${s0.jevCalls})` : `skip(${s0.skip ?? s0.failOpen ?? "no-digest"})`, {
          picked: s0.pickedRel,
          rejected: s0.rejected,
          candidates: s0.candidates,
          ms: s0.ms,
          jevCalls: s0.jevCalls,
        }));
        if (s0.digest === undefined) return undefined;
        return promptContext(
          `${s0.digest}\n\n---\n\nUse this context first; request any "Not read" file explicitly if needed.`,
        );
      } catch {
        return undefined; // fail-open
      }
    }

    const tool = String(payload.tool_name ?? "");
    if (event === "pre") {
      const args = (payload.tool_input ?? {}) as Record<string, unknown>;
      const command = typeof args.command === "string" ? args.command : undefined;
      if (
        command !== undefined
        && SIDE_EFFECT_TOOLS.has(tool.toLowerCase())
        && bashCommandIsReadOnly(command)
      ) {
        // Guardrail fast path (plan-v3 §2.4): static read-only allowlist →
        // allow locally, no jev call.
        ledger.record(localReceipt("guardrail", "allow(read-only-fastpath)", { command: command.slice(0, 120) }));
        return undefined;
      }
      const decision = await coreFor(host).guardrail({
        tool,
        toolInput: payload.tool_input ?? {},
      });
      if (decision.action === "block" && decision.reason !== undefined) {
        return host === "claude" ? claudePreDeny(decision.reason) : codexPreDeny(decision.reason);
      }
      return undefined;
    }
    // post — Tier 2.5 read triage (Claude only: it has a dedicated Read tool)
    if (host === "claude" && CLAUDE_READ_TOOLS.has(tool)) {
      const args = (payload.tool_input ?? {}) as Record<string, unknown>;
      const triage = await coreFor(host).triageRead({
        path: String(args.file_path ?? args.filePath ?? args.path ?? ""),
        taskContext: opts.worktree,
      });
      if (triage.action === "stub" && triage.reason !== undefined) {
        // PostToolUse cannot rewrite the already-read content; advise instead.
        return {
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: triage.reason },
        };
      }
    }
    // Tier 3 — critic fast path (plan-v3 §2.4): a non-empty tool result
    // worked (measured 8/8 in the taxed session); jev only on empty/missing.
    const resultText = stringifyResult(payload.tool_response);
    if (resultText.trim().length > 0) {
      ledger.record(localReceipt("critic", "ok(fastpath)", { tool, preview: resultText.slice(0, 120) }));
      return undefined;
    }
    const decision = await coreFor(host).critic({
      tool,
      toolInput: payload.tool_input,
      resultPreview: resultText,
      isError: false,
      taskContext: opts.worktree,
    });
    if (decision.action === "intervene" && decision.note !== undefined) {
      if (host === "codex") {
        // decision:"block" swaps the model-visible result for `reason` (verified).
        // Keep a truncated original so the model can still react to the output.
        const preview = resultText.slice(0, 500);
        return codexPostReplace(`${decision.note}\n--- original result (truncated) ---\n${preview}`);
      }
      return claudePostContext(decision.note);
    }
    return undefined;
  };
}

/** Standalone entry used by the generated hook.mjs: reads stdin JSON, prints
 * the decision JSON (if any). Never throws — fail-open, System 1 must not
 * take the agent down. */
export async function runHostHookStdin(host: HookHost, event: HookEvent): Promise<void> {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    return; // unreadable input → fail-open, no output
  }
  let payload: HostHookPayload = {};
  try {
    payload = JSON.parse(raw) as HostHookPayload;
  } catch {
    return; // malformed stdin → fail-open
  }
  try {
    const out = await createHostHookHandler({ worktree: process.cwd() })(host, event, payload);
    if (out !== undefined) console.log(JSON.stringify(out));
  } catch (err) {
    if (process.env.DECISIONKIT_DEBUG === "1") {
      console.error("[decisionkit] hook failed:", err);
    }
    // fail-open: exit 0 with no decision output
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
