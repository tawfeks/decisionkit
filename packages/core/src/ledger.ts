import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Ledger, Receipt } from "./types.js";

const percentiles = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
};

export class InMemoryLedger implements Ledger {
  // `declare` + ctor assignment: some loaders (pi's jiti path) re-run class
  // field initializers AFTER the constructor body, which would wipe fields
  // assigned there (sinkPath ended up undefined in the drop-in).
  private declare receipts: Receipt[];
  private declare sinkPath: string | undefined;
  private declare sinkPromise: Promise<void>;

  constructor(sinkPath?: string) {
    this.receipts = [];
    this.sinkPath = sinkPath === undefined ? undefined : resolve(sinkPath);
    this.sinkPromise = Promise.resolve();
  }

  record(receipt: Receipt): void {
    this.receipts.push(receipt);
    if (this.sinkPath !== undefined) {
      const line = JSON.stringify(receipt) + "\n";
      const path = this.sinkPath;
      this.sinkPromise = this.sinkPromise
        .then(async () => {
          await mkdir(dirname(path), { recursive: true });
          await appendFile(path, line, "utf8");
        })
        .catch(() => {
          // Ledger writes must never take the agent down.
        });
    }
  }

  all(): readonly Receipt[] {
    return this.receipts;
  }

  async flush(): Promise<void> {
    await this.sinkPromise;
  }

  totals(): {
    calls: number;
    failOpen: number;
    inputTokens: number;
    outputTokens: number;
    latencyMsP50: number;
    latencyMsP95: number;
  } {
    const latencies = this.receipts.filter((r) => r.ok).map((r) => r.latencyMs);
    return {
      calls: this.receipts.length,
      failOpen: this.receipts.filter((r) => r.failOpen === true).length,
      inputTokens: this.receipts.reduce((sum, r) => sum + r.inputTokens, 0),
      outputTokens: this.receipts.reduce((sum, r) => sum + r.outputTokens, 0),
      latencyMsP50: percentiles(latencies, 50),
      latencyMsP95: percentiles(latencies, 95),
    };
  }
}
