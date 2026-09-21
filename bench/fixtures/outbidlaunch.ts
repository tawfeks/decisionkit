/**
 * outbidlaunch fixture — the real-task A/B fixture (an Astro/Cloudflare
 * leaderboard app with a 3D globe). Known answer, verified in this fixture
 * (180 features, table size 191): the `A2_TO_A3` country-code table in
 * `src/components/VisitMap.tsx` is missing 10 unambiguous ISO entries — those
 * are the fix-quality GATE. Kosovo (CS-KM), the two `-99` features and
 * Antarctica are discretionary (recorded, never gated — the baseline itself
 * flips on Kosovo).
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Fixture } from "../fixture-api.js";

const VISIT_MAP = "src/components/VisitMap.tsx";
const GEOJSON = "src/components/data/world.geo.json";

/** The 10 unambiguous ISO entries — the fix-quality GATE. */
const REQUIRED_ENTRIES: Array<[string, string]> = [
  ["GL", "GRL"], ["BM", "BMU"], ["CI", "CIV"], ["MK", "MKD"], ["PR", "PRI"],
  ["EH", "ESH"], ["FK", "FLK"], ["GF", "GUF"], ["NC", "NCL"], ["TF", "ATF"],
];

const parseTable = (src: string): Map<string, string> => {
  const start = src.indexOf("const A2_TO_A3");
  if (start < 0) return new Map();
  const end = src.indexOf("}", start);
  const region = src.slice(start, end < 0 ? undefined : end + 1);
  const table = new Map<string, string>();
  for (const m of region.matchAll(/([A-Z]{2})\s*:\s*"([A-Z]{3})"/g)) table.set(m[1] as string, m[2] as string);
  return table;
};

const tableRangeOf = (src: string): [number, number] | undefined => {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.includes("const A2_TO_A3"));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.trim() === "}");
  return end < 0 ? undefined : [start, end];
};

export const outbidlaunch: Fixture = {
  name: "outbidlaunch",
  clone: { url: "https://github.com/fastlaunch/outbidlaunch.git" },
  prompts: [
    {
      key: "pA",
      text: "fix the issue of having greenland and some other countries are not showing in 3d map (don't edit anything else like changing how ocean or water in earth)",
    },
    { key: "pB", text: "the 3d map is missing some countries like greenland, fix it" },
    { key: "pC", text: "fix any missing countries on the map like greenland." },
  ],
  verify(copyDir, editedFiles, pristineDir) {
    const visitMap = resolve(copyDir, VISIT_MAP);
    let src = "";
    try {
      src = readFileSync(visitMap, "utf8");
    } catch {
      return { ok: false, required: "VisitMap.tsx missing", discretionary: {}, constraint: "n/a" };
    }
    const table = parseTable(src);
    const missing = REQUIRED_ENTRIES.filter(([a2, a3]) => table.get(a2) !== a3);
    const required = missing.length === 0
      ? `all 10 entries present`
      : `MISSING: ${missing.map(([a2, a3]) => `${a2}->${a3}`).join(", ")}`;

    // Discretionary — recorded, never gated (baseline itself flips on Kosovo).
    const discretionary: Record<string, unknown> = {
      kosovo: /:\s*"CS-KM"/.test(src) ? "CS-KM entry added" : "CS-KM absent",
      antarctica: table.has("AQ") ? "AQ entry added" : "ATA unchanged",
      minus99: readFileSync(resolve(copyDir, GEOJSON), "utf8").includes("-99")
        ? "-99 features still in data"
        : "-99 absent",
    };

    // Constraint: only VisitMap.tsx edited + geojson byte-identical + additions
    // stay inside the table region (soft — recorded, fails nothing by itself).
    const geojson = resolve(copyDir, GEOJSON);
    const sourceGeojson = resolve(pristineDir, GEOJSON);
    let geoOk = false;
    try {
      geoOk = statSync(geojson).size === statSync(sourceGeojson).size
        && readFileSync(geojson).equals(readFileSync(sourceGeojson));
    } catch {
      geoOk = false;
    }
    const editedOk = editedFiles.every((f) => f.replace(/^\.\//, "") === VISIT_MAP);
    // Soft: run a real diff against the pristine copy, count +/- lines and
    // whether any removed line lies OUTSIDE the A2_TO_A3 region (the
    // "don't edit anything else" violation signal).
    let added = -1;
    let removed = -1;
    let removedOutsideTable = false;
    try {
      const diff = spawnSync("diff", ["-u", resolve(pristineDir, VISIT_MAP), visitMap], { encoding: "utf8" });
      const out = diff.stdout ?? "";
      const tableRange = tableRangeOf(src);
      for (const line of out.split("\n")) {
        if (line.startsWith("-") && !line.startsWith("---")) removed++;
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
      }
      // Removed lines (from the pristine file) outside the table region:
      if (tableRange) {
        const pristine = readFileSync(resolve(pristineDir, VISIT_MAP), "utf8").split("\n");
        for (const m of out.matchAll(/^@@ -(\d+),?\d* \+\d+,?\d* @@/gm)) {
          const oldStart = Number(m[1]);
          const hunk = out.slice(m.index ?? 0).split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
          for (const h of hunk) {
            const idx = pristine.findIndex((l) => l === h.slice(1));
            if (idx >= 0 && (idx < tableRange[0] || idx > tableRange[1])) removedOutsideTable = true;
          }
          void oldStart;
        }
      }
    } catch {
      /* soft check — absence of data is recorded, not fatal */
    }
    const constraint = `editedFiles ok=${editedOk}, geojson identical=${geoOk}, VisitMap diff +${added}/-${removed}, removedOutsideTable=${removedOutsideTable}`;
    return { ok: missing.length === 0 && editedOk && geoOk, required, discretionary, constraint };
  },
  gates(runs) {
    const gate = (name: string, ok: boolean, detail: string): void =>
      console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
    const rng = (xs: number[]): string => (xs.length === 0 ? "n/a" : `${Math.min(...xs)}–${Math.max(...xs)}`);
    const s0Runs = runs.filter((r) => r.arm === "s0");
    const baseRuns = runs.filter((r) => r.arm === "base");
    if (s0Runs.length === 0) {
      console.log("no s0-arm runs — gates not evaluable");
      return;
    }
    console.log("outbidlaunch gates (baseline 8/8/9 turns, ↑31–43k):");
    const allTurns = s0Runs.map((r) => r.metrics.turns);
    gate("turns 8 → ≤3 every run", allTurns.length > 0 && Math.max(...allTurns) <= 3, `s0 turns range ${rng(allTurns)} (baseline 8/8/9)`);
    const inTok = s0Runs.map((r) => r.metrics.inputTokens);
    gate("↑ input ≤14k", inTok.length > 0 && Math.max(...inTok) <= 14_000, `s0 ↑ range ${rng(inTok)} (baseline 31–43k)`);
    const wastedTotal = s0Runs.reduce((a, r) => a + Math.max(r.metrics.s0Wasted, 0), 0);
    gate("wasted <10% of runs", wastedTotal / Math.max(s0Runs.length, 1) < 0.1, `wasted Σ ${wastedTotal} over ${s0Runs.length} runs (target <0.1/run)`);
    const failOpens = s0Runs.reduce((a, r) => a + r.metrics.s0FailOpens, 0);
    gate("fail-open <5% of runs", failOpens / Math.max(s0Runs.length, 1) < 0.05, `${failOpens} s0 fail-opens over ${s0Runs.length} runs`);
    const verifyPass = s0Runs.filter((r) => r.verify.ok).length;
    gate("10 ISO entries present (fix quality)", verifyPass === s0Runs.length && s0Runs.length > 0, `${verifyPass}/${s0Runs.length} s0 runs pass`);
    const baseVerifyPass = baseRuns.filter((r) => r.verify.ok).length;
    if (baseRuns.length > 0) console.log(`  (base arm verify: ${baseVerifyPass}/${baseRuns.length})`);
  },
};
