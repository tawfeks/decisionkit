import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Receipt, RoutingDecision } from "decisionkit-core";
import { InMemoryLedger, DecisionKitCore } from "decisionkit-core";
// Discovery-shaped bash for the s0.wasted receipt lives in decisionkit-core
// (shared with the opencode/kilo plugin factory).
import { contentFileSearch, s0LocalPrep, finishS0 } from "decisionkit-core";
import { bashCommandIsReadOnly, extractDiscoveryPaths } from "decisionkit-core";

const execFileAsync = promisify(execFile);

const ROUTABLE_TOOLS = ["read", "ls"] as const;
const PATH_TOKEN = /[A-Za-z0-9@_.~-]+(?:\/[A-Za-z0-9@_.~-]+)*\.[A-Za-z0-9]{1,6}/g;
const TOP_LISTING_LIMIT = 50; // plan §2: ≤50-entry top-level listing in routing state

const topListing = async (cwd: string): Promise<string[]> => {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    return entries
      .filter((e) => e.name !== "node_modules" && e.name !== ".git")
      .slice(0, TOP_LISTING_LIMIT)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    return [];
  }
};

const gitStatusTop = async (cwd: string): Promise<string | undefined> => {
  try {
    const res = await execFileAsync("git", ["status", "--porcelain"], { cwd, timeout: 2000 });
    return res.stdout.split("\n").filter(Boolean).slice(0, 20).join("\n") || undefined;
  } catch {
    return undefined;
  }
};

// `cat/head/tail <file>` is semantically read(file) — without triaging it, the
// agent bypasses read scoping by exploring through bash and ships whole files
// into history. Only single-file, no-shell-operators invocations qualify, and
// only when the file is big enough to be worth a judgment call (≤4KB costs
// ~1K tokens in history — cheaper than a DecisionKit round-trip). Scoping is NOT
// applied to bash (rewriting shell strings risks breakage worth more than the
// tokens saved) — the stub still removes irrelevant reads.
const BASH_PRINT_CMDS = new Set(["cat", "head", "tail"]);
const BASH_TRIAGE_MIN_BYTES = 4096;
const parseSingleFilePrint = async (command: string, cwd: string): Promise<string | undefined> => {
  if (/[|;&><`$]/.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 2 || tokens[0] === undefined || !BASH_PRINT_CMDS.has(tokens[0])) return undefined;
  const paths = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (paths.length !== 1) return undefined;
  const only = paths[0];
  if (only === undefined) return undefined;
  const p = resolve(cwd, only);
  try {
    const s = await stat(p);
    return s.isFile() && s.size > BASH_TRIAGE_MIN_BYTES ? p : undefined;
  } catch {
    return undefined;
  }
};

// Extract a real path from a routed prompt: candidate path-like tokens that
// exist on disk, longest first. Returns undefined when nothing matches.
const extractPath = async (text: string, cwd: string): Promise<string | undefined> => {
  const candidates = [...new Set(text.match(PATH_TOKEN) ?? [])].sort(
    (a, b) => b.length - a.length,
  );
  for (const c of candidates) {
    const p = resolve(cwd, c);
    try {
      await stat(p);
      return p;
    } catch {
      // not a file — keep scanning
    }
  }
  return undefined;
};
const OVERLAY_KEY = "decisionkit";
const RECEIPT_ENTRY = "decisionkit-receipt";

export interface DecisionKitPiOptions {
  ledgerPath?: string;
  decisionkit?: ConstructorParameters<typeof DecisionKitCore>[0];
}

const overlayLines = (ledger: InMemoryLedger): string[] => {
  const t = ledger.totals();
  const routed = ledger
    .all()
    .filter((r) => r.tier === "routing" && r.decision.startsWith("route(")).length;
  const blocked = ledger
    .all()
    .filter((r) => r.tier === "guardrail" && r.decision.startsWith("block(")).length;
  const cost = ((t.inputTokens / 1_000_000) * 0.042).toFixed(5);
  return [
    `decisionkit: ${t.calls} calls | routed turns: ${routed} | blocked: ${blocked} | fail-open: ${t.failOpen}`,
    `decisionkit: in ${t.inputTokens} tok ($${cost} @ $0.042/M in) | p50 ${t.latencyMsP50}ms | p95 ${t.latencyMsP95}ms`,
  ];
};

// ---------------------------------------------------------------------------
// S0 state (plan-v3 §2.1): per-task-run bookkeeping for the digest, frontier
// turn counting, and the visible-waste receipt.
// ---------------------------------------------------------------------------
interface S0RunState {
  pickedRel: Set<string>;
  /** Digest-named references (Related/Flows) — reads of these are directed,
   * not waste. */
  relatedRel: Set<string>;
  discovery: string[];
  ms: number;
  jevCalls: number;
}
interface FastPathReceipt {
  decision: string;
  detail?: Record<string, unknown>;
}
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

// Discovery-shaped bash: contributes to the s0.wasted receipt (frontier
// re-discovery whose targets ≠ S0-picked files).
const SIDE_EFFECT_TOOLS = new Set(["bash", "powershell", "edit", "write", "multiEdit", "applyPatch"]);

export default function decisionkitExtension(pi: ExtensionAPI, options: DecisionKitPiOptions = {}): void {
  const ledger = new InMemoryLedger(
    options.ledgerPath ?? process.env.DECISIONKIT_LEDGER_PATH,
  );
  const decisionkitCfg = options.decisionkit ?? {
    enabled: process.env.DECISIONKIT_ENABLE !== "0",
    model: process.env.DECISIONKIT_MODEL ?? "jev-1.13.0",
    timeoutMs: Number(process.env.DECISIONKIT_TIMEOUT_MS ?? "10000"),
    // Pack precedence: explicit config > DECISIONKIT_PACK env (override) >
    // shipped pi-calibrated default. No per-repo pack: calibration is central.
    ...(process.env.DECISIONKIT_PACK !== undefined ? { packPath: resolve(process.env.DECISIONKIT_PACK) } : { host: "pi" as const }),
  };
  const decisionkit = new DecisionKitCore(decisionkitCfg, ledger);
  let taskContext = "";

  // S0 / run bookkeeping (reset per user prompt).
  let s0Run: S0RunState | undefined;
  let frontierTurns = 0;
  let widgetS0 = { ms: 0, calls: 0, wasted: 0, digest: false };
  // Verdict caches (plan-v3 §2.4): per normalized command / (path, task).
  const guardrailCache = new Map<string, Receipt>();
  const triageCache = new Map<string, Receipt>();
  // Destructive-block escalation: a blocked destructive attempt must END the
  // attempt. The measured failure was a retry loop — the model kept trying
  // command variations, each triggering the same warning. After the first
  // block, repeats get a hard stop; after two, the stop is unambiguous.
  let destructiveBlocks = 0;
  const destructiveBlockReason = (receipt: Receipt): string => {
    destructiveBlocks++;
    if (destructiveBlocks > 1) {
      return "[decisionkit guardrail] Another destructive command blocked. STOP now — do not try other commands, workarounds, or variations. If the user wants this done, ask them to confirm the exact target and method.";
    }
    const d = (receipt.detail as { destructive?: number } | undefined)?.destructive;
    const s = (receipt.detail as { severity?: number } | undefined)?.severity;
    const scores = typeof d === "number" ? ` (p=${d.toFixed(2)}, severity=${typeof s === "number" ? s.toFixed(2) : "n/a"})` : "";
    return `[decisionkit guardrail] Destructive operation blocked${scores}. Do not retry with alternative commands or workarounds — ask the user to confirm exactly what should be affected.`;
  };
  const CACHE_CAP = 200;
  const cachePut = (m: Map<string, Receipt>, k: string, v: Receipt): void => {
    if (m.size >= CACHE_CAP) m.clear();
    m.set(k, v);
  };

  const track = (ctx: ExtensionContext, receipt: Receipt): void => {
    pi.appendEntry(RECEIPT_ENTRY, receipt as unknown as Record<string, unknown>);
    if (ctx.hasUI) ctx.ui.setWidget(OVERLAY_KEY, widget(ledger, frontierTurns, widgetS0));
  };

  const widget = (
    l: InMemoryLedger,
    turns: number,
    s0: { ms: number; calls: number; wasted: number; digest: boolean },
  ): string[] => [
    ...overlayLines(l),
    `decisionkit: frontier turns: ${turns} | s0: ms=${s0.ms} calls=${s0.calls} wasted=${s0.wasted}${s0.digest ? "" : " (no digest)"}`,
  ];

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget(OVERLAY_KEY, widget(ledger, frontierTurns, widgetS0));
  });

  // Tier 2 — turn routing is OFF by default (plan-v3 §0: it needs explicit
  // file language, measured 0 routed turns on real task prompts, and its
  // `handled` path deleted the read from session history — a bare "read
  // file.md" routed to a UI notify left nothing in context for follow-ups).
  // The S0 tier covers task prompts; DECISIONKIT_ROUTING=1 restores the
  // legacy confidence-gated turn routing for hosts/evals that want it.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    // Last user prompt is the task context the triage/critic questions ask
    // about ("Is this file needed for the CURRENT TASK?") — without it they
    // fall back to judging against the cwd, which is not a task.
    taskContext = event.text;
    // New task run: reset frontier-turn + discovery + escalation bookkeeping.
    frontierTurns = 0;
    s0Run = undefined;
    destructiveBlocks = 0;
    // P2 latency hygiene: the S0 local sweep (terms → fan-out → cards, zero
    // jev calls) runs while the legacy routing round trip (if enabled) is in
    // flight; alone, it runs directly. When routing routes, the sweep is
    // discarded (local CPU only, no tokens).
    const s0Enabled = process.env.DECISIONKIT_S0 !== "0";
    const prepPromise = s0Enabled
      ? s0LocalPrep(event.text, ctx.cwd).catch(() => undefined)
      : undefined;
    let decision: RoutingDecision | undefined;
    if (process.env.DECISIONKIT_ROUTING === "1") {
      const gitStatus = await gitStatusTop(ctx.cwd);
      decision = await decisionkit.routing({
        prompt: event.text,
        cwd: ctx.cwd,
        registeredTools: [...ROUTABLE_TOOLS],
        // exactOptionalPropertyTypes: only pass gitStatus when present.
        ...(gitStatus !== undefined ? { gitStatus } : {}),
        fileListing: await topListing(ctx.cwd),
      });
      track(ctx, decision.receipt);
    }
    if (decision === undefined || decision.action !== "route" || decision.tool === undefined) {
      // S0 — pre-turn context assembly (plan-v3 §2.1), for task prompts the
      // routing tier passed through. DECISIONKIT_S0=0 disables; fail-open is
      // inside finishS0 (no digest ⇒ continue untouched).
      const prep = s0Enabled ? await prepPromise : undefined;
      if (prep !== undefined) {
        const s0 = await finishS0({ decisionkit }, prep);
        widgetS0 = {
          ms: s0.ms,
          calls: s0.jevCalls,
          wasted: 0,
          digest: s0.digest !== undefined,
        };
        pi.appendEntry("decisionkit-s0", {
          task: event.text,
          picked: s0.pickedRel,
          rejected: s0.rejected,
          related: s0.related,
          flows: s0.flows,
          diff: s0.diff,
          ms: s0.ms,
          jevCalls: s0.jevCalls,
          candidates: s0.candidates,
          // Round-level pick/confidence/sufficiency receipts — without these a
          // postmortem needs DECISIONKIT_LEDGER_PATH set in advance.
          receipts: s0.receipts.map((r) => ({
            decision: r.decision,
            latencyMs: r.latencyMs,
            ok: r.ok,
            detail: r.detail,
          })),
          ...(s0.skip !== undefined ? { skip: s0.skip } : {}),
          ...(s0.failOpen !== undefined ? { failOpen: s0.failOpen } : {}),
        });
        if (s0.digest !== undefined) {
          s0Run = {
            pickedRel: new Set(s0.pickedRel),
            relatedRel: new Set(s0.related),
            discovery: [],
            ms: s0.ms,
            jevCalls: s0.jevCalls,
          };
          // Answer-only tier (plan-v3 §2.2): factual lookups the digest can
          // answer verbatim skip the frontier entirely. Default off until
          // evals pass (DECISIONKIT_ANSWER_ONLY=1). The pre-gate is
          // language-agnostic on purpose: short prompt + digest presence;
          // the noul threshold does the rest.
          if (process.env.DECISIONKIT_ANSWER_ONLY === "1" && event.text.length < 200) {
            const answer = await decisionkit.s0Answer({ task: event.text, digestLines: s0.digestLines });
            track(ctx, answer.receipt);
            if (answer.verbatim !== undefined && answer.verbatim.idx > 0) {
              const out = `${answer.verbatim.line} (decisionkit-s0, from ${s0.pickedRel.join(", ") || "digest"})`;
              if (ctx.hasUI) ctx.ui.notify(`[decisionkit answered from digest]\n${out}`, "info");
              return { action: "handled" };
            }
          }
          // P0 cache-neutral injection: merge the digest into the user prompt
          // via input-transform instead of a separate custom message. A
          // nextTurn custom message re-anchored the prompt prefix and broke
          // the prompt cache every turn after (measured CH 74.9% vs 99.5%,
          // ↑59k vs ↑19k); one merged message is append-only and cache-stable
          // (verified: pi runner applies input transforms before the loop).
          return {
            action: "transform",
            text: `${s0.digest}\n\n---\n\n${event.text}`,
            ...(event.images !== undefined ? { images: event.images } : {}),
          };
        }
      }
      if (ctx.hasUI) ctx.ui.setWidget(OVERLAY_KEY, widget(ledger, frontierTurns, widgetS0));
      return { action: "continue" };
    }
    let target = await extractPath(event.text, ctx.cwd);
    let output: string;
    try {
      if (decision.tool === "read" && target !== undefined) {
        output = await readFile(target, "utf8");
      } else if (decision.tool === "read") {
        // Routed to read but no resolvable file in the prompt — degrade to a
        // directory listing rather than guessing a path.
        output = `No file matched the prompt; directory listing of ${ctx.cwd}:\n` +
          (await readdir(ctx.cwd)).join("\n");
      } else {
        output = (await readdir(target ?? ctx.cwd)).join("\n");
      }
    } catch (err) {
      output = `error: ${String(err)}`;
    }
    output = output.slice(0, 4000);
    pi.appendEntry("decisionkit-routed", { prompt: event.text, tool: decision.tool, output });
    if (ctx.hasUI) ctx.ui.notify(`[decisionkit routed to ${decision.tool}]\n${output}`, "info");
    return { action: "handled" };
  });

  // Frontier turn counting (headline metric) — assistant messages per run.
  pi.on("turn_end", async (_event, ctx) => {
    if (_event.message.role === "assistant") frontierTurns++;
    if (ctx.hasUI) ctx.ui.setWidget(OVERLAY_KEY, widget(ledger, frontierTurns, widgetS0));
    return undefined;
  });

  // Run-end waste accounting.
  pi.on("agent_end", async (_event, ctx) => {
    if (s0Run !== undefined) {
      const picked = s0Run.pickedRel;
      // discovery paths are absolute (extractDiscoveryPaths resolves against
      // cwd); picked are cwd-relative — compare on the same axis, else every
      // re-read of a picked file counts as wasted.
      const pickedAbs = new Set([...picked].map((rel) => resolve(ctx.cwd, rel)));
      // Files the digest named as deterministic references (Related/Flows) are
      // digest-directed reads, not rediscovery: a frontier read of one is the
      // intended outcome. Only targets the digest never mentioned count as waste.
      const relatedAbs = new Set([...s0Run.relatedRel].map((rel) => resolve(ctx.cwd, rel)));
      const wasted = s0Run.discovery.filter((p) => !pickedAbs.has(p) && !relatedAbs.has(p)).length;
      widgetS0 = { ...widgetS0, wasted };
      pi.appendEntry("decisionkit-s0-waste", {
        discovery: s0Run.discovery,
        picked: [...picked],
        related: [...s0Run.relatedRel],
        wasted,
      });
      s0Run = undefined;
      if (ctx.hasUI) ctx.ui.setWidget(OVERLAY_KEY, widget(ledger, frontierTurns, widgetS0));
    }
    return undefined;
  });

  // Tier 1 — guardrail gate (can block) + Tier 2.5 — phase-aware read scoping.
  pi.on("tool_call", async (event, ctx) => {
    // S0 waste bookkeeping: discovery-shaped calls during a digest run.
    if (s0Run !== undefined) {
      s0Run.discovery.push(...extractDiscoveryPaths(event.toolName, event.input, ctx.cwd));
    }

    if (SIDE_EFFECT_TOOLS.has(event.toolName)) {
      // Guardrail fast path (plan-v3 §2.4): static read-only allowlist → allow
      // locally, no jev call; verdicts cached per normalized command.
      if (event.toolName === "bash" && typeof (event.input as { command?: unknown }).command === "string") {
        const command = (event.input as { command: string }).command;
        const key = command.trim().replace(/\s+/g, " ");
        const cached = guardrailCache.get(key);
        if (cached !== undefined) {
          track(ctx, cached);
          // SAFETY: a cached block verdict must re-block. (Measured bug: the
          // cache replay tracked the receipt and fell through — an identical
          // destructive command was allowed on its second attempt.)
          if (cached.decision.startsWith("block(")) {
            const reason = destructiveBlockReason(cached);
            if (ctx.hasUI) ctx.ui.notify(reason, "warning");
            return { block: true, reason };
          }
        } else if (bashCommandIsReadOnly(command)) {
          const receipt = localReceipt("guardrail", "allow(read-only-fastpath)", { command: key.slice(0, 120) });
          cachePut(guardrailCache, key, receipt);
          track(ctx, receipt);
        } else {
          const decision = await decisionkit.guardrail({
            tool: event.toolName,
            toolInput: event.input,
          });
          if (decision.receipt.ok && !decision.receipt.failOpen) cachePut(guardrailCache, key, decision.receipt);
          track(ctx, decision.receipt);
          if (decision.action === "block") {
            const reason = destructiveBlockReason(decision.receipt);
            if (ctx.hasUI) ctx.ui.notify(reason, "warning");
            return { block: true, reason };
          }
        }
      } else {
        // Non-bash side-effect tools (edit/write/applyPatch): the guardrail
        // verdict is a property of the TARGET, not the edit content — cache
        // allow verdicts per (tool, resolved path). The measured session sent
        // 6 edits to one file through 6 identical jev calls.
        const rawPath = (event.input as { path?: unknown }).path ?? (event.input as { filePath?: unknown }).filePath;
        const target = typeof rawPath === "string" && rawPath !== "" ? resolve(ctx.cwd, rawPath) : undefined;
        const key = target !== undefined ? `${event.toolName}|${target}` : undefined;
        const cached = key !== undefined ? guardrailCache.get(key) : undefined;
        if (cached !== undefined) {
          track(ctx, cached);
          if (cached.decision.startsWith("block(")) {
            const reason = destructiveBlockReason(cached);
            if (ctx.hasUI) ctx.ui.notify(reason, "warning");
            return { block: true, reason };
          }
        } else {
          const decision = await decisionkit.guardrail({
            tool: event.toolName,
            toolInput: event.input,
          });
          track(ctx, decision.receipt);
          if (
            decision.action !== "block" && key !== undefined
            && decision.receipt.ok && !decision.receipt.failOpen
          ) {
            cachePut(guardrailCache, key, decision.receipt);
          }
          if (decision.action === "block") {
            const reason = destructiveBlockReason(decision.receipt);
            if (ctx.hasUI) ctx.ui.notify(reason, "warning");
            return { block: true, reason };
          }
        }
      }
    }

    // Phase rule (plan-v3 §2.3): FRONTIER-initiated reads are unscoped by
    // default — they are usually edit targets or follow-ups, and wrongly
    // scoping causes a second read (more context, not less). S0 reads happen
    // inside the extension and are scoped there. The edit-window rule needs no
    // enforcement while reads are unscoped. Bash `cat|head|tail >4KB` triage
    // stays (measured safe): the agent bypassing read loses scoping there.
    if (event.toolName === "bash" && typeof (event.input as { command?: unknown }).command === "string") {
      const command = (event.input as { command: string }).command;
      const printed = await parseSingleFilePrint(command, ctx.cwd);
      if (printed !== undefined) {
        const key = `${printed}|${taskContext}`;
        const cached = triageCache.get(key);
        const triage =
          cached !== undefined
            ? undefined
            : await decisionkit.triageRead({ path: printed, taskContext: taskContext || ctx.cwd });
        if (triage !== undefined) {
          track(ctx, triage.receipt);
          if (triage.receipt.ok && !triage.receipt.failOpen) cachePut(triageCache, key, triage.receipt);
          if (triage.action === "stub") {
            return { block: true, reason: triage.reason ?? "stubbed by decisionkit" };
          }
        } else if (cached !== undefined) {
          // Cached verdict re-applied without a new jev call.
          track(ctx, cached);
          if (cached.decision.startsWith("stub(")) {
            return {
              block: true,
              reason: "[decisionkit triage, cached] likely irrelevant to the current task — say so only if you still need it.",
            };
          }
        }
      }
    }
    return undefined;
  });

  // Tier 3 — critic. Appends a corrective note without burning an LLM turn.
  // Fast path (plan-v3 §2.4): `!isError && non-empty result` → ok locally
  // (measured 8/8 of calls); jev only on error/empty/suspicious results.
  pi.on("tool_result", async (event, ctx) => {
    if (!SIDE_EFFECT_TOOLS.has(event.toolName)) return undefined;
    const text = event.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    if (!event.isError && text.trim().length > 0) {
      track(ctx, localReceipt("critic", "ok(fastpath)", { tool: event.toolName, preview: text.slice(0, 120) }));
      return undefined;
    }
    const decision = await decisionkit.critic({
      tool: event.toolName,
      toolInput: event.input,
      resultPreview: text,
      isError: event.isError,
      taskContext: taskContext || ctx.cwd,
    });
    track(ctx, decision.receipt);
    if (decision.action === "intervene" && decision.note !== undefined) {
      return {
        content: [...event.content, { type: "text" as const, text: decision.note }],
      };
    }
    return undefined;
  });

  // decisionkit_locate nudge — registered tools with promptGuidelines alone get ignored
  // by most agent models (measured: 0 decisionkit_locate calls in the M3 run). A named
  // system-prompt guideline is the reliable way to surface an optional tool;
  // pi diffs guideline changes per turn and patches only the delta, so a static
  // bullet costs no per-turn tokens after the first turn. promptGuidelines is
  // used (not sections) because it exists in both the shipped 0.85.1 and the
  // workspace pi types.
  pi.on("before_agent_start", async (event, _ctx) => {
    const guidance =
      "File exploration: before chaining grep → read across several similarly-named files, call decisionkit_locate once — it returns a DecisionKit-ranked shortlist of relevant files in one call. Read only the shortlisted files. Prefer the read tool over cat/head/tail in bash: decisionkit scopes reads automatically.";
    const guidelines = event.systemPromptOptions.promptGuidelines;
    if (guidelines !== undefined && !guidelines.includes(guidance)) guidelines.push(guidance);
    return undefined;
  });

  // decisionkit_locate — cheap local candidates, one DecisionKit fan-out to rank.
  pi.registerTool({
    name: "decisionkit_locate",
    label: "DecisionKit Locate",
    description:
      "Find files relevant to a query. Cheaper than multiple grep+read rounds: returns a ranked shortlist.",
    promptSnippet: "Rank files relevant to a task in one call",
    promptGuidelines: [
      "Use decisionkit_locate when you would otherwise grep and read several near-miss files.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Filename or content pattern" }),
      task: Type.String({ description: "What the current task needs from these files" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: { matches: [] } };
      }
      let candidates: string[] = [];
      try {
        const rg = await execFileAsync(
          "rg",
          ["--files", "-g", `*${params.query}*`],
          { cwd: ctx.cwd, timeout: 3000 },
        );
        candidates = rg.stdout.split("\n").filter(Boolean).slice(0, 30);
      } catch {
        // rg may be missing/aliased-broken on some machines (measured on this
        // dev box) — fall back to find, as the M2 locate eval does.
        try {
          const found = await execFileAsync(
            "find",
            [".", "-name", `*${params.query}*`, "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/.m3-sessions/*"],
            { cwd: ctx.cwd, timeout: 5000 },
          );
          candidates = found.stdout.split("\n").filter(Boolean).slice(0, 30);
        } catch {
          candidates = [];
        }
      }
      if (candidates.length === 0) {
        // Filename-only search misses content-only subjects (measured:
        // "greenland" exists in no filename but in the map data's contents).
        // Fall back to a bounded content sweep over the same generic file
        // enumeration the S0 sweep uses.
        candidates = await contentFileSearch(ctx.cwd, params.query, 6000);
      }
      if (candidates.length === 0) {
        return {
          content: [{ type: "text", text: `No files matching ${params.query}` }],
          details: { matches: [] },
        };
      }
      taskContext = params.task;
      const located = await decisionkit.locate({ task: params.task, candidates });
      if (!located.ranked_ || located.receipt.failOpen === true) {
        return {
          content: [{ type: "text", text: candidates.slice(0, 10).join("\n") }],
          details: { matches: candidates.slice(0, 10), ranked: false },
        };
      }
      const ranked = located.ranked;
      const ranked2 = [
        ranked[0] ?? candidates[0] ?? "",
        ...ranked.slice(1),
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: ranked2.join("\n") }],
        details: { matches: ranked2, ranked: true, scores: located.scores },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    await ledger.flush();
  });
}
