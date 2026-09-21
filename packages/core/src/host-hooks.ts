import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { DecisionKitCore } from "./decisionkit.js";
import { InMemoryLedger } from "./ledger.js";
import { bashCommandIsReadOnly, extractDiscoveryPaths } from "./tax-fastpath.js";
import type { DecisionKitConfig } from "./types.js";
import type { PackHost } from "./packs.js";
import type { Receipt } from "./types.js";
import { contentFileSearch, finishS0, s0LocalPrep } from "./s0.js";

const execFileAsync = promisify(execFile);

/** Zod-style string-schema builder injected by each host adapter
 * (opencode: `tool.schema.string()`, kilo: `tool.schema.string()`). */
export interface DecisionKitSchemaBuilder {
  string: () => { describe: (description: string) => unknown };
}

export interface DecisionKitLocateToolDef {
  description: string;
  args: Record<string, unknown>;
  execute: (args: { query: string; task: string }, context?: unknown) => Promise<string>;
}

export interface DecisionKitChatMessageInput {
  sessionID?: string;
}

export interface DecisionKitChatMessageOutput {
  /** Host message parts (opencode/kilo `Part[]`). The factory appends ONE
   * `{ type: "text", text }` part carrying the S0 digest — append-only, so
   * the prompt prefix stays cache-stable (the pi measured regression came
   * from re-anchoring the prefix with a separate history entry). */
  parts: unknown[];
}

export interface DecisionKitHostHooks {
  /** Tier 1 — guardrail gate. Blocking convention: throw (opencode + kilo
   * documented semantics; verified against docs 2026-09-20). */
  "tool.execute.before": (
    input: { tool: string; sessionID?: string },
    output: { args: unknown },
  ) => Promise<void>;
  /** Tier 2.5 read triage (read → stub rewrite, bash cat/head/tail) + Tier 3
   * critic on results — both with local fast paths (plan-v3 §2.4). */
  "tool.execute.after": (
    input: { tool: string; args?: Record<string, unknown>; sessionID?: string },
    output: { output: string },
  ) => Promise<void>;
  /** S0 — pre-turn context assembly (plan-v3 §2.1). Register as the host's
   * `chat.message` hook (opencode + kilo; verified against docs 2026-09-20:
   * the hook mutates the user message parts before the LLM turn). DECISIONKIT_S0=0
   * disables; every failure fails open (no part appended). */
  "chat.message": (input: DecisionKitChatMessageInput, output: DecisionKitChatMessageOutput) => Promise<void>;
  /** Register as "decisionkit_locate" via the host's tool() helper. */
  locateTool: DecisionKitLocateToolDef;
}

const LOCATE_MAX_CANDIDATES = 30; // plan §2 Tier 2.5: ≤30 candidates per fan-out

// Side-effecting tools (lowercased names across opencode/kilo): the only ones
// where the guardrail can block something and the critic can catch real
// damage. read/ls results that returned content worked trivially — taxing
// them costs a jev round-trip per read with (measured) nothing to catch.
const SIDE_EFFECT_TOOLS = new Set(["bash", "powershell", "edit", "write", "multiedit", "applypatch", "patch"]);
// Discovery-shaped tools for the s0.wasted receipt.
const WASTE_DISCOVERY_TOOLS = new Set(["read", "ls", "bash"]);

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

const CACHE_CAP = 200;
const cachePut = (m: Map<string, Receipt>, k: string, v: Receipt): void => {
  if (m.size >= CACHE_CAP) m.clear();
  m.set(k, v);
};

// Bash `cat/head/tail <file>` is semantically read(file) — triage it so the
// agent cannot bypass read scoping through bash. Only single-file,
// no-shell-operators invocations qualify, and only above 4KB.
const BASH_PRINT_CMDS = new Set(["cat", "head", "tail"]);
const BASH_TRIAGE_MIN_BYTES = 4096;
const parseSingleFilePrint = (command: string, worktree: string): string | undefined => {
  if (/[|;&><`$]/.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 2 || tokens[0] === undefined || !BASH_PRINT_CMDS.has(tokens[0])) return undefined;
  const paths = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (paths.length !== 1) return undefined;
  const only = paths[0];
  if (only === undefined) return undefined;
  try {
    const s = statSync(resolve(worktree, only));
    return s.isFile() && s.size > BASH_TRIAGE_MIN_BYTES ? resolve(worktree, only) : undefined;
  } catch {
    return undefined;
  }
};

// Destructive-block escalation (measured on pi): after a block, the model
// retries command variations; repeats must get a hard stop.
const destructiveBlockReason = (count: number, receipt: Receipt): string => {
  if (count > 1) {
    return "DecisionKit guardrail: another destructive command blocked. STOP now — do not try other commands, workarounds, or variations. If the user wants this done, ask them to confirm the exact target and method.";
  }
  const d = (receipt.detail as { destructive?: number } | undefined)?.destructive;
  const s = (receipt.detail as { severity?: number } | undefined)?.severity;
  const scores = typeof d === "number" ? ` (p=${d.toFixed(2)}, severity=${typeof s === "number" ? s.toFixed(2) : "n/a"})` : "";
  return `DecisionKit guardrail: destructive operation blocked${scores}. Do not retry with alternative commands or workarounds — ask the user to confirm exactly what should be affected.`;
};

/**
 * Host-agnostic tool-hook implementation shared by every plugin-style adapter
 * (opencode, kilo; pi keeps its own full-tier adapter because turn routing is
 * pi-only). Adapters are pure translation: they inject their host's schema
 * builder and register the returned hooks under the host's hook names.
 *
 * Shipped in 0.1.2 (plan-v3 parity across hosts):
 *  - S0 pre-turn context assembly via `chat.message` (digest injected as an
 *    appended text part; cache-stable, fail-open).
 *  - Tax removal (§2.4): guardrail read-only fast path + verdict caches,
 *    critic non-empty fast path, triage caches.
 *  - Phase-aware read handling (§2.3): reads of S0-picked/related files are
 *    directed (never stubbed); other reads keep the post-hoc triage rewrite.
 *
 * Pack precedence: DECISIONKIT_PACK env (explicit override) > shipped
 * agent-calibrated default for `host`. There is no per-repo pack: defaults are
 * calibrated centrally per coding agent. Kill switch: DECISIONKIT_ENABLE=0.
 * Receipts: <worktree>/.decisionkit/receipts.jsonl.
 */
export function createDecisionKitHostHooks(opts: {
  worktree: string;
  /** Coding agent this instance runs under → shipped agent-calibrated pack. */
  host: PackHost;
  schema: DecisionKitSchemaBuilder;
  /** Extra core config (provider pin, thresholds, …) — resolved defaults otherwise. */
  config?: DecisionKitConfig;
}): DecisionKitHostHooks {
  const { worktree } = opts;
  const ledger = new InMemoryLedger(resolve(worktree, ".decisionkit/receipts.jsonl"));
  const core = new DecisionKitCore(
    {
      enabled: process.env.DECISIONKIT_ENABLE !== "0",
      ...(process.env.DECISIONKIT_PACK !== undefined
        ? { packPath: resolve(process.env.DECISIONKIT_PACK) }
        : { host: opts.host }),
      ...opts.config,
    },
    ledger,
  );

  // Per-session S0 bookkeeping (reset per user prompt): digest run state for
  // the waste receipt + directed-read exemption.
  interface S0Run {
    pickedAbs: Set<string>;
    relatedAbs: Set<string>;
    discovery: string[];
    digest: boolean;
  }
  const s0Runs = new Map<string, S0Run>();
  let taskContext = "";
  const guardrailCache = new Map<string, Receipt>();
  const triageCache = new Map<string, Receipt>();
  const destructiveBlocksBySession = new Map<string, number>();

  const wasteTarget = (tool: string, args: Record<string, unknown>): string[] => {
    const input: Record<string, unknown> = { ...args };
    if (tool !== "bash" && typeof input.command !== "string") {
      // normalize read/ls path args for extractDiscoveryPaths
      const p = input.filePath ?? input.file_path ?? input.path;
      if (typeof p === "string") input.path = p;
    }
    return WASTE_DISCOVERY_TOOLS.has(tool) ? extractDiscoveryPaths(tool, input, worktree) : [];
  };

  return {
    "tool.execute.before": async (input, output) => {
      const tool = input.tool.toLowerCase();
      const sessionID = input.sessionID ?? "";
      // S0 waste bookkeeping: discovery-shaped calls during a digest run.
      const run = s0Runs.get(sessionID) ?? (s0Runs.get("") ?? undefined);
      if (run !== undefined && run.digest) {
        run.discovery.push(...wasteTarget(tool, (output.args ?? {}) as Record<string, unknown>));
      }
      if (!SIDE_EFFECT_TOOLS.has(tool)) return;
      const args = (output.args ?? {}) as Record<string, unknown>;
      const command = typeof args.command === "string" ? args.command : undefined;
      const escalate = (): string => {
        const n = (destructiveBlocksBySession.get(sessionID) ?? 0) + 1;
        destructiveBlocksBySession.set(sessionID, n);
        return n > 1
          ? "DecisionKit guardrail: another destructive command blocked. STOP now — do not try other commands, workarounds, or variations. If the user wants this done, ask them to confirm the exact target and method."
          : "DecisionKit guardrail: destructive operation blocked. Do not retry this or attempt alternative commands/workarounds — ask the user to confirm exactly what should be affected.";
      };
      if (command !== undefined) {
        const key = command.trim().replace(/\s+/g, " ");
        const cached = guardrailCache.get(key);
        if (cached !== undefined) {
          ledger.record(cached);
          if (cached.decision.startsWith("block(")) throw new Error(escalate());
          return;
        }
        if (bashCommandIsReadOnly(command)) {
          // Guardrail fast path (plan-v3 §2.4): static read-only allowlist →
          // allow locally, no jev call.
          const receipt = localReceipt("guardrail", "allow(read-only-fastpath)", { command: key.slice(0, 120) });
          cachePut(guardrailCache, key, receipt);
          ledger.record(receipt);
          return;
        }
        const decision = await core.guardrail({ tool, toolInput: args });
        if (decision.receipt.ok && !decision.receipt.failOpen) cachePut(guardrailCache, key, decision.receipt);
        if (decision.action === "block") throw new Error(escalate());
        return;
      }
      // Non-bash side-effect tools (edit/write/applyPatch): the guardrail
      // verdict is a property of the TARGET, not the edit content — cache
      // allow verdicts per (tool, resolved path).
      const rawPath = args.path ?? args.filePath ?? args.file_path;
      const target = typeof rawPath === "string" && rawPath !== "" ? resolve(worktree, rawPath) : undefined;
      const key = target !== undefined ? `${tool}|${target}` : undefined;
      const cached = key !== undefined ? guardrailCache.get(key) : undefined;
      if (cached !== undefined) {
        ledger.record(cached);
        if (cached.decision.startsWith("block(")) throw new Error(escalate());
        return;
      }
      const decision = await core.guardrail({ tool, toolInput: args });
      if (decision.action !== "block" && key !== undefined && decision.receipt.ok && !decision.receipt.failOpen) {
        cachePut(guardrailCache, key, decision.receipt);
      }
      if (decision.action === "block") throw new Error(escalate());
    },

    "tool.execute.after": async (input, output) => {
      const tool = input.tool.toLowerCase();
      const args = (input.args ?? {}) as Record<string, unknown>;
      // Tier 3 — critic fast path (plan-v3 §2.4): a non-empty result on a
      // side-effect tool worked (measured 8/8 of calls in the taxed session);
      // jev only on empty/missing output. Read results that returned content
      // worked trivially — taxing them is a round-trip with nothing to catch.
      if (SIDE_EFFECT_TOOLS.has(tool)) {
        if (output.output.trim().length > 0) {
          ledger.record(localReceipt("critic", "ok(fastpath)", { tool, preview: output.output.slice(0, 120) }));
        } else {
          const decision = await core.critic({
            tool,
            toolInput: args,
            resultPreview: output.output,
            isError: false,
          });
          if (decision.action === "intervene" && decision.note !== undefined) {
            output.output = `${output.output}\n${decision.note}`;
          }
        }
      }
      // Tier 2.5 — read triage (post-hoc rewrite). Reads the S0 digest
      // directed (picked/related files) are exempt — they are the intended
      // outcome, not rediscovery (plan-v3 §2.3).
      const sessionID = input.sessionID ?? "";
      const run = s0Runs.get(sessionID) ?? s0Runs.get("");
      const readPath =
        typeof (args.filePath ?? args.path ?? args.file_path) === "string"
          ? String(args.filePath ?? args.path ?? args.file_path)
          : "";
      if (tool === "read" && readPath !== "") {
        const abs = resolve(worktree, readPath);
        if (run !== undefined && run.digest && (run.pickedAbs.has(abs) || run.relatedAbs.has(abs))) {
          return;
        }
        const key = `${abs}|${taskContext}`;
        const cached = triageCache.get(key);
        if (cached !== undefined) {
          ledger.record(cached);
          if (cached.decision.startsWith("stub(")) {
            output.output = "[decisionkit triage, cached] likely irrelevant to the current task — say so only if you still need it.";
          }
          return;
        }
        const triage = await core.triageRead({ path: abs, taskContext: taskContext || worktree });
        if (triage.receipt.ok && !triage.receipt.failOpen) cachePut(triageCache, key, triage.receipt);
        if (triage.action === "stub" && triage.reason !== undefined) {
          output.output = triage.reason;
        }
        return;
      }
      // Bash `cat|head|tail >4KB` triage (measured safe): the agent bypassing
      // read loses scoping there.
      if (tool === "bash" && typeof args.command === "string") {
        const printed = parseSingleFilePrint(args.command, worktree);
        if (printed !== undefined) {
          const key = `${printed}|${taskContext}`;
          const cached = triageCache.get(key);
          if (cached === undefined) {
            const triage = await core.triageRead({ path: printed, taskContext: taskContext || worktree });
            if (triage.receipt.ok && !triage.receipt.failOpen) cachePut(triageCache, key, triage.receipt);
            if (triage.action === "stub" && triage.reason !== undefined) {
              output.output = triage.reason;
            }
          } else {
            ledger.record(cached);
            if (cached.decision.startsWith("stub(")) {
              output.output = "[decisionkit triage, cached] likely irrelevant to the current task — say so only if you still need it.";
            }
          }
        }
      }
    },

    "chat.message": async (input, output) => {
      const sessionID = input.sessionID ?? "";
      // Waste receipt for the PREVIOUS digest run at this prompt boundary.
      const previous = s0Runs.get(sessionID);
      if (previous !== undefined && previous.digest) {
        const wasted = previous.discovery.filter(
          (p) => !previous.pickedAbs.has(p) && !previous.relatedAbs.has(p),
        ).length;
        ledger.record(
          localReceipt("s0", `waste(${wasted}/${previous.discovery.length})`, {
            discovery: previous.discovery.length,
            wasted,
          }),
        );
      }
      s0Runs.delete(sessionID);
      if (process.env.DECISIONKIT_S0 === "0" || process.env.DECISIONKIT_ENABLE === "0") return;
      // The prompt text: concat of the message's text parts (the parts array
      // is the host's user-message representation).
      const prompt = output.parts
        .map((p) => (p !== null && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
        .filter((t) => t !== "")
        .join("\n")
        .trim();
      if (prompt === "" || prompt.length > 4000) return;
      taskContext = prompt;
      try {
        const prep = await s0LocalPrep(prompt, worktree);
        const s0 = await finishS0({ decisionkit: core }, prep);
        ledger.record(
          localReceipt("s0", s0.digest !== undefined ? `digest(ms=${s0.ms},calls=${s0.jevCalls})` : `skip(${s0.skip ?? s0.failOpen ?? "no-digest"})`, {
            picked: s0.pickedRel,
            rejected: s0.rejected,
            candidates: s0.candidates,
            ms: s0.ms,
            jevCalls: s0.jevCalls,
          }),
        );
        if (s0.digest === undefined) return;
        s0Runs.set(sessionID, {
          pickedAbs: new Set(s0.picked.map((p) => resolve(p))),
          relatedAbs: new Set(s0.related.map((p) => resolve(worktree, p))),
          discovery: [],
          digest: true,
        });
        // Append-only digest part (cache-stable): one text part after the
        // user's own parts, never a rewrite of them.
        output.parts.push({ type: "text", text: `${s0.digest}\n\n---\n\nUse this context first; request any "Not read" file explicitly if needed.` });
      } catch {
        // fail-open: no digest, no part, the turn proceeds untouched.
      }
    },

    locateTool: {
      description:
        "Find files relevant to a query. Cheaper than multiple grep+read rounds: returns a ranked shortlist.",
      args: {
        query: opts.schema.string().describe("Filename or content pattern"),
        task: opts.schema.string().describe("What the current task needs from these files"),
      },
      async execute(args) {
        let candidates: string[] = [];
        try {
          const rg = await execFileAsync("rg", ["--files", "-g", `*${args.query}*`], {
            cwd: worktree,
            timeout: 3000,
          });
          candidates = rg.stdout.split("\n").filter(Boolean).slice(0, LOCATE_MAX_CANDIDATES);
        } catch {
          candidates = [];
        }
        if (candidates.length === 0) {
          // Filename-only search misses content-only subjects (measured: the
          // task's subject word often exists in no filename). Fall back to a
          // bounded content sweep over the same generic enumeration the S0
          // sweep uses.
          candidates = await contentFileSearch(worktree, args.query, 6000);
        }
        if (candidates.length === 0) {
          return `No files matching ${args.query}`;
        }
        taskContext = args.task;
        const located = await core.locate({ task: args.task, candidates });
        if (located.ranked.length === 0 || located.receipt.failOpen === true) {
          return candidates.slice(0, 10).join("\n");
        }
        const ranked = [
          located.ranked[0] ?? candidates[0] ?? "",
          ...located.ranked.slice(1),
        ].filter(Boolean);
        return ranked.join("\n");
      },
    },
  };
}
