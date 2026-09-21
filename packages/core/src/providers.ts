import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import type { DecisionKitConfig, StateInput } from "./types.js";

/**
 * DecisionKit provider resolution + transports.
 *
 * Two providers speak the SAME typed-questions schema (state + questions in,
 * calibrated answers out) so the decision layer never changes:
 *
 * - "typesafe": direct TypeSafe API (`POST /v1/systemone` via @typesafe-ai/sdk).
 * - "openrouter": OpenRouter Decisions API (`POST /api/alpha/decisions`,
 *   model `typesafe/jev-1.13`), authenticated with OPENROUTER_API_KEY.
 *   Verified against https://openrouter.ai/docs/api/api-reference/alphadecisions/
 *   submit-a-decisions-questions-and-answers-request.md (2026-09-18): the
 *   request/response schema is the same `{ state, questions }` / `{ answers,
 *   usage: { input_tokens, output_tokens } }` shape, so answers parse into the
 *   identical decision layer.
 *
 * Resolution (first match wins):
 *  1. Explicit `config.provider` (or `DECISIONKIT_PROVIDER` env) forces a provider.
 *  2. An explicit `config.apiKey` starting with `sk-or-` → OpenRouter.
 *  3. An explicit `config.apiKey` (any other value) → direct TypeSafe.
 *  4. TYPESAFE_API_KEY from the environment (or .env) → direct TypeSafe —
 *     the PREFERRED path (typed-questions API, lowest latency).
 *  5. OPENROUTER_API_KEY from the environment (or .env) → OpenRouter Decisions
 *     fallback. Coding agents (pi, kilo, codex, claude, …) that run on
 *     OpenRouter export this var and the harness runs in-process, so the
 *     agent's key still works with zero extra setup.
 *  6. No key → undefined; DecisionKitCore fails open permanently.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai";
export const OPENROUTER_DECISIONS_URL = `${OPENROUTER_BASE_URL}/api/alpha/decisions`;
export const OPENROUTER_DEFAULT_MODEL = "typesafe/jev-1.13";

export type ResolvedProvider =
  | {
      kind: "openrouter";
      apiKey: string;
      model: string;
      siteUrl?: string;
      siteTitle?: string;
      baseURL: string;
    }
  | { kind: "typesafe"; apiKey: string; model: string; baseURL?: string };

export interface ProviderAskResult {
  answers: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export type ProviderAsk = (
  state: StateInput,
  questions: Questions,
) => Promise<ProviderAskResult>;

/** Map a TypeSafe model id (jev-1.13.0, jev-latest) to its OpenRouter slug. */
export function toOpenRouterModel(model: string): string {
  if (model.includes("/")) return model;
  if (model === "jev-latest") return OPENROUTER_DEFAULT_MODEL;
  const m = /^jev-(\d+\.\d+)(?:\.\d+)?$/.exec(model);
  if (m) return `typesafe/jev-${m[1]}`;
  return `typesafe/${model}`;
}

/** Minimal .env parser: KEY=VALUE lines, # comments, optional quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim().replace(/^export\s+/, "");
    if (stripped === "" || stripped.startsWith("#")) continue;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") out[key] = value;
  }
  return out;
}

let dotEnvCache: Record<string, string> | undefined;
function loadDotEnvFile(): Record<string, string> {
  if (dotEnvCache === undefined) {
    try {
      dotEnvCache = parseDotEnv(readFileSync(join(process.cwd(), ".env"), "utf8"));
    } catch {
      dotEnvCache = {};
    }
  }
  return dotEnvCache;
}

function resolveModel(config: DecisionKitConfig, env: Record<string, string | undefined>, openRouter: boolean): string {
  const raw = config.model ?? env.TYPESAFE_DEFAULT_MODEL;
  if (raw === undefined || raw.trim() === "") {
    return openRouter ? OPENROUTER_DEFAULT_MODEL : "jev-1.13.0";
  }
  return openRouter ? toOpenRouterModel(raw.trim()) : raw.trim();
}

export function resolveProvider(
  config: DecisionKitConfig = {},
  env: Record<string, string | undefined> = process.env,
  envFile: Record<string, string> | undefined = undefined,
): ResolvedProvider | undefined {
  const file = envFile ?? loadDotEnvFile();
  const envKey = (name: string): string | undefined => {
    const v = env[name];
    if (v !== undefined && v.trim() !== "") return v.trim();
    const f = file[name];
    return f !== undefined && f.trim() !== "" ? f.trim() : undefined;
  };
  const openRouterKey = envKey("OPENROUTER_API_KEY");
  const typesafeKey = envKey("TYPESAFE_API_KEY");
  const configKey = config.apiKey !== undefined && config.apiKey.trim() !== "" ? config.apiKey.trim() : undefined;
  const configIsOpenRouter = configKey !== undefined && configKey.startsWith("sk-or-");
  const forced = (config.provider ?? env.DECISIONKIT_PROVIDER)?.trim().toLowerCase();
  const openRouterProvider = (apiKey: string): ResolvedProvider => {
    const siteUrl = envKey("OPENROUTER_SITE_URL");
    const siteTitle = envKey("OPENROUTER_SITE_TITLE");
    return {
      kind: "openrouter",
      apiKey,
      model: resolveModel(config, env, true),
      baseURL: envKey("DECISIONKIT_OPENROUTER_BASE_URL") ?? OPENROUTER_BASE_URL,
      ...(siteUrl !== undefined ? { siteUrl } : {}),
      ...(siteTitle !== undefined ? { siteTitle } : {}),
    };
  };

  if (forced === "openrouter") {
    const apiKey = configIsOpenRouter ? configKey! : openRouterKey;
    if (apiKey === undefined) return undefined;
    return openRouterProvider(apiKey);
  }
  if (forced === "typesafe" || forced === "direct" || forced === "typesafe-direct") {
    const apiKey = configIsOpenRouter ? undefined : configKey ?? typesafeKey;
    if (apiKey === undefined) return undefined;
    return {
      kind: "typesafe",
      apiKey,
      model: resolveModel(config, env, false),
      ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    };
  }

  // Auto: explicit config key wins over the environment; between env keys,
  // the direct TypeSafe API is PREFERRED (typed-questions API, lowest
  // latency); OpenRouter Decisions is the fallback when no TypeSafe key is
  // present (agent key / .env).
  if (configIsOpenRouter) return openRouterProvider(configKey!);
  if (configKey !== undefined) {
    return {
      kind: "typesafe",
      apiKey: configKey,
      model: resolveModel(config, env, false),
      ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    };
  }
  if (typesafeKey !== undefined) {
    return {
      kind: "typesafe",
      apiKey: typesafeKey,
      model: resolveModel(config, env, false),
      ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    };
  }
  if (openRouterKey !== undefined) return openRouterProvider(openRouterKey);
  return undefined;
}

/**
 * OpenRouter Decisions transport: same `{ state, questions }` body as the
 * TypeSafe SDK. One bounded retry for transient failures (408/422/429, 5xx,
 * connection errors) so a single flaky call — e.g. the first s0 assemble —
 * does not cost the whole run its digest. NOT retried: the hard per-attempt
 * timeout abort (an attempt that already burned the full latency budget is
 * unlikely to succeed on retry) and non-transient statuses like 401/403.
 * Fail-open remains with the caller in decisionkit.ts, matching the direct
 * path's retry policy.
 */
const OPENROUTER_RETRY_BACKOFF_MS = 150;

const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 422 || status === 429 || (status >= 500 && status <= 599);

export function createOpenRouterAsk(
  provider: Extract<ResolvedProvider, { kind: "openrouter" }>,
  timeoutMs: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): ProviderAsk {
  const url = provider.baseURL.replace(/\/+$/, "") + "/api/alpha/decisions";
  return async (state, questions) => {
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let retryable = false;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            "Content-Type": "application/json",
            ...(provider.siteUrl !== undefined ? { "HTTP-Referer": provider.siteUrl } : {}),
            ...(provider.siteTitle !== undefined ? { "X-Title": provider.siteTitle } : {}),
          },
          body: JSON.stringify({ model: provider.model, state, questions }),
          signal: controller.signal,
        });
        if (!res.ok) {
          if (attempt === 1 && isTransientStatus(res.status)) {
            retryable = true;
          } else {
            throw new Error(`openrouter decisions request failed: HTTP ${res.status}`);
          }
        } else {
          const body = (await res.json()) as {
            answers?: unknown;
            usage?: { input_tokens?: number; output_tokens?: number };
            model?: string;
          };
          if (body.answers === undefined || body.answers === null || typeof body.answers !== "object") {
            throw new Error("openrouter decisions response missing answers object");
          }
          return {
            answers: body.answers as Record<string, unknown>,
            inputTokens: body.usage?.input_tokens ?? 0,
            outputTokens: body.usage?.output_tokens ?? 0,
            model: body.model ?? provider.model,
          };
        }
      } catch (err) {
        // fetch-level failures (network/reset/truncated body) reject as
        // TypeError and are retryable; the hard-timeout abort and
        // deterministic errors are not.
        if (!(attempt === 1 && err instanceof TypeError)) throw err;
        retryable = true;
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, OPENROUTER_RETRY_BACKOFF_MS));
    }
  };
}
