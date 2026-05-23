/**
 * Live smoke test for N-step LLM fallback chains.
 *
 * Primary Anthropic is intentionally configured with a bogus model so fallback
 * behavior is exercised without touching secrets. The provider keys come from
 * the loaded environment file unless a scenario intentionally forces a failure.
 *
 * Usage:
 *   deno run -A --env-file=.env scripts/fallback-chain-smoke.ts
 *   deno run -A --env-file=.env scripts/fallback-chain-smoke.ts gemini-3.1-pro gpt-5.4
 */

import { chat } from "@/runtime/llm/index.ts";
import type {
  ProviderConfig,
  ProviderFallbackConfig,
} from "@/runtime/llm/types.ts";

const env = Deno.env.toObject();

const anthropicKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_KEY;
const geminiKey = env.GEMINI_API_KEY || env.GEMINI_KEY;
const openaiKey = env.OPENAI_API_KEY || env.OPENAI_KEY;

const geminiModel = Deno.args[0] || "gemini-3.1-pro";
const openaiModel = Deno.args[1] || "gpt-5.4";
const badAnthropicModel = "claude-fallback-smoke-invalid-model";

type WarningPayload = {
  provider?: unknown;
  model?: unknown;
  reason?: unknown;
  fallbackProvider?: unknown;
  fallbackModel?: unknown;
  message?: unknown;
};

function sanitizeMessage(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .replace(/([?&]key=)[^&\s)]+/g, "$1<redacted>")
    .replace(/(Bearer\s+)[^\s,)]+/gi, "$1<redacted>");
}

function sanitizeWarning(payload: WarningPayload): WarningPayload {
  return {
    ...payload,
    message: sanitizeMessage(payload.message),
  };
}

function sanitizeAttempts(attempts: unknown): unknown {
  if (!Array.isArray(attempts)) return attempts;
  return attempts.map((attempt) => {
    if (!attempt || typeof attempt !== "object") return attempt;
    const item = attempt as Record<string, unknown>;
    return {
      ...item,
      message: sanitizeMessage(item.message),
    };
  });
}

function missingKeys() {
  return [
    !geminiKey ? "GEMINI_API_KEY or GEMINI_KEY" : null,
    !openaiKey ? "OPENAI_API_KEY or OPENAI_KEY" : null,
  ].filter((value): value is string => typeof value === "string");
}

function baseConfig(
  fallback1: ProviderFallbackConfig,
  fallback2: ProviderFallbackConfig,
): ProviderConfig {
  return {
    provider: "anthropic",
    model: badAnthropicModel,
    apiKey: anthropicKey,
    maxTokens: 128,
    outputReasoning: false,
    estimateCost: false,
    fallbacks: [fallback1, fallback2],
  };
}

async function runScenario(
  label: string,
  config: ProviderConfig,
) {
  const originalWarn = console.warn;
  const warnings: WarningPayload[] = [];
  console.warn = (message?: unknown, payload?: unknown, ...rest: unknown[]) => {
    if (
      typeof message === "string" &&
      message.includes("Attempting fallback after provider error")
    ) {
      warnings.push(sanitizeWarning(payload as WarningPayload));
      return;
    }
    originalWarn(message, payload, ...rest);
  };

  try {
    const startedAt = Date.now();
    const response = await chat(
      {
        messages: [{
          role: "user",
          content: "Reply with exactly: ok",
        }],
      },
      config,
      env,
    );

    return {
      label,
      status: "succeeded",
      latencyMs: Date.now() - startedAt,
      provider: response.provider,
      model: response.model,
      answer: response.answer,
      warningCount: warnings.length,
      warnings,
    };
  } catch (error) {
    const providerError = error as {
      name?: string;
      message?: string;
      reason?: unknown;
      provider?: unknown;
      model?: unknown;
      status?: unknown;
      fallbackAttempted?: unknown;
      attempts?: unknown;
    };

    return {
      label,
      status: "failed",
      name: providerError.name ?? null,
      message: sanitizeMessage(providerError.message ?? String(error)),
      reason: providerError.reason ?? null,
      provider: providerError.provider ?? null,
      model: providerError.model ?? null,
      httpStatus: providerError.status ?? null,
      fallbackAttempted: providerError.fallbackAttempted ?? null,
      attempts: sanitizeAttempts(providerError.attempts) ?? null,
      warningCount: warnings.length,
      warnings,
    };
  } finally {
    console.warn = originalWarn;
  }
}

const missing = missingKeys();
if (missing.length > 0) {
  console.error(`Missing required env var(s): ${missing.join(", ")}`);
  Deno.exit(1);
}

const normalGeminiFallback: ProviderFallbackConfig = {
  provider: "gemini",
  model: geminiModel,
  apiKey: geminiKey,
  maxTokens: 128,
  outputReasoning: false,
};

const forcedFailGeminiFallback: ProviderFallbackConfig = {
  ...normalGeminiFallback,
  apiKey: "invalid-gemini-key-for-fallback-smoke",
};

const openaiFallback: ProviderFallbackConfig = {
  provider: "openai",
  model: openaiModel,
  apiKey: openaiKey,
  maxTokens: 128,
  outputReasoning: false,
  reasoningEffort: "medium",
};

const results = [
  await runScenario(
    "anthropic_invalid_to_gemini_then_openai_if_needed",
    baseConfig(normalGeminiFallback, openaiFallback),
  ),
  await runScenario(
    "anthropic_invalid_to_gemini_auth_error_to_openai",
    baseConfig(forcedFailGeminiFallback, openaiFallback),
  ),
];

console.log(JSON.stringify(
  {
    geminiModel,
    openaiModel,
    primaryProvider: "anthropic",
    primaryModel: badAnthropicModel,
    results,
  },
  null,
  2,
));
