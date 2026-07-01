import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { toLLMConfig } from "./config.ts";
import {
  createOpenAIPromptCacheKey,
  withAutomaticOpenAIPromptCacheKeys,
} from "./prompt-cache.ts";

const scope = {
  namespace: "compass",
  threadId: "thread-secret",
  agentId: "south",
};

Deno.test("OpenAI prompt cache keys are deterministic, opaque, and isolated", async () => {
  const first = await createOpenAIPromptCacheKey(scope, "gpt-5.4");
  const repeated = await createOpenAIPromptCacheKey(scope, "gpt-5.4");
  const otherThread = await createOpenAIPromptCacheKey(
    { ...scope, threadId: "another-thread" },
    "gpt-5.4",
  );
  const otherAgent = await createOpenAIPromptCacheKey(
    { ...scope, agentId: "north" },
    "gpt-5.4",
  );
  const otherModel = await createOpenAIPromptCacheKey(scope, "gpt-5.5");

  assertEquals(first, repeated);
  assertMatch(first, /^[a-f0-9]{64}$/);
  assertEquals(first.includes(scope.threadId), false);
  assertEquals(first.includes(scope.agentId), false);
  assertNotEquals(first, otherThread);
  assertNotEquals(first, otherAgent);
  assertNotEquals(first, otherModel);
});

Deno.test("automatic OpenAI cache keys cover primary and fallback models", async () => {
  const configured = await withAutomaticOpenAIPromptCacheKeys({
    provider: "openai",
    model: "gpt-5.4",
    fallbacks: [
      { provider: "openai", model: "gpt-5.5" },
      { provider: "anthropic", model: "claude-opus-4-8" },
    ],
  }, scope);

  assertMatch(configured.openaiPromptCacheKey ?? "", /^[a-f0-9]{64}$/);
  assertMatch(
    configured.fallbacks?.[0].openaiPromptCacheKey ?? "",
    /^[a-f0-9]{64}$/,
  );
  assertNotEquals(
    configured.openaiPromptCacheKey,
    configured.fallbacks?.[0].openaiPromptCacheKey,
  );
  assertEquals(
    configured.fallbacks?.[1].openaiPromptCacheKey,
    undefined,
  );

  const persisted = toLLMConfig(configured);
  assertEquals(
    persisted.openaiPromptCacheKey,
    configured.openaiPromptCacheKey,
  );
  assertEquals(
    persisted.fallbacks?.[0].openaiPromptCacheKey,
    configured.fallbacks?.[0].openaiPromptCacheKey,
  );
});

Deno.test("explicit OpenAI prompt cache keys take precedence", async () => {
  const configured = await withAutomaticOpenAIPromptCacheKeys({
    provider: "openai",
    model: "gpt-5.4",
    openaiPromptCacheKey: "caller-controlled",
    fallbacks: [
      { provider: "openai", model: "gpt-5.5" },
      {
        provider: "openai",
        model: "gpt-4.1",
        openaiPromptCacheKey: "fallback-controlled",
      },
    ],
  }, scope);

  assertEquals(configured.openaiPromptCacheKey, "caller-controlled");
  assertEquals(
    configured.fallbacks?.[0].openaiPromptCacheKey,
    "caller-controlled",
  );
  assertEquals(
    configured.fallbacks?.[1].openaiPromptCacheKey,
    "fallback-controlled",
  );
});

Deno.test("automatic keys skip ChatGPT OAuth but cover its standard OpenAI fallback", async () => {
  const configured = await withAutomaticOpenAIPromptCacheKeys({
    provider: "openai",
    model: "gpt-5.4",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    fallbacks: [{
      provider: "openai",
      model: "gpt-5.4",
      baseUrl: undefined,
    }],
  }, scope);

  assertEquals(configured.openaiPromptCacheKey, undefined);
  assertMatch(
    configured.fallbacks?.[0].openaiPromptCacheKey ?? "",
    /^[a-f0-9]{64}$/,
  );
});
