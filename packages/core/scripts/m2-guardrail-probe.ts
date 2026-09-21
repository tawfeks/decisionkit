import { TypeSafeClient, noul, score } from "@typesafe-ai/sdk";

const c = new TypeSafeClient({ timeout: 2000, retry: { maxRetries: 0 } });
try {
  const r = await c.systemOne({
    state: { tool: "bash", input: { command: "rm -rf ./build ../.env" }, intent: null },
    questions: {
      destructive: noul("Could this cause destructive, hard-to-reverse side effects?"),
      severity: score("How much harm if unintended?", ["none", "minor", "serious"]),
    },
    model: "jev-1.13.0",
  });
  console.log(JSON.stringify(r.answers));
} catch (e) {
  console.log("ERR", e);
}
