/**
 * S0 — pre-turn context assembly (plan-v3 §2.1).
 *
 * State machine: terms → fan-out → cards → batched assemble → verify → digest.
 * ALL local work (term extraction, rg fan-out, candidate cards, deterministic
 * verification, outlines, import closure, anchors, budgets) happens here with
 * zero model calls; jev is consulted via ONE batched call per round (s0Assemble:
 * gate + pick + confidence + sufficiency in a single round trip).
 *
 * Stop policy (general, structural — not score-trust): a digest claiming task
 * coverage must account for the picks' deterministic neighborhoods. Files that
 * a verified pick references (imports or path literals resolved to repo files)
 * are graph facts; they may only leave the loop picked, verify-failed, or
 * explicitly declined. Concretely: (a) a pick="none" while undispositioned
 * neighbors exist escalates to ONE focused round over exactly those neighbors;
 * (b) HIGH sufficiency breaks the loop only when no undispositioned neighbor
 * remains. Mid-scale sufficiency never breaks — any decent first pick
 * satisfies "enough to plan" (measured: a 1-of-5-file digest shipped on
 * "some", 4/5 frontier discoveries wasted).
 * Executes ONLY read-only commands (rg/grep/wc and node-local reads) with
 * hard timeouts. Breach or error ⇒ fail open (no digest) — a receipt says why.
 *
 * Generality doctrine (plan-v3 §0.1): no fixture or domain knowledge here.
 * Outline extraction and import-closure widening are language-agnostic
 * mechanisms — reference extraction is purely syntactic (quoted literals +
 * import-keyword tokens) with listing-proved resolution, never keyed to a
 * language, framework, or task content.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { DecisionKitCore } from "./decisionkit.js";
import type { Receipt } from "./types.js";

const execFileAsync = promisify(execFile);

const WALL_BUDGET_MS = 8000;
const JEVCALL_BUDGET = 10;
const CANDIDATE_CAP = 30;
const PICK_OPTION_CAP = 10;
const ANCHOR_CAP = 8;
const OUTLINE_CAP = 10;
const EXCERPT_MAX = 120;
const DIGEST_MAX_CHARS = 2800;
const ENUM_FILE_MAX_BYTES = 512 * 1024;
/** Import-closure widening: resolve imports only within the repo (no bare
 * module specifiers, no URLs); cap the per-pick closure fan-out. */
const IMPORT_RESOLVE_CAP = 8;
/** Digest header — also the marker the eval rig uses to detect the merged
 * prompt (the digest ships inside the user message, not as a custom entry). */
export const DIGEST_MARKER = "[decisionkit context — assembled before your turn from read-only commands]";

/** Stopwords: function words + task-shaped verbs that match everything and
 * filter nothing. Deliberately small — the fan-out over-matches, jev filters
 * (plan-v3 §6.4). */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "any", "other", "issue", "bug", "fix", "fixed",
  "edit", "edits", "editing", "anything", "else", "like", "changing", "change",
  "changes", "don", "not", "please", "should", "would", "could", "does", "did",
  "you", "your", "our", "their", "this", "that", "these", "those", "there",
  "here", "some", "all", "also", "too", "very", "just", "make", "made", "want",
  "need", "needs", "how", "why", "what", "when", "which", "who", "was", "were",
  "are", "his", "her", "its", "into", "from", "about", "after", "before",
  // 2-letter function words: they match nearly every line in every repo and
  // only inflate df noise (measured: "in" surfaced as a top matched term).
  "in", "on", "at", "to", "of", "is", "it", "be", "as", "by", "or", "if", "do",
  "no", "so", "an", "my", "me", "up", "us", "am", "we",
]);

export interface S0Outcome {
  /** Digest text to inject as a custom message; undefined ⇒ fail-open/skip. */
  digest?: string;
  digestLines: string[];
  /** Absolute paths S0 verified and put on the table. */
  picked: string[];
  /** cwd-relative paths of verified picks. */
  pickedRel: string[];
  /** Top candidates NOT read (cwd-relative), for the digest's "request if needed".
   * Excludes graph-related files (they are listed in `related`, not "Not read"). */
  rejected: string[];
  /** cwd-relative paths deterministically referenced by a pick (import or
   * path-literal closure) that were NOT picked — digest "Related" facts. */
  related: string[];
  /** Deterministic reference edges between the files above (local parse). */
  flows: S0Edge[];
  /** Deterministic set-diff fact line, when both enumerations were found. */
  diff?: string;
  ms: number;
  jevCalls: number;
  /** Candidate card count the fan-out produced (calibration signal: how much
   * the sweep actually saw, independent of what jev picked). */
  candidates: number;
  /** Per-round assemble receipts, surfaced in the session for postmortems
   * (round-level pick/confidence/sufficiency otherwise lives only in the
   * in-memory ledger, invisible without DECISIONKIT_LEDGER_PATH). */
  receipts: Receipt[];
  /** Why no digest was produced ("skip" = gate said no — not a failure). */
  skip?: string;
  failOpen?: string;
}

interface Match {
  line: number;
  text: string;
}

export interface Card {
  id: string;
  abs: string;
  rel: string;
  ext: string;
  size: number;
  matches: Match[];
  terms: string[];
  /** Deterministic outline: exported symbols with line numbers (local parse,
   * never a model). Included in the digest so the frontier can plan ranged
   * reads instead of whole-file reads. */
  outline: string[];
  /** true ⇒ the card entered the pool via deterministic graph widening
   * (import/path-literal closure of a verified pick), not the term sweep.
   * The stop policy dispositions these explicitly; the digest lists them as
   * "Related" graph facts. */
  widened?: boolean;
}

/** A deterministic reference edge between two repo files, extracted from a
 * pick's source text (import/require specifier or string path literal).
 * Pure local fact — rendered in the digest so the frontier does not re-derive
 * the data path it names. */
export interface S0Edge {
  from: string;
  to: string;
  /** The reference text as written in `from` (specifier or literal). */
  via: string;
}

/** Local tokenizer: prompt → salient terms (identifiers, camelCase splits,
 * quoted strings, −stopwords). Dumb and cheap (plan-v3 §6.4). */
export const extractTerms = (prompt: string): string[] => {
  const out: string[] = [];
  const push = (t: string): void => {
    if (t.length < 2) return;
    if (STOPWORDS.has(t.toLowerCase())) return;
    if (/^\d+$/.test(t)) return;
    if (!out.includes(t)) out.push(t);
  };
  // Quoted phrases stay whole (they are the user's exact words).
  for (const q of prompt.matchAll(/"([^"]{3,40})"|'([^']{3,40})'/g)) {
    const phrase = (q[1] ?? q[2] ?? "").trim();
    if (phrase !== "" && phrase.split(/\s+/).length <= 3) push(phrase);
  }
  for (const raw of prompt.split(/[^A-Za-z0-9_.]+/)) {
    if (raw === "" || raw.length > 40) continue;
    // camelCase / snake_case splits: MY_TABLE → MY, TABLE; MyWidget → My, Widget
    const parts = raw.split(/[_]+/).flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/));
    for (const p of parts) push(p);
    push(raw);
  }
  // Longer terms are more specific — match quality over breadth.
  return out.sort((a, b) => b.length - a.length).slice(0, 8);
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** rg presence probe (rg measured broken on one dev box — fallback grep). */
const haveRg = async (cwd: string): Promise<boolean> => {
  try {
    await execFileAsync("rg", ["--version"], { cwd, timeout: 1500 });
    return true;
  } catch {
    return false;
  }
};

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

interface FanOutResult {
  hits: SearchHit[];
  /** true ⇒ the sweep could not be completed (enumeration or chunk timeout /
   * fs error). Callers must fail open — treating this as "no matches" turned
   * the whole S0 pass into a silent multi-second no-op (measured). */
  error: boolean;
}

/** Repo file enumeration, never throws. git ls-files respects ignore rules
 * (node_modules / build caches are typically ignored → 25ms on an 800MB tree)
 * with a pruned-find fallback for non-git dirs. Hidden dirs are pruned
 * generically: they are tool state (`.git`, `.wrangler`, `.pi`, caches), never
 * task content — the measured 644MB `.wrangler` was what made recursive grep
 * exceed its whole timeout budget. */
const listFiles = async (cwd: string, timeoutMs: number): Promise<string[] | undefined> => {
  try {
    const res = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    );
    return res.stdout.split("\n").filter(Boolean);
  } catch {
    // not a git repo (or git too slow): pruned find. -prune keeps the walk
    // out of the excluded trees instead of filtering paths after descending.
    // -path ./.* (NOT -name ".*"): the name pattern matches "." itself, so
    // the starting tree was pruned whole — the enumeration returned zero
    // files (measured on macOS BSD find) and every non-git sweep failed open.
    try {
      const res = await execFileAsync(
        "find",
        [
          ".", "-path", "./node_modules", "-prune", "-o",
          "-path", "./.*", "-prune", "-o",
          "-type", "f", "-print",
        ],
        { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      );
      return res.stdout.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
    } catch {
      return undefined;
    }
  }
};

const GREP_CHUNK = 400;
const GREP_CHUNK_TIMEOUT_MS = 2000;
/** Per-file match cap for grep chunks: bounds output size when a term hits
 * minified/generated files (rg keeps its own --max-count). */
const GREP_MAX_COUNT = 5;

/** Chunked grep over the enumerated file list. BSD `grep -r` cannot be
 * bounded portably (no reliable hidden-dir pruning, whole-run timeout only —
 * measured >30s on a repo with tool-state dirs), so the sweep runs on the
 * file list in bounded chunks. Chunk timeouts abort the sweep as an ERROR:
 * only exit code 1 (no matches in chunk) is a legitimate empty. */
const fanOutGrep = async (
  cwd: string,
  terms: string[],
  filesOnly: boolean,
  deadline: number,
): Promise<FanOutResult> => {
  const all = await listFiles(cwd, 3000);
  if (all === undefined) return { hits: [], error: true };
  // Defensive: untracked/ignored trees can still surface in ls-files output.
  const files = all.filter((f) => !/(^|\/)node_modules\//.test(f));
  const pattern = terms.map(escapeRe).join("|");
  const hits: SearchHit[] = [];
  for (let i = 0; i < files.length; i += GREP_CHUNK) {
    if (Date.now() >= deadline) return { hits, error: true };
    const chunk = files.slice(i, i + GREP_CHUNK).filter((f) => existsSync(resolve(cwd, f)));
    if (chunk.length === 0) continue;
    const args = filesOnly
      ? ["-il"]
      : ["-in", "-m", String(GREP_MAX_COUNT)];
    try {
      const res = await execFileAsync(
        "grep",
        [...args, "-E", pattern, "--", ...chunk],
        {
          cwd,
          timeout: Math.min(GREP_CHUNK_TIMEOUT_MS, Math.max(500, deadline - Date.now())),
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (filesOnly) {
        for (const f of res.stdout.split("\n").filter(Boolean).slice(0, CANDIDATE_CAP)) {
          hits.push({ file: f, line: 0, text: "" });
        }
        continue;
      }
      for (const l of res.stdout.split("\n")) {
        if (l === "") continue;
        const idx = l.indexOf(":");
        if (idx < 0) continue;
        const file = l.slice(0, idx);
        const rest = l.slice(idx + 1);
        const lidx = rest.indexOf(":");
        if (lidx < 0) continue;
        hits.push({ file, line: Number(rest.slice(0, lidx)) || 0, text: rest.slice(lidx + 1) });
      }
    } catch (err) {
      const e = err as { code?: number | string };
      if (e.code === 1) continue; // no matches in this chunk
      return { hits, error: true };
    }
  }
  return { hits, error: false };
};

/** One fan-out pass: all terms in a single rg/grep invocation (content, -i,
 * line numbers). A completed-but-empty pass and an aborted pass are distinct
 * results (plan-v3 §6.2: rg measured broken on one dev box — the grep path
 * must be as bounded as rg, and a bounded-out sweep must never read as
 * "no matches"). */
const fanOut = async (
  cwd: string,
  terms: string[],
  useRg: boolean,
  filesOnly: boolean,
  deadline: number,
): Promise<FanOutResult> => {
  if (useRg) {
    const args: string[] = [
      filesOnly ? "-il" : "-in",
      "--max-count",
      "40",
      "--glob",
      "!node_modules/**",
      ...terms.flatMap((t) => ["-e", t]),
    ];
    try {
      const res = await execFileAsync("rg", args, {
        cwd,
        timeout: Math.max(1000, deadline - Date.now()),
        maxBuffer: 4 * 1024 * 1024,
      });
      const hits: SearchHit[] = [];
      if (filesOnly) {
        for (const f of res.stdout.split("\n").filter(Boolean).slice(0, CANDIDATE_CAP)) {
          hits.push({ file: f, line: 0, text: "" });
        }
        return { hits, error: false };
      }
      for (const l of res.stdout.split("\n")) {
        if (l === "") continue;
        const idx = l.indexOf(":");
        if (idx < 0) continue;
        const file = l.slice(0, idx);
        const rest = l.slice(idx + 1);
        const lidx = rest.indexOf(":");
        if (lidx < 0) continue;
        hits.push({ file, line: Number(rest.slice(0, lidx)) || 0, text: rest.slice(lidx + 1) });
      }
      return { hits, error: false };
    } catch (err) {
      // exit 1 = no matches — legitimate empty result, not an error.
      const e = err as { code?: number | string };
      if (e.code === 1) return { hits: [], error: false };
      return fanOutGrep(cwd, terms, filesOnly, deadline);
    }
  }
  return fanOutGrep(cwd, terms, filesOnly, deadline);
};

const termMatchesLine = (text: string, terms: string[]): string[] =>
  // Word-boundary match: "in" must not match "India" (measured false signal —
  // it drowned the real term on the same file and ranked the geojson data out
  // of the pick pool). Terms are user words / identifier fragments.
  terms.filter((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "i").test(text));

/** Widening pass: files whose PATH/BASENAME contains a salient term (content
 * sweep already covered the terms themselves). Same generic enumeration as
 * the content sweep. */
const nameCandidates = async (cwd: string, terms: string[]): Promise<Card[]> => {
  try {
    const listing = await listFiles(cwd, 3000);
    if (listing === undefined) return [];
    const lower = terms.map((t) => t.toLowerCase());
    const files = listing
      .filter((f) => !/(^|\/)node_modules\//.test(f))
      .filter((f) => lower.some((t) => f.toLowerCase().includes(t)))
      .slice(0, CANDIDATE_CAP);
    return buildCards(cwd, files.map((f) => ({ file: f, line: 0, text: "" })), terms);
  } catch {
    return [];
  }
};

/** Deterministic verification: does this file contain ≥1 salient term?
 * Local rg/grep, exit-code only (no content shipped). */
const verifyFileHasTerm = async (abs: string, terms: string[], useRg: boolean): Promise<boolean> => {
  try {
    if (useRg) {
      await execFileAsync("rg", ["-i", "-q", ...terms.flatMap((t) => ["-e", t]), abs], { timeout: 2000 });
      return true;
    }
    await execFileAsync("grep", ["-iq", ...terms.map((t) => ["-e", t]).flat(), abs], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
};

/**
 * Deterministic outline: exported symbols with line numbers, by line scan.
 * Language-generic via per-extension patterns — the file is only ever
 * described, never interpreted. All patterns whose extension matches are
 * applied (a language may have several declaration forms); files with no
 * matching pattern (data, docs, config) return empty and the digest falls
 * back to anchors alone.
 */
const OUTLINE_PATTERNS: Array<{ ext: RegExp; re: RegExp }> = [
  // JS/TS family: export [default] [async] <name>, export const/function/class
  { ext: /\.(m?js|cjs|[cm]?tsx?|jsx)$/, re: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/ },
  // Python: def/class at top level
  { ext: /\.pyi?$/, re: /^(?:def|class)\s+([A-Za-z0-9_]+)/ },
  // Go: func <name>( or func (r Recv) <name>(
  { ext: /\.go$/, re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/ },
  // Rust: pub fn / fn
  { ext: /\.rs$/, re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/ },
  // Ruby: def name
  { ext: /\.rb$/, re: /^\s*def\s+([A-Za-z0-9_?!.]+)/ },
  // PHP: [visibility] function name( / class|interface|trait Name
  { ext: /\.php$/, re: /^\s*(?:(?:public|protected|private|abstract|final|static)\s+)*(?:function\s+([A-Za-z0-9_]+)|(?:class|interface|trait|enum)\s+([A-Za-z0-9_]+))/ },
  // JVM/C#/swift/dart family: class|interface|object|trait|enum|struct|record
  { ext: /\.(java|kt|kts|scala|sc|cs|swift|dart|zig)$/, re: /^\s*(?:(?:public|private|protected|internal|abstract|final|sealed|open|data|case|static|partial|pub(?:\(\w+\))?)\s+)*(?:class|interface|object|trait|enum|struct|record|extension)\s+([A-Za-z0-9_]+)/ },
  // Kotlin/scala/dart/swift: fun/func/def declarations
  { ext: /\.(kt|kts|scala|sc|dart|swift)$/, re: /^\s*(?:(?:public|private|protected|internal|static|open|override)\s+)*(?:fun|func|def)\s+([A-Za-z0-9_]+)/ },
];

export const extractOutline = async (abs: string, ext: string): Promise<string[]> => {
  const pats = OUTLINE_PATTERNS.filter((p) => p.ext.test(ext));
  if (pats.length === 0) return [];
  try {
    const s = await stat(abs);
    if (s.size > ENUM_FILE_MAX_BYTES) return [];
    const buf = await readFile(abs, "utf8");
    const lines = buf.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length && out.length < OUTLINE_CAP; i++) {
      for (const pat of pats) {
        const m = (lines[i] as string).match(pat.re);
        const name = m?.[1] ?? m?.[2];
        if (name !== undefined) {
          out.push(`L${i + 1} ${name}`);
          break;
        }
      }
    }
    return out;
  } catch {
    return [];
  }
};

/**
 * Import-closure widening (generic, deterministic): extract the module/path
 * references of the picked files and resolve them to repo-relative files.
 * The neighborhood — not the term-match set — is what the frontier actually
 * explores next; feeding it as candidates is what turns "digest + 6 wasted
 * rediscoveries" into "digest covers the neighborhood".
 *
 * Reference extraction is language-agnostic by construction (two purely
 * syntactic mechanisms, no per-language dispatch):
 *  1. Quoted literals — in every mainstream syntax the reference is a quoted
 *     (or backticked) string: JS/TS import-from/require, C #include, PHP
 *     require/include, Go/Dart/Scala/Java import strings, astro/vue/svelte
 *     frontmatter imports, CSS @import. Extract quoted strings; the listing
 *     proves which ones are repo files.
 *  2. Import-keyword contexts — languages whose module references are BARE
 *     (unquoted): python from/import, rust use/mod, PHP use, java/kt dotted
 *     imports. The keyword is context; the token normalizes (dots, `::`, `\`
 *     → path segments) and resolves exactly like (1).
 * Resolution is likewise universal: a reference becomes an edge only when a
 * listing file proves it (direct probe, extension probe, index-file probe,
 * or suffix-by-stem for framework roots/aliases). No framework names, no
 * fixture knowledge (plan-v3 §0.1).
 */

/** Files that carry no module graph (pure data/state); parsing them would
 * only add resolution noise. Structural — by file shape, not task content. */
const DATA_FILE_RE = /\.(json|ya?ml|toml|lock|csv|tsv|txt|md|ini|cfg|env|properties|ipynb|sum)$/i;

/** Media/asset references and non-source targets are not edit-relevant
 * candidates; resolving them only bloats the pool. */
const PATH_MEDIA_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|css|scss|map|mp4|webm|mp3|pdf|wasm|txt|md)$/i;

const QUOTED_RE = /["'`]([^"'`\n]{2,200})["'`]/g;
/** Keyword contexts for UNQUOTED module references. `from`/`import` also
 * appear in prose — harmless: a bare token becomes an edge only when the
 * listing proves a repo file at that path. */
const KEYWORD_RE = /\b(?:from|import|use|mod|require|include)\s+([A-Za-z0-9_.\\:/\-]{2,160})/g;

const extractSpecs = (buf: string): Set<string> => {
  const specs = new Set<string>();
  for (const m of buf.matchAll(QUOTED_RE)) {
    if (m[1] !== undefined) specs.add(m[1]);
  }
  // Template literals: the static prefix ("`/api/x?page=${n}`") is the ref.
  for (const m of buf.matchAll(/`([^`]*)`/g)) {
    const seg = (m[1]?.split("${")[0] ?? "").match(/^\/?[A-Za-z0-9_@%.,\-/]+/)?.[0];
    if (seg !== undefined && seg.length >= 2) specs.add(seg);
  }
  for (const m of buf.matchAll(KEYWORD_RE)) {
    const tok = (m[1] ?? "").replace(/[.,;:()\[\]{}]+$/, "");
    if (tok !== "" && !/[\s"'`]/.test(tok)) specs.add(tok);
  }
  return specs;
};

/** Extension probes for direct resolution — the standard source extensions,
 * plus directory-entry forms for package-style resolution. A fixed generic
 * list; resolution still requires the listing to prove the file. */
const EXT_PROBES = [
  "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".pyi", ".go", ".rs", ".rb", ".php", ".astro", ".svelte", ".vue",
  ".kt", ".kts", ".java", ".cs", ".swift", ".zig", ".ex", ".exs", ".erl",
  ".lua", ".scala", ".sc", ".dart", ".c", ".h", ".cpp", ".cc", ".cxx",
  ".hpp", ".hh", ".proto", ".graphql", ".sql", ".sh", ".bash",
];
const INDEX_PROBES = [
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs",
  "/index.astro", "/index.vue", "/index.svelte", "/index.php",
  "/__init__.py", "/mod.rs", "/lib.rs", "/main.go", "/index.go",
];

const probeFile = (cand: string, listing: Set<string>): string | undefined => {
  if (cand === "" || cand.endsWith("/")) return undefined;
  if (listing.has(cand)) return cand;
  for (const e of EXT_PROBES) {
    const rel = `${cand}${e}`;
    if (listing.has(rel)) return rel;
  }
  for (const e of INDEX_PROBES) {
    const rel = `${cand}${e}`;
    if (listing.has(rel)) return rel;
  }
  return undefined;
};

/** Suffix proof — the only framework-agnostic alias/route resolver: a
 * multi-segment reference ("api/leaderboard", "app/models/listing") matches
 * the listing entry it names by stem, wherever the framework root sits.
 * Single-segment references are rejected: "api" would suffix-match half the
 * repo and only add noise. */
const suffixMatch = (want: string, listing: Set<string>): string | undefined => {
  if (!want.includes("/")) return undefined;
  const w = want.toLowerCase();
  for (const f of listing) {
    if (PATH_MEDIA_RE.test(f) || DATA_FILE_RE.test(f)) continue;
    const stem = f.replace(/\.[^./]+$/, "").replace(/\/index$/, "").toLowerCase();
    if (stem === w || stem.endsWith(`/${w}`)) return f;
  }
  return undefined;
};

/** Resolve one extracted reference (quoted literal or bare module token) to
 * a repo-relative file, or undefined when no listing file proves it. */
const resolveRef = (raw: string, fromRel: string, listing: Set<string>): string | undefined => {
  const spec = raw.replace(/^["'`]/, "").replace(/["'`,;:]+$/, "").trim();
  if (spec.length < 2 || spec.length > 200 || /\s/.test(spec)) return undefined;
  // URLs (scheme://), anchors, dynamic-only templates: not repo refs. A bare
  // "x:" is NOT a scheme — rust `crate::x` and win drive "C:\x" must survive.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec) || /^[a-z]:[\\/]/i.test(spec) || spec.startsWith("#") || spec.includes("${")) {
    return undefined;
  }
  // Reject interior ".." (only a LEADING ../ run may climb).
  const upSeq = spec.match(/^(?:\.{1,2}\/)+/)?.[0]?.length ?? 0;
  if (spec.slice(upSeq).includes("..")) return undefined;
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const dirSegs = dir === "" ? [] : dir.split("/").filter(Boolean);

  // Path-style: ./ ../ / @/ ~/ — resolve relative to the referencing file
  // (alias @/, ~/ also probed at src/ — the common convention; both must be
  // proven by the listing), and absolute-from-root refs by probe+suffix.
  // A leading "." WITHOUT a slash is a python-style relative module — the
  // module branch below owns it.
  const pathStyle = spec.startsWith("./") || spec.startsWith("../") ||
    (spec.startsWith("/") && !spec.startsWith("//")) ||
    spec.startsWith("@/") || spec.startsWith("~/");
  if (pathStyle) {
    if (spec.startsWith("/") || spec.startsWith("@/") || spec.startsWith("~/")) {
      const base = spec
        .replace(/^\/+/, "")
        .replace(/^[~@]\//, "")
        .replace(/[?#].*$/, "")
        .replace(/\/+$/, "");
      if (base === "") return undefined;
      if (spec.startsWith("@") && !spec.startsWith("@/")) return undefined;
      return probeFile(base, listing)
        ?? (aliasProbe(base, listing))
        ?? suffixMatch(base, listing);
    }
    const parts = spec.split("/");
    let ups = 0;
    for (const seg of parts) {
      if (seg === "..") ups++;
    }
    const kept = parts.filter((s) => s !== "." && s !== "..");
    const start = dirSegs.slice(0, Math.max(0, dirSegs.length - ups));
    return probeFile([...start, ...kept].join("/"), listing);
  }

  // Bare module-style token (python/rust/php/java/go family). Normalize the
  // separators every family uses, then probe: sibling file, repo root, src/,
  // python-relative dots, PSR-style namespace root→src/, suffix by stem.
  const rel = spec.replace(/\\/g, "/").replace(/::/g, "/");
  const dotLead = rel.match(/^(\.+)(.*)$/);
  let base = rel;
  let start = dirSegs;
  if (dotLead !== null) {
    base = dotLead[2] ?? "";
    // ".x" = current package, "..x" = parent package (python semantics).
    const ups = dotLead[1]!.length - 1;
    start = start.slice(0, Math.max(0, start.length - ups));
  }
  const dirPrefix = start.join("/");
  const pathish = base.replace(/\./g, "/");
  const cands = [pathish, spec];
  if (dirPrefix !== "") cands.push(`${dirPrefix}/${pathish}`, `${dirPrefix}/${spec}`);
  cands.push(`src/${pathish}`, `src/${spec}`);
  if (pathish.includes("/")) {
    // PSR-4-style: "App/Models/X" ⇒ "src/Models/X" (namespace root → src/).
    cands.push(`src/${pathish.replace(/^[^/]+\//, "")}`);
    // Rust crate-root alias: "crate/models/user" ⇒ "src/models/user".
    if (pathish.startsWith("crate/")) cands.push(`src/${pathish.slice("crate/".length)}`);
  }
  for (const c of cands) {
    if (c === "" ) continue;
    const r = probeFile(c, listing);
    if (r !== undefined) return r;
  }
  if (pathish.includes("/")) return suffixMatch(pathish, listing);
  if (spec.includes("/")) return suffixMatch(spec, listing);
  return undefined;
};

const aliasProbe = (base: string, listing: Set<string>): string | undefined => {
  const a = probeFile(`src/${base}`, listing);
  return a;
};

/** Widening (deterministic neighborhood of picks; exported for tests).
 * Returns both the neighborhood cards (tagged `widened`) and the reference
 * edges that produced them — the edges are digest facts, not just ranking
 * input. Data files are not parsed as sources; media/asset targets are
 * skipped for both mechanisms (an import of a stylesheet or an <img> src is
 * not an edit-relevant data path). */
export const importClosure = async (
  cwd: string,
  picked: Card[],
  listing: Set<string>,
): Promise<{ cards: Card[]; edges: S0Edge[] }> => {
  const seen = new Set(picked.map((p) => p.rel));
  const out: Card[] = [];
  const edges: S0Edge[] = [];
  const edgeSeen = new Set<string>();
  for (const p of picked) {
    if (out.length >= IMPORT_RESOLVE_CAP) break;
    if (DATA_FILE_RE.test(p.rel)) continue;
    try {
      const s = await stat(p.abs);
      if (s.size > ENUM_FILE_MAX_BYTES) continue;
      const buf = await readFile(p.abs, "utf8");
      // rel → the reference text that produced it (first one wins).
      const rels = new Map<string, string>();
      for (const spec of extractSpecs(buf)) {
        if (rels.size >= IMPORT_RESOLVE_CAP) break;
        const rel = resolveRef(spec, p.rel, listing);
        if (rel !== undefined && !seen.has(rel) && !rels.has(rel) && !PATH_MEDIA_RE.test(rel)) {
          rels.set(rel, spec);
        }
      }
      for (const [rel, via] of rels) {
        const ek = `${p.rel}|${rel}|${via}`;
        if (!edgeSeen.has(ek)) {
          edgeSeen.add(ek);
          edges.push({ from: p.rel, to: rel, via: via.length > 48 ? `${via.slice(0, 45)}…` : via });
        }
        if (out.length >= IMPORT_RESOLVE_CAP) break;
        for (const card of await buildCards(cwd, [{ file: rel, line: 0, text: "" }], [])) {
          if (!seen.has(card.rel)) {
            seen.add(card.rel);
            card.widened = true;
            out.push(card);
          }
        }
      }
    } catch {
      // unreadable / unparseable — skip silently
    }
  }
  return { cards: out, edges };
};

/** Build candidate cards from fan-out hits: path, size, matched terms with
 * line numbers, excerpts, outline (plan-v3 §1 "candidate cards"). */
const buildCards = async (
  cwd: string,
  hits: SearchHit[],
  terms: string[],
): Promise<Card[]> => {
  const byFile = new Map<string, Match[]>();
  for (const h of hits) {
    if (h.file === "") continue;
    const list = byFile.get(h.file) ?? [];
    if (h.line > 0) list.push({ line: h.line, text: h.text.slice(0, EXCERPT_MAX) });
    byFile.set(h.file, list);
  }
  const cards: Card[] = [];
  for (const [file, matches] of byFile) {
    const abs = resolve(cwd, file);
    let size = 0;
    try {
      const s = await stat(abs);
      if (!s.isFile()) continue;
      size = s.size;
    } catch {
      continue;
    }
    const matched = new Set<string>();
    // Term presence over ALL hits (not just the anchor window): in a large
    // data file the subject term often appears on a late line — scanning only
    // the first hits hid the salient term and the card ranked on noise alone.
    for (const m of matches) {
      for (const t of termMatchesLine(m.text, terms)) matched.add(t);
    }
    cards.push({
      id: `F${cards.length + 1}`,
      abs,
      rel: relative(cwd, abs),
      ext: extname(file),
      size,
      matches: matches.slice(0, ANCHOR_CAP),
      terms: [...matched],
      outline: [],
    });
  }
  // Rank by term specificity (IDF-style, deterministic): a file matching the
  // rare task term (df=1: e.g. a data file holding the task's subject) must
  // outrank files that merely over-match generic terms. Measured failure of
  // plain distinct-term ranking: the subject file never reached the pick pool.
  const df = new Map<string, number>();
  for (const c of cards) for (const t of c.terms) df.set(t, (df.get(t) ?? 0) + 1);
  // Generic prior, no domain knowledge: generated / vendored / lock / huge
  // files are rarely the edit target, however many generic terms they contain
  // (measured: a 15k-line generated .d.ts out-massed the real target).
  const NOISE_PATH = /(^|\/)(dist|build|vendor|node_modules|coverage|\.cache)\//;
  const NOISE_NAME = /(^|\/)([^/]*\.d\.ts|[^/]*\.min\.[jt]sx?|[^/]*\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
  const isNoise = (c: Card): boolean => NOISE_PATH.test(c.rel) || NOISE_NAME.test(c.rel) || c.size > 256 * 1024;
  const score = (c: Card): number =>
    c.terms.reduce((a, t) => a + 1 / Math.log(2 + (df.get(t) ?? 1)), 0) * (isNoise(c) ? 0.25 : 1);
  cards.sort((a, b) => score(b) - score(a) || b.matches.length - a.matches.length);
  cards.forEach((c, i) => {
    c.id = `F${i + 1}`;
  });
  return cards.slice(0, CANDIDATE_CAP);
};

const cardLine = (c: Card, lines: number | undefined): string => {
  const anchors = c.matches.map((m) => `${m.line}:${m.text.slice(0, 60)}`).join(" · ");
  const sz = c.size >= 1024 ? `${Math.round(c.size / 1024)}KB` : `${c.size}B`;
  const outline = c.outline.length > 0 ? ` · outline: ${c.outline.join(", ")}` : "";
  return `  ${c.rel} (${lines === undefined ? sz : `${lines} ln`}; matched: ${c.terms.join(", ")}; anchors: ${anchors || "n/a"}${outline})`;
};

/** Deterministic enumerations (plan-v3 §9 stretch, never a jev call):
 * feature-id set from a GeoJSON pick − code-table values from a TS pick. */
const extractEnumerations = async (
  picks: Card[],
  cwd: string,
): Promise<string | undefined> => {
  let featureIds: string[] | undefined;
  let tableValues: string[] | undefined;
  let tableFile = "";
  for (const p of picks.slice(0, 3)) {
    try {
      const s = await stat(p.abs);
      if (s.size > ENUM_FILE_MAX_BYTES) continue;
      const buf = await readFile(p.abs, "utf8");
      if (p.ext === ".json") {
        const parsed = JSON.parse(buf) as { features?: Array<{ id?: unknown }> };
        const ids = (parsed.features ?? [])
          .map((f) => (typeof f.id === "string" ? f.id : undefined))
          .filter((v): v is string => v !== undefined)
          .filter((v) => v !== "-99");
        if (ids.length > 50) featureIds = ids;
      } else if (/\.(tsx|ts|js|jsx|mjs)$/.test(p.ext)) {
        const pairs = new Set<string>();
        for (const m of buf.matchAll(/"([A-Z]{2})"\s*:\s*"([A-Z]{3})"/g)) pairs.add(m[2] as string);
        for (const m of buf.matchAll(/\[\s*"([A-Z]{2})"\s*,\s*"([A-Z]{3})"\s*\]/g)) pairs.add(m[2] as string);
        for (const m of buf.matchAll(/[A-Z]{2}:\s*"([A-Z]{3})"/g)) pairs.add(m[1] as string);
        if (pairs.size > 50) {
          tableValues = [...pairs];
          tableFile = p.rel;
        }
      }
    } catch {
      // not parseable — skip silently, the digest just lacks the diff
    }
  }
  if (featureIds === undefined || tableValues === undefined) return undefined;
  const table = new Set(tableValues);
  const missing = [...new Set(featureIds)].filter((id) => /^[A-Z]{3}$/.test(id) && !table.has(id));
  if (missing.length === 0 || missing.length > 30) return undefined;
  return `Deterministic set-diff (computed locally, not by a model): ${missing.length} alpha-3 id(s) present in the map data but absent from the code table in ${tableFile}: ${missing.join(", ")}`;
};

export interface S0Deps {
  decisionkit: DecisionKitCore;
}

/** Files whose CONTENT matches the query (grep-fallback backend shared with
 * the S0 sweep). Used by decisionkit_locate as a fallback when its filename
 * search yields nothing — filenames rarely contain the task's subject word
 * (measured: "greenland" exists only inside file contents). Never throws. */
export const contentFileSearch = async (
  cwd: string,
  query: string,
  wallMs: number,
): Promise<string[]> => {
  const terms = extractTerms(query);
  const useRg = await haveRg(cwd);
  const res = await fanOut(cwd, terms.length > 0 ? terms : [query.trim()], useRg, true, Date.now() + wallMs);
  if (res.error) return [];
  return [...new Set(res.hits.map((h) => h.file))];
};

/**
 * Local S0 prep (P2 latency hygiene): terms → fan-out → cards → outlines.
 * Pure local work, ZERO jev calls — the host runs this concurrently with the
 * routing call, so the sweep latency hides inside the routing round trip.
 * Never throws; a `failed` reason means fail-open (no digest).
 */
export interface S0Prep {
  task: string;
  cwd: string;
  terms: string[];
  useRg: boolean;
  cards: Card[];
  started: number;
  failed?: string;
}

export async function s0LocalPrep(task: string, cwd: string): Promise<S0Prep> {
  const started = Date.now();
  const deadline = started + WALL_BUDGET_MS;
  const prep: S0Prep = { task, cwd, terms: [], useRg: false, cards: [], started };
  const terms = extractTerms(task);
  if (terms.length === 0) {
    prep.failed = "no-salient-terms";
    return prep;
  }
  prep.terms = terms;
  prep.useRg = await haveRg(cwd);
  const first = await fanOut(cwd, terms, prep.useRg, false, deadline);
  if (first.error) {
    prep.failed = "fan-out-error";
    return prep;
  }
  let cards = await buildCards(cwd, first.hits, terms);
  if (cards.length === 0) {
    // Widen once: files-only sweep for basename-ish matches. Only on a
    // completed-but-empty sweep — an aborted sweep must fail open, not widen.
    const loose = await fanOut(cwd, terms, prep.useRg, true, deadline);
    if (loose.error) {
      prep.failed = "fan-out-error";
      return prep;
    }
    cards = await buildCards(cwd, loose.hits, terms);
  }
  if (cards.length === 0) {
    prep.failed = "no-candidates";
    return prep;
  }
  // Deterministic outlines for the top cards (local parse, 0 jev calls):
  // exported symbols with line numbers → the frontier can plan ranged reads.
  for (const c of cards.slice(0, PICK_OPTION_CAP)) {
    c.outline = await extractOutline(c.abs, c.ext);
  }
  prep.cards = cards;
  return prep;
}

/** Run the S0 state machine for one task prompt. Never throws. */
export async function runS0(deps: S0Deps, task: string, cwd: string): Promise<S0Outcome> {
  const prep = await s0LocalPrep(task, cwd);
  return finishS0(deps, prep);
}

/** jev phase of S0: batched assemble rounds over the prepared cards. */
export async function finishS0(deps: S0Deps, prep: S0Prep): Promise<S0Outcome> {
  const { task, cwd, terms, useRg, cards: prepCards } = prep;
  const started = prep.started;
  const outcome: S0Outcome = { digestLines: [], picked: [], pickedRel: [], rejected: [], related: [], flows: [], ms: 0, jevCalls: 0, candidates: 0, receipts: [] };
  const wallLeft = (): number => WALL_BUDGET_MS - (Date.now() - started);
  const breach = (why: string): S0Outcome => {
    outcome.failOpen = why;
    outcome.ms = Date.now() - started;
    return outcome;
  };
  if (prep.failed !== undefined) return breach(prep.failed);
  if (wallLeft() <= 0) return breach("wall-budget");
  let cards = prepCards;
  // Normalized ids across prep generations (prep may have widened internally).
  cards.forEach((c, i) => {
    c.id = `F${i + 1}`;
  });

  const fmtSize = (c: Card): string => (c.size >= 1024 ? `${Math.round(c.size / 1024)}KB` : `${c.size}B`);

  const buildDigest = (draft: Card[], rest: Card[], flows: S0Edge[], diff?: string): string => {
    const lines_: string[] = [];
    lines_.push(DIGEST_MARKER);
    lines_.push(`Task: ${task.length > 220 ? `${task.slice(0, 220)}…` : task}`);
    lines_.push("Files:");
    for (const c of draft) {
      const ln = lineCounts.get(c.rel);
      lines_.push(cardLine(c, ln === undefined ? undefined : ln));
    }
    // Related (graph facts, deterministic): files a picked file references.
    // Outlines were read locally; the frontier gets the names + export
    // signatures without re-deriving the reference graph. Bounded.
    const related = rest.filter((c) => c.widened === true).slice(0, 4);
    if (related.length > 0) {
      lines_.push("Related (referenced by a file above — import or path reference; outlines read, content not):");
      for (const c of related) {
        const ln = lineCounts.get(c.rel);
        const outline = c.outline.length > 0 ? ` · outline: ${c.outline.join(", ")}` : "";
        lines_.push(`  ${c.rel} (${ln === undefined ? fmtSize(c) : `${ln} ln`}${outline})`);
      }
    }
    if (flows.length > 0) {
      lines_.push("Flows (deterministic references resolved to repo files):");
      for (const e of flows.slice(0, 6)) lines_.push(`  ${e.from} → ${e.to} (via ${e.via})`);
    }
    if (diff !== undefined) lines_.push(diff);
    lines_.push("Read for you: match-line excerpts with line anchors (scoped) and export outlines of the files above; no whole files.");
    const rejected = rest.filter((c) => c.widened !== true).slice(0, 5);
    if (rejected.length > 0) {
      lines_.push(`Not read: ${rejected.map((c) => c.rel).join(", ")} — request if needed.`);
    }
    let text = lines_.join("\n");
    if (text.length > DIGEST_MAX_CHARS) text = `${text.slice(0, DIGEST_MAX_CHARS)}…[truncated]`;
    return text;
  };

  // ONE batched jev call per round (gate + pick + confidence + sufficiency
  // evaluated orthogonally in a single round trip). The draft digest ships in
  // the call state so sufficiency judges the real thing. The loop ends only
  // when coverage is structurally accounted for (see header stop policy) or
  // the round/budget caps hit.
  const picked: Card[] = [];
  const failed = new Set<string>();
  const lineCounts = new Map<string, number>();
  let listing: Set<string> | undefined;
  let diff: string | undefined;
  let digest = "";
  let flows: S0Edge[] = [];
  /** Focused-escalation mode: the round's options are ONLY the undispositioned
   * deterministic neighbors of the picks (a "none" over the full pool is not a
   * disposition of graph facts). Reset by any verified pick. */
  let focused = false;

  const widen = async (): Promise<void> => {
    listing = listing ?? new Set((await listFiles(cwd, 3000)) ?? []);
    const fresh = await importClosure(cwd, picked, listing);
    for (const e of fresh.edges) {
      if (!flows.some((f) => f.from === e.from && f.to === e.to && f.via === e.via)) flows.push(e);
    }
    // A flow target that is ALREADY a card (it matched terms in the sweep)
    // keeps its card — but the reference makes it a graph fact regardless of
    // how it entered the pool: transfer the widened marker (and enrich the
    // outline) instead of dropping the fresh duplicate.
    const byAbs = new Map(cards.map((c) => [c.abs, c]));
    const newCards: Card[] = [];
    for (const c of fresh.cards) {
      const existing = byAbs.get(c.abs);
      if (existing !== undefined) {
        existing.widened = true;
        if (existing.outline.length === 0) {
          existing.outline = await extractOutline(existing.abs, existing.ext);
          try {
            const wc = await execFileAsync("wc", ["-l", existing.abs], { cwd, timeout: 1500 });
            lineCounts.set(existing.rel, Number(wc.stdout.trim().split(/\s+/)[0]) || 0);
          } catch {
            lineCounts.set(existing.rel, 0);
          }
        }
      } else {
        newCards.push(c);
      }
    }
    if (newCards.length > 0) {
      for (const c of newCards) {
        c.outline = await extractOutline(c.abs, c.ext);
        try {
          const wc = await execFileAsync("wc", ["-l", c.abs], { cwd, timeout: 1500 });
          lineCounts.set(c.rel, Number(wc.stdout.trim().split(/\s+/)[0]) || 0);
        } catch {
          lineCounts.set(c.rel, 0);
        }
      }
      // Neighborhood files lead the next round's pool: term-rank order puts
      // them outside PICK_OPTION_CAP (measured: route/api files ranked below
      // docs on generic-term matches), and a pool sliced from rank order
      // would never show them to the pick question.
      cards = [...newCards, ...cards];
      // buildCards renumbers each generation from F1 — appended cards can
      // collide with existing ids and the pick would map to the wrong file.
      // Renumber the whole set once, after every append.
      cards.forEach((c, i) => {
        c.id = `F${i + 1}`;
      });
    }
  };

  for (let round = 0; round < 3; round++) {
    if (wallLeft() <= 0 || outcome.jevCalls >= JEVCALL_BUDGET) break;
    let pool = cards.filter((c) => !picked.includes(c) && !failed.has(c.id));
    if (focused) pool = pool.filter((c) => c.widened === true);
    pool = pool.slice(0, PICK_OPTION_CAP);
    if (pool.length === 0) break;
    // Sufficiency judges the digest that would ACTUALLY ship (verified picks
    // only). A draft padded with provisional pool files measures the wrong
    // thing — measured: jev scored a 4-file draft "some", then declined to
    // pick anything ("covered") while the shipped digest had 1 file.
    const rest = cards.filter((c) => !picked.includes(c));
    const draft = buildDigest(picked, rest, flows, diff);
    const res = await deps.decisionkit.s0Assemble({
      task,
      ids: pool.map((c) => c.id),
      candidates: pool.map((c) => `${c.id} ${c.rel} (${c.terms.join(",") || "no terms"})`),
      digestSummary: draft.slice(0, 1600),
    });
    outcome.jevCalls++;
    outcome.receipts.push(res.receipt);
    if (res.explore !== true) {
      // Gate said no (or the answer was lost) — skip, not failure.
      outcome.skip = res.explore === undefined ? "assemble-fail-open" : "gate";
      outcome.ms = Date.now() - started;
      return outcome;
    }
    if (res.pick === undefined) {
      // jev says no further candidate is needed. Legitimate stop only when the
      // picks' deterministic neighbors are all dispositioned; otherwise one
      // focused round asks over exactly those neighbors — declining a file
      // the digest says is referenced is then an explicit, receipted judgment.
      if (picked.length > 0) {
        if (!focused && rest.some((c) => c.widened === true) && round < 2) {
          focused = true;
          continue;
        }
        break;
      }
      return breach("no-verified-picks");
    }
    const pickId = res.pick;
    const chosen = pool.find((c) => c.id === pickId) ?? pool.find((c) => pickId.startsWith(c.id));
    if (chosen === undefined) break;
    // Deterministic verification (plan-v3 §1.2): the picked file must contain
    // ≥1 salient task term — a local rg/grep check, no model.
    if (!(await verifyFileHasTerm(chosen.abs, terms, useRg))) {
      failed.add(chosen.id);
      focused = false;
      continue;
    }
    picked.push(chosen);
    focused = false;
    // Outline + line count for the verified pick (local, 0 jev calls).
    chosen.outline = await extractOutline(chosen.abs, chosen.ext);
    try {
      const wc = await execFileAsync("wc", ["-l", chosen.abs], { cwd, timeout: 1500 });
      lineCounts.set(chosen.rel, Number(wc.stdout.trim().split(/\s+/)[0]) || 0);
    } catch {
      lineCounts.set(chosen.rel, 0);
    }
    diff = diff ?? await extractEnumerations(picked, cwd);
    digest = buildDigest(picked, cards.filter((c) => !picked.includes(c)), flows, diff);
    // HIGH sufficiency on the real digest is the only score-based early break —
    // and even it must clear the structural gate: every deterministic neighbor
    // of the picks must be dispositioned (picked, verify-failed, or explicitly
    // declined in a focused round) before the digest may claim coverage.
    // Mid-scale scores never break: "enough to plan" is satisfied by any
    // decent first pick (measured: a 1-of-5-file digest shipped, leaving 4/5
    // frontier discoveries as wasted re-discovery).
    if ((res.sufficiency ?? 0) >= Math.max(2, deps.decisionkit.thresholds.s0SufficiencyMin)) {
      const restAfter = cards.filter((c) => !picked.includes(c) && !failed.has(c.id));
      if (!restAfter.some((c) => c.widened === true)) break;
      if (round < 2) {
        focused = true;
        continue;
      }
      break;
    }
    // Widen (rounds 0–1) with the deterministic neighborhood of the picks —
    // the import closure AND path-literal edges (fetch("/api/x") style route
    // references an import parse cannot see). Cumulative: each new pick's
    // closure joins the pool (and each edge becomes a digest flow fact).
    if (round < 2) await widen();
    // Else: loop re-assembles with the widened card set in the next round.
  }

  if (picked.length === 0) return breach("no-verified-picks");
  outcome.candidates = cards.length;
  const restFinal = cards.filter((c) => !picked.includes(c));
  if (digest === "") {
    digest = buildDigest(picked, restFinal, flows, diff);
  }

  outcome.digest = digest;
  outcome.digestLines = digest.split("\n");
  outcome.picked = picked.map((p) => p.abs);
  outcome.pickedRel = picked.map((p) => p.rel);
  outcome.related = restFinal.filter((c) => c.widened === true).slice(0, 5).map((c) => c.rel);
  outcome.flows = flows.slice(0, 12);
  outcome.rejected = restFinal
    .filter((c) => c.widened !== true)
    .slice(0, 5)
    .map((c) => c.rel);
  if (diff !== undefined) outcome.diff = diff;
  outcome.ms = Date.now() - started;
  return outcome;
}
