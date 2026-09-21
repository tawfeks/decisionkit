import { choice, score } from "@typesafe-ai/sdk";
import { DecisionKitCore, InMemoryLedger } from "decisionkit-core";

// Iteration 2: wording that separates "raw content IS the answer" from
// "explanation/lookup needed" — probed live against the reported prompts.
const V2 = {
  bestTool: "Which single registered tool, run once, would produce the complete answer the user asked for, with no LLM reasoning, explanation, editing, or any follow-up? Answer read only for a pure file-content request: the user names one specific file and wants to see its raw contents, and seeing those raw contents is the entire request. If the user asks to explain, summarize, analyze, or tell them about the file, or asks any question whose answer must be selected or interpreted from file contents, answer none. Requests that need edits, planning, judgment, or several steps: answer none.",
  confidence: "Would that single tool output, verbatim, be everything the user asked for? Answer high only when the request was purely to print or list something and the raw output fully satisfies it; any question, explanation, or likely follow-up lowers the score.",
};

const PROMPTS = [
  ["read file.md and tell me what it is about", "expect none (needs reasoning)"],
  ["read file.md", "expect read (pure content print)"],
  ["show the contents of README.md", "expect read"],
  ["cat package.json", "expect read"],
  ["list the files in src/lib", "expect ls"],
  ["what port does the dev server use?", "expect none (lookup needs judgment)"],
  ["fix the bug in the leaderboard rendering", "expect none"],
  ["destroy src folder", "expect none (judgment)"],
  ["open src/lib/db.ts and add a retry wrapper", "expect none"],
];

const ledger = new InMemoryLedger(undefined);
const dk = new DecisionKitCore({ model: "jev-1.13.0" }, ledger);
const options = { read: null, ls: null, none: null };
const state = {
  prompt: "",
  cwd: "/tmp/probe-repo",
  gitStatus: null,
  files: ["README.md", "file.md", "src/lib/db.ts", "src/components/Leaderboard.tsx", "package.json"],
};

const routeOnce = async (prompt) => {
  const res = await dk.ask(
    { ...state, prompt },
    {
      bestTool: choice(V2.bestTool, options),
      confidence: score(V2.confidence, ["none", "some", "high"]),
    },
  );
  return `${res.answers.bestTool?.choice ?? "?"}(conf=${(res.answers.confidence?.score ?? 0).toFixed(2)})`;
};

let pass = 0, total = 0;
console.log("== ROUTING wording v2 (2 runs each) ==");
for (const [prompt, expect] of PROMPTS) {
  const r1 = await routeOnce(prompt);
  const r2 = await routeOnce(prompt);
  const want = expect.startsWith("expect none") ? "none" : expect.startsWith("expect read") ? "read" : "ls";
  const got = [r1, r2].map((r) => r.split("(")[0]);
  const ok = got.every((g) => g === want);
  if (ok) pass++; total++;
  console.log(`${ok ? "PASS" : "FAIL"} · ${prompt}   [${expect}] → ${r1} | ${r2}`);
}
console.log(`\n${pass}/${total} prompts behave as expected`);
console.log(`ledger: calls=${ledger.totals().calls} failOpen=${ledger.totals().failOpen}`);
