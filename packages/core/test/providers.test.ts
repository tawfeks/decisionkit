import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_DECISIONS_URL,
  parseDotEnv,
  resolveProvider,
  toOpenRouterModel,
} from "../src/providers.js";
import { InMemoryLedger } from "../src/ledger.js";
import { DecisionKitCore } from "../src/decisionkit.js";

const noEnv: Record<string, string | undefined> = { DECISIONKIT_PROVIDER: undefined };
const noFile: Record<string, string> = {};

describe("toOpenRouterModel", () => {
  it("maps TypeSafe model ids to OpenRouter slugs", () => {
    expect(toOpenRouterModel("jev-1.13.0")).toBe("typesafe/jev-1.13");
    expect(toOpenRouterModel("jev-1.13")).toBe("typesafe/jev-1.13");
    expect(toOpenRouterModel("jev-latest")).toBe("typesafe/jev-1.13");
    expect(toOpenRouterModel("typesafe/jev-1.13")).toBe("typesafe/jev-1.13");
  });
});

describe("parseDotEnv", () => {
  it("parses KEY=VALUE lines with comments and quotes", () => {
    const parsed = parseDotEnv(
      [
        "# comment",
        "OPENROUTER_API_KEY=sk-or-v1-abc",
        'TYPESAFE_API_KEY="quoted"',
        "EMPTY=",
        "noequals",
        "export EXPORTED=1",
      ].join("\n"),
    );
    expect(parsed.OPENROUTER_API_KEY).toBe("sk-or-v1-abc");
    expect(parsed.TYPESAFE_API_KEY).toBe("quoted");
    expect(parsed.EXPORTED).toBe("1");
    expect(parsed.EMPTY).toBe("");
    expect(parsed["noequals"]).toBeUndefined();
  });
});

describe("resolveProvider", () => {
  it("prefers TYPESAFE_API_KEY (direct API) over OPENROUTER_API_KEY from the environment", () => {
    const p = resolveProvider(
      {},
      { ...noEnv, OPENROUTER_API_KEY: "sk-or-env", TYPESAFE_API_KEY: "ts-env" },
      noFile,
    );
    expect(p?.kind).toBe("typesafe");
    expect(p?.kind === "typesafe" && p.apiKey).toBe("ts-env");
  });

  it("falls back to OpenRouter when only OPENROUTER_API_KEY is present", () => {
    const p = resolveProvider({}, noEnv, { OPENROUTER_API_KEY: "sk-or-file" });
    expect(p?.kind).toBe("openrouter");
  });

  it("prefers an explicit direct apiKey over the environment's OpenRouter key", () => {
    const p = resolveProvider(
      { apiKey: "explicit-ts-key" },
      { ...noEnv, OPENROUTER_API_KEY: "sk-or-env" },
      noFile,
    );
    expect(p?.kind).toBe("typesafe");
  });

  it("routes an explicit sk-or- config key to OpenRouter", () => {
    const p = resolveProvider({ apiKey: "sk-or-v1-explicit" }, noEnv, noFile);
    expect(p?.kind).toBe("openrouter");
  });

  it("lets DECISIONKIT_PROVIDER force the direct TypeSafe path", () => {
    const p = resolveProvider(
      {},
      { DECISIONKIT_PROVIDER: "typesafe", OPENROUTER_API_KEY: "sk-or-env", TYPESAFE_API_KEY: "ts-env" },
      noFile,
    );
    expect(p?.kind).toBe("typesafe");
  });

  it("lets DECISIONKIT_PROVIDER force OpenRouter without any Typesafe key", () => {
    const p = resolveProvider({}, { DECISIONKIT_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-env" }, noFile);
    expect(p?.kind).toBe("openrouter");
  });

  it("pins the model through the OpenRouter slug mapping", () => {
    const p = resolveProvider({ model: "jev-1.13.0" }, { ...noEnv, OPENROUTER_API_KEY: "sk-or-env" }, noFile);
    expect(p?.kind === "openrouter" && p.model).toBe("typesafe/jev-1.13");
  });

  it("returns undefined with no keys anywhere (fail-open)", () => {
    expect(resolveProvider({}, noEnv, noFile)).toBeUndefined();
  });
});

describe("DecisionKitCore over the OpenRouter transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const withOpenRouterEnv = () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-test");
    vi.stubEnv("TYPESAFE_API_KEY", "");
  };
  const okBody = {
    id: "gen-1",
    model: "typesafe/jev-1.13",
    provider: "TypeSafe",
    answers: {
      destructive: { type: "noul", noul: 0.9 },
      severity: { type: "score", score: 2 },
    },
    usage: { input_tokens: 42, output_tokens: 0, cost: 0.000001 },
  };

  it("posts the same questions schema to /api/alpha/decisions and drives decisions", async () => {
    withOpenRouterEnv();
    const seen: { url: string; init: RequestInit }[] = [];
    const decisionkit = new DecisionKitCore(
      {
        enabled: true,
        timeoutMs: 500,
        fetch: (async (input: string | URL, init?: RequestInit) => {
          seen.push({ url: String(input), init: init ?? {} });
          return new Response(JSON.stringify(okBody), { status: 200 });
        }) as typeof fetch,
      },
      new InMemoryLedger(),
    );
    const decision = await decisionkit.guardrail({ tool: "bash", toolInput: { command: "rm -rf ." } });
    expect(decision.action).toBe("block");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(OPENROUTER_DECISIONS_URL);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer sk-or-/);
    const body = JSON.parse(String(seen[0]!.init.body)) as {
      model: string;
      state: unknown;
      questions: Record<string, { type: string; instructions: unknown; criteria: unknown }>;
    };
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.questions.destructive.type).toBe("noul");
    expect(body.questions.severity.type).toBe("score");
    expect(decision.receipt.inputTokens).toBe(42);
    expect(decision.receipt.model).toBe("typesafe/jev-1.13");
    expect(decision.receipt.failOpen).toBeUndefined();
  });

  it("fails open on HTTP errors from OpenRouter", async () => {
    withOpenRouterEnv();
    const decisionkit = new DecisionKitCore(
      {
        enabled: true,
        timeoutMs: 500,
        fetch: (async () => new Response('{"error":{"code":502,"message":"Provider returned error"}}', { status: 502 })) as typeof fetch,
      },
      new InMemoryLedger(),
    );
    const decision = await decisionkit.guardrail({ tool: "bash", toolInput: {} });
    expect(decision.action).toBe("allow");
    expect(decision.receipt.failOpen).toBe(true);
  });

  it("retries one transient HTTP failure (422/5xx) and recovers the run", async () => {
    withOpenRouterEnv();
    const seen: number[] = [];
    const decisionkit = new DecisionKitCore(
      {
        enabled: true,
        timeoutMs: 500,
        fetch: (async () => {
          seen.push(1);
          if (seen.length === 1) {
            return new Response('{"error":{"code":422,"message":"upstream flap"}}', { status: 422 });
          }
          return new Response(JSON.stringify(okBody), { status: 200 });
        }) as typeof fetch,
      },
      new InMemoryLedger(),
    );
    const decision = await decisionkit.guardrail({ tool: "bash", toolInput: { command: "rm -rf ." } });
    expect(seen).toHaveLength(2);
    expect(decision.action).toBe("block");
    expect(decision.receipt.failOpen).toBeUndefined();
  });

  it("does not retry non-transient HTTP errors (401 never recovers)", async () => {
    withOpenRouterEnv();
    const seen: number[] = [];
    const decisionkit = new DecisionKitCore(
      {
        enabled: true,
        timeoutMs: 500,
        fetch: (async () => {
          seen.push(1);
          return new Response('{"error":{"code":401,"message":"bad key"}}', { status: 401 });
        }) as typeof fetch,
      },
      new InMemoryLedger(),
    );
    const decision = await decisionkit.guardrail({ tool: "bash", toolInput: {} });
    expect(seen).toHaveLength(1);
    expect(decision.action).toBe("allow");
    expect(decision.receipt.failOpen).toBe(true);
  });

  it("does not retry after the hard per-attempt timeout", async () => {
    withOpenRouterEnv();
    const seen: number[] = [];
    const decisionkit = new DecisionKitCore(
      {
        enabled: true,
        timeoutMs: 100,
        fetch: (async (_input: string | URL, init?: RequestInit) => {
          seen.push(1);
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
          return new Response(JSON.stringify(okBody), { status: 200 });
        }) as typeof fetch,
      },
      new InMemoryLedger(),
    );
    const decision = await decisionkit.guardrail({ tool: "bash", toolInput: {} });
    expect(seen).toHaveLength(1);
    expect(decision.action).toBe("allow");
    expect(decision.receipt.failOpen).toBe(true);
  });
});
