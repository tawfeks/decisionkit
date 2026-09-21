/**
 * Digest smoke probe — runs the S0 state machine (local prep + jev assemble
 * rounds) directly against a repo — no frontier, no pi session. Use it to
 * calibrate digests BEFORE spending frontier runs: picked/rejected/
 * candidates/rounds tell you exactly what the digest will cover and where it
 * will waste.
 *
 *   npx tsx bench/smoke.ts --repo ./tested-repo --prompt "fix the ... issue"
 *
 * API keys come from the workspace .env (providers read process env).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DecisionKitCore } from "decisionkit-core";
import { InMemoryLedger } from "decisionkit-core";
import { runS0 } from "../packages/pi-ext/src/s0.js";

function argValue(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length && process.argv[i + 1] !== undefined
    ? process.argv[i + 1]
    : def;
}

// First non-flag argument = the prompt (positional UX, same as bench/run.ts).
const positional = process.argv.slice(2).filter((a, i, arr) => {
  const prev = i > 0 ? arr[i - 1] : "";
  return !a.startsWith("--") && !["--repo", "--prompt"].includes(prev) && !/^\d+$/.test(a);
}).join(" ");

const repo = argValue("--repo") ?? resolve(import.meta.dirname, "../tested-repo");
const prompt = argValue("--prompt") ?? positional;
if (prompt === undefined || prompt === "") {
  console.error(`usage: smoke.ts [--repo <repo>] "prompt"\n       smoke.ts --repo ./tested-repo --prompt "fix the ... issue"\n(default repo: ./tested-repo — put or clone any repo there)`);
  process.exit(1);
}

// Providers read process env; load the workspace .env if keys are not set.
const envPath = resolve(import.meta.dirname, "../.env");
try {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m !== null && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch {
  // no .env — assume keys are already in the environment
}

const decisionkit = new DecisionKitCore(
  { enabled: true, model: "jev-1.13.0", timeoutMs: Number(process.env.DECISIONKIT_TIMEOUT_MS ?? "10000") },
  new InMemoryLedger(),
);
const outcome = await runS0({ decisionkit }, prompt, repo);
console.log(
  JSON.stringify(
    {
      picked: outcome.pickedRel,
      rejected: outcome.rejected,
      related: outcome.related,
      flows: outcome.flows,
      candidates: outcome.candidates,
      ms: outcome.ms,
      jevCalls: outcome.jevCalls,
      skip: outcome.skip,
      failOpen: outcome.failOpen,
    },
    null,
    2,
  ),
);
