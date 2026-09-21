#!/usr/bin/env node
import { runEval, formatReport } from "./eval.js";
import { capabilityMatrix, runInit, runRemove } from "./init.js";
import { resolveProvider } from "./providers.js";
import type { PackHost } from "./packs.js";
import type { DecisionKitTier } from "./types.js";

interface Args {
  tier?: DecisionKitTier;
  pack?: string;
  agent?: PackHost;
  set?: string;
  runs?: number;
  json?: boolean;
}

const TIERS: DecisionKitTier[] = ["routing", "triage", "guardrail", "critic", "locate"];
const AGENTS: PackHost[] = ["pi", "opencode", "kilo", "claude", "codex"];

function usage(): string {
  return `decisionkit — a decision layer for your coding agent, pre-calibrated per agent.

Usage:
  decisionkit init [--agent <pi|opencode|kilo|claude|codex>] [--dev]
                   [--tarballs <dir-of-npm-pack-tgz>]
  decisionkit remove [--agent <name>]
  decisionkit test [--tier <routing|triage|guardrail|critic>]
                   [--agent <pi|opencode|kilo|claude|codex>]
                   [--pack <pack.json>] [--set <eval-set.json>] [--runs <n>] [--json]
  decisionkit matrix

Commands:
  init          Detect (or pick with --agent) the coding agent and install the
                DecisionKit adapter. Prints the capability matrix first — Tier 2
                turn routing is pi-only today; other hosts get guardrail +
                triage + critic + decisionkit_locate per their hook surfaces.
                --dev links the local monorepo packages with file: instead of
                npm specs (development only). --tarballs installs from local
                npm pack tarballs instead of the registry (offline M5
                acceptance check; same code path as a registry install).
  remove        Undo init for the detected (or --agent) host.
  test          Run the labeled eval set(s) through the pack and print a verdict
                per tier (accuracy, gate, separation, suggested threshold).
                Exit 0 = all gated tiers pass, 1 = gate failure.
  matrix        Print the per-host capability matrix.

Notes:
  - Packs ship pre-calibrated per coding agent (tier set per verified hook
    surface, wording measured once on the central rigs). There is no per-repo
    calibration: if a tier fails its gate here, that is a default-pack bug to
    fix in the central harness (packages/core/scripts), never per repo.
  - test requires OPENROUTER_API_KEY (preferred) or TYPESAFE_API_KEY in the
    environment (DecisionKit / TypeSafe API).
  - All gated tiers run by default; --tier runs one (locate has no shipped set).
  - --agent evals that agent's shipped pack; --pack overrides with an explicit
    pack file (central benchmarks/experiments).
  - Codex installs require a one-time /hooks trust review inside Codex before
    the hooks run (upstream requirement, surfaced at install time).`;
}

function parseArgs(argv: string[]): Args | undefined {
  const args: Args = {};
  const next = (): string | undefined => argv[++i];
  let i = -1;
  while (i < argv.length - 1) {
    const a = next();
    if (a === "--json") args.json = true;
    else if (a === "--tier") {
      const v = next();
      if (v === undefined) return undefined;
      args.tier = v as DecisionKitTier;
    } else if (a === "--pack") {
      const v = next();
      if (v === undefined) return undefined;
      args.pack = v;
    } else if (a === "--agent") {
      const v = next();
      if (v === undefined) return undefined;
      args.agent = v as PackHost;
    } else if (a === "--set") {
      const v = next();
      if (v === undefined) return undefined;
      args.set = v;
    } else if (a === "--runs") {
      const v = next();
      if (v === undefined || Number.isNaN(Number(v))) return undefined;
      args.runs = Number(v);
    } else return undefined;
  }
  if (args.tier !== undefined && !TIERS.includes(args.tier)) return undefined;
  if (args.agent !== undefined && !AGENTS.includes(args.agent)) return undefined;
  return args;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h" || cmd === undefined) {
    console.log(usage());
    return 0;
  }
  if (cmd !== "test" && cmd !== "init" && cmd !== "remove" && cmd !== "matrix") {
    console.error(usage());
    return 2;
  }
  if (cmd === "matrix") {
    console.log(capabilityMatrix());
    return 0;
  }
  if (cmd === "init") return runInit(rest);
  if (cmd === "remove") return runRemove(rest);
  const args = parseArgs(rest);
  if (args === undefined) {
    console.error(usage());
    return 2;
  }
  if (resolveProvider({}) === undefined) {
    console.error(
      "error: no DecisionKit provider key found — set OPENROUTER_API_KEY (preferred: env, .env, or your coding agent's key) or TYPESAFE_API_KEY (https://typesafe.ai)",
    );
    return 2;
  }
  try {
    const report = await runEval({
      ...(args.tier !== undefined ? { tier: args.tier } : {}),
      ...(args.pack !== undefined ? { packPath: args.pack } : {}),
      ...(args.agent !== undefined ? { agent: args.agent } : {}),
      ...(args.set !== undefined ? { setPath: args.set } : {}),
      ...(args.runs !== undefined ? { runs: args.runs } : {}),
    });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report));
    }
    return report.allPass ? 0 : 1;
  } catch (err) {
    console.error("error:", err instanceof Error ? err.message : err);
    return 2;
  }
}

process.exitCode = await main();
