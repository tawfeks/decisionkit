/**
 * M0 ground-truth probe: empirical input-limit + latency measurement.
 *
 * Usage: npx tsx --env-file=../../.env packages/core/scripts/m0-probe.ts
 * (run from repo root, or set TYPESAFE_API_KEY in env)
 *
 * 1. Binary-searches the state size where systemOne starts failing (422/413/400).
 * 2. Collects p50/p95 latency at a comfortable working size.
 */
import { score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ retry: { maxRetries: 0 }, timeout: 30_000 });

const FILLER = "The quick brown fox jumps over the lazy dog near the riverbank. ";
// ~14 tokens per repetition at ~3.9 chars/token
const tokensFor = (reps: number) => Math.round((reps * FILLER.length) / 3.9);

interface ProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  inputTokens?: number;
  message?: string;
}

async function probe(reps: number): Promise<ProbeResult> {
  const state = {
    task: "Estimate the size of this context.",
    content: FILLER.repeat(reps),
  };
  const started = Date.now();
  try {
    const res = await client.systemOne({
      state,
      questions: { rating: score("How long is this text?", ["short", "medium", "long"]) },
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      inputTokens: res.usage.input_tokens,
    };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return {
      ok: false,
      status: e.status,
      latencyMs: Date.now() - started,
      message: e.message?.slice(0, 200),
    };
  }
}

async function main(): Promise<void> {
  // Sanity check with a tiny state first.
  const warm = await probe(1);
  console.log(`[probe] warm-up: ok=${warm.ok} latency=${warm.latencyMs}ms tokens=${warm.inputTokens} status=${warm.status ?? "-"} ${warm.message ?? ""}`);
  if (!warm.ok) {
    console.error("[probe] API key or endpoint problem — aborting.");
    process.exit(1);
  }

  // Binary search: find largest reps that succeed. Start wide.
  let low = 1; // known ok
  let high = 400_000; // ~1.4M tokens, likely too big
  // First find an upper bound that fails.
  console.log("[probe] finding failing upper bound...");
  while (await probe(high).then((r) => r.ok)) {
    low = high;
    high *= 2;
    if (high > 12_800_000) break; // hard stop
    console.log(`[probe] ${tokensFor(low)} tok ok; doubling to ~${tokensFor(high)} tok`);
  }
  console.log(`[probe] ok at ~${tokensFor(low)} tok; fails at ~${tokensFor(high)} tok. Binary searching...`);

  while (high - low > Math.max(1, Math.floor(low / 50))) {
    const mid = Math.floor((low + high) / 2);
    const r = await probe(mid);
    console.log(`[probe] ~${tokensFor(mid)} tok: ok=${r.ok} status=${r.status ?? "-"} latency=${r.latencyMs}ms`);
    if (r.ok) low = mid;
    else high = mid;
  }

  console.log(`\n[probe] === INPUT LIMIT: works at ~${tokensFor(low)} tokens (reps=${low}), fails at ~${tokensFor(high)} tokens ===`);
  const failResult = await probe(high);
  console.log(`[probe] failure detail: status=${failResult.status} ${failResult.message ?? ""}`);

  // Latency at a comfortable working size (well under the limit).
  const workingReps = Math.floor(low * 0.25);
  const sizes = [1, 200, workingReps];
  for (const reps of sizes) {
    const latencies: number[] = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const r = await probe(reps);
      if (r.ok) latencies.push(r.latencyMs);
    }
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(n / 2)] ?? NaN;
    const p95 = latencies[Math.floor(n * 0.95)] ?? latencies[latencies.length - 1];
    console.log(
      `[latency] ~${tokensFor(reps)} tok state: n=${latencies.length} p50=${p50}ms p95=${p95}ms min=${latencies[0]} max=${latencies[latencies.length - 1]}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
