/**
 * Fixture API — the contract every bench fixture preset implements.
 *
 * A fixture turns "any repo" into a reproducible benchmark: a pinned clone
 * source, a shipped prompt set, and (optionally) a deterministic fix-quality
 * verifier plus gate verdicts for the report. Repos without a fixture still
 * benchmark fine — they get metrics only.
 */
export interface FixturePrompt {
  /** artifact key (pA, pB, …) used in run copy + artifact file names */
  key: string;
  text: string;
}

export interface VerifyResult {
  ok: boolean;
  required: string;
  discretionary: Record<string, unknown>;
  constraint: string;
}

/** Subset of a run artifact the gates inspect. */
export interface GateRun {
  run: number;
  arm: string;
  metrics: { turns: number; inputTokens: number; s0JevCalls: number; s0LatencyMs: number; s0FailOpens: number; s0Wasted: number };
  verify: VerifyResult;
}

export interface Fixture {
  /** registry key (also the .bench-cache/<name> dir and the artifact `fixture` field) */
  name: string;
  /** clone source; omit when the fixture expects the repo in tested-repo/ */
  clone?: { url: string; ref?: string };
  /** shipped prompt set for this repo */
  prompts: FixturePrompt[];
  /** deterministic task-success check on the run copy's end state */
  verify?: (copyDir: string, editedFiles: string[], pristineDir: string) => VerifyResult;
  /** gate verdicts printed by report.ts (only when artifacts came from this fixture) */
  gates?: (runs: GateRun[]) => void;
}
