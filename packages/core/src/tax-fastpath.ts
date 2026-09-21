/**
 * Static read-only bash classification for the guardrail fast path
 * (plan-v3 §2.4). Zero model calls: allow only when every segment of a
 * compound command is provably read-only; anything unrecognized falls
 * through to jev. Generic shell/interpreter knowledge, no repo/domain
 * specifics (plan-v3 §0.1).
 *
 * Shared by every host adapter (pi, opencode, kilo plugins and the
 * Claude/Codex stdin hooks) — policy lives in core.
 *
 * Compound analysis matters because the measured agent habit is
 * `cd "…" ; python3 …` — a first-token check sent every such call to jev
 * (14 calls in one session where ~3 suffice).
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";

export const READ_ONLY_BASH = new Set([
  "ls", "cat", "head", "tail", "wc", "find", "rg", "grep", "pwd", "which",
  "file", "stat", "du", "cd", "echo", "true", "false", "test",
]);
export const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files"]);
/** Interpreters are allowlisted ONLY for script bodies that pass the static
 * read-only scan — and never for `-m <module>` (a module is a program). */
const SCRIPT_INTERPRETERS = new Set(["python", "python3", "node"]);

export const bashFirstToken = (command: string): { cmd: string; args: string[] } | undefined => {
  const tokens = command.trim().split(/\s+/).filter((t) => t !== "");
  const first = tokens[0];
  if (first === undefined) return undefined;
  return { cmd: first, args: tokens.slice(1) };
};

// Output redirection is a write: only /dev/null (universal sink) and fd dups
// (2>&1) are harmless. Input redirection reads. Anything unrecognized is not
// read-only (falls through to jev).
const redirectUnsafe = (segment: string): boolean => {
  // fd dups (2>&1) are not file redirections — strip them before scanning.
  const cleaned = segment.replace(/\d>&\d/g, " ");
  for (const m of cleaned.matchAll(/(>>?|<<?)\s*([^\s|&;]*)/g)) {
    const op = m[1] ?? "";
    const target = m[2] ?? "";
    if (op.startsWith("<")) continue;
    if (target !== "/dev/null") return true;
  }
  return false;
};

// Static scan of interpreter script bodies (heredocs, -c/-e one-liners).
// Deny-list of side-effect tokens; anything unrecognized is NOT read-only.
const PY_WRITE_RE =
  /\b(shutil|subprocess|popen|system\s*\(|socket|urllib|requests|urlopen|pickle|importlib|__import__|eval\s*\(|exec\s*\(|compile\s*\(|writelines?|write_text|write_bytes|remove\s*\(|unlink\s*\(|mkdir|makedirs|rename\s*\(|rmtree|chmod|chown|truncate|symlink|to_csv|to_json|to_parquet|to_sql|savefig|dump\s*\()/i;
const NODE_WRITE_RE =
  /\b(writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rmdir(?:Sync)?|mkdir(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?|truncate(?:Sync)?|chmod(?:Sync)?|spawn|exec(?:Sync)?\s*\(|eval\s*\(|fetch\s*\()/i;
// open(...) is a write only with a second (mode) argument containing
// w/a/x/+; bare or 'r'/'rb' reads. The mode lives after the first comma —
// `open('world.geo.json')` must NOT match (the opening quote of the path
// would otherwise pair with its first letter).
const PY_OPEN_WRITE_RE = /open\s*\([^()]*,\s*['"][^'")]*[wax+]/i;
const scriptIsReadOnly = (lang: string, script: string): boolean => {
  if (/\b(-m)\b/.test(script)) return false;
  if (lang === "python") return !PY_WRITE_RE.test(script) && !PY_OPEN_WRITE_RE.test(script);
  if (lang === "node") return !NODE_WRITE_RE.test(script);
  return false;
};

interface ScriptScan {
  shell: string;
  readOnly: boolean;
  /** number of -c/-e interpreter args whose body was actually extracted and
   * scanned — the caller must refuse interpreter segments beyond this count,
   * else oddly-quoted inline scripts would pass unscanned. */
  inlineScanned: number;
}

// Pull interpreter script bodies out of a command: heredoc body + -c/-e args.
const scanScripts = (command: string): ScriptScan => {
  let shell = command;
  let readOnly = true;
  let inlineScanned = 0;
  // heredocs: <<[-]'TAG' … body … TAG. The body is interpreter input, not
  // shell; both it and the closing tag line are removed from the shell text.
  for (const m of command.matchAll(/<<-?\s*['"]?(\w+)['"]?/g)) {
    const tag = m[1];
    if (tag === undefined) continue;
    const headerEnd = command.indexOf("\n", m.index ?? 0);
    if (headerEnd < 0) return { shell, readOnly: false, inlineScanned: 0 };
    // Terminator: the tag on its own line, possibly with trailing spaces, at
    // end-of-input or before a newline.
    const term = new RegExp(`\\n${tag}[ \\t]*(?:\\n|$)`).exec(command.slice(headerEnd));
    if (term === null || term.index === undefined) return { shell, readOnly: false, inlineScanned: 0 };
    const bodyEnd = headerEnd + term.index;
    const header = command.slice(command.lastIndexOf("\n", m.index ?? 0) + 1, headerEnd);
    const body = command.slice(headerEnd + 1, bodyEnd);
    const lang = /\bpython3?\b/.test(header) ? "python" : /\bnode\b/.test(header) ? "node" : "";
    if (lang === "" || !scriptIsReadOnly(lang, body)) readOnly = false;
    // Remove body AND closing tag line (the tag would otherwise surface as a
    // shell segment with a non-allowlisted first token).
    shell = shell.replace(command.slice(headerEnd + 1, bodyEnd + 1 + tag.length), "");
  }
  // -c / -e inline scripts — scan the body, then remove it from the shell
  // text (its content must not surface as shell segments).
  for (const m of shell.matchAll(/\b(?:python3?|node)\s+(?:-[ce]\s+)(["'])([\s\S]*?)\1/g)) {
    const lang = /\bnode\b/.test(m[0]) ? "node" : "python";
    inlineScanned++;
    if (!scriptIsReadOnly(lang, m[2] ?? "")) readOnly = false;
    shell = shell.replace(m[2] ?? "", "");
  }
  return { shell, readOnly, inlineScanned };
};

const countInlineInterpreterArgs = (command: string): number =>
  [...command.matchAll(/\b(?:python3?|node)\s+-[ce]\b/g)].length;

export const bashCommandIsReadOnly = (command: string): boolean => {
  // Command substitution and process substitution can hide anything.
  if (/[`]|\$\(/.test(command)) return false;
  const scan = scanScripts(command);
  // Every -c/-e arg must have been extracted and scanned — an oddly-quoted
  // inline script that dodged extraction must fall through to jev, not pass.
  if (countInlineInterpreterArgs(command) > scan.inlineScanned) return false;
  // Escaped pipes are grep BRE alternation, not shell pipes (`grep "a\|b"`).
  const shell = scan.shell.replace(/\\\|/g, "\u0000");
  if (!scan.readOnly) return false;
  const segments = shell
    .split(/(?:\|\||&&|;|\||\n)/)
    .map((s) => s.trim().replace(/\u0000/g, "\\|"))
    .filter((s) => s !== "");
  if (segments.length === 0) return false;
  for (const seg of segments) {
    if (redirectUnsafe(seg)) return false;
    const t = bashFirstToken(seg);
    if (t === undefined) return false;
    if (t.cmd === "git" && t.args.length > 0 && READ_ONLY_GIT.has(t.args[0] as string)) continue;
    if (READ_ONLY_BASH.has(t.cmd)) {
      // find -delete deletes; every other allowlisted form here is read-only.
      if (t.cmd === "find" && t.args.includes("-delete")) return false;
      continue;
    }
    if (SCRIPT_INTERPRETERS.has(t.cmd)) {
      // Stdin/heredoc scripts were scanned above; allow bare interpreters
      // (and `-` for stdin) only — `-m module` and unknown flags go to jev.
      const flags = t.args.filter((a) => a.startsWith("-"));
      const okFlags = flags.every((f) => f === "-" || f === "-c" || f === "-e");
      if (okFlags && scan.readOnly) continue;
    }
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// S0 waste accounting (plan-v3 §4): discovery-shaped tool calls whose targets
// are not S0-picked files. Shared by the pi adapter and the plugin factory.
// ---------------------------------------------------------------------------

/** Discovery-shaped bash verbs. Deliberately narrower than the guardrail
 * allowlist: `cd`/`echo` are read-only but not discovery verbs, and counting
 * their args as discovery targets would inflate waste. */
export const DISCOVERY_BASH = new Set(["ls", "cat", "head", "tail", "wc", "find", "rg", "grep", "file", "stat", "du", "pwd", "which"]);

/** Extract repo file paths a discovery-shaped tool call touched (read/ls path
 * args; bash discovery-verb args). Shell-aware: pipe tokens, redirects and
 * sub-command names must not resolve into fake paths — only a metachar-free
 * argument that EXISTS as a regular FILE counts (directory args like
 * `ls src` can never match a picked file and would be permanent false
 * waste). Never throws. */
export const extractDiscoveryPaths = (tool: string, input: unknown, cwd: string): string[] => {
  const statSyncSafe = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const paths: string[] = [];
  const isPathArg = (a: string): boolean =>
    !/[|<>&;`$()]/.test(a) && statSyncSafe(resolve(cwd, a)) === true;
  if (tool === "read" || tool === "ls") {
    const p = (input as { path?: unknown }).path ?? (input as { filePath?: unknown }).filePath ?? (input as { file_path?: unknown }).file_path;
    if (typeof p === "string" && p !== "") paths.push(resolve(cwd, p));
  } else if (tool === "bash") {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string") {
      // Any discovery-shaped verb anywhere in a compound command, not just the
      // first token: "cat x | head" and "git stash list" are both discovery.
      for (const seg of command.split(/(?:\|\||\||&&|;)/)) {
        const tok = bashFirstToken(seg);
        if (tok === undefined || !DISCOVERY_BASH.has(tok.cmd)) continue;
        for (const a of tok.args) {
          if (a.startsWith("-") || a === ".") continue;
          const stripped = a.replace(/[*'"]+$/g, "").replace(/^['"]|['"]$/g, "");
          if (stripped === "" || !isPathArg(stripped)) continue;
          paths.push(resolve(cwd, stripped));
        }
      }
    }
  }
  return paths;
};
