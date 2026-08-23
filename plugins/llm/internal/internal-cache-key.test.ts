import { assertEquals, assertNotEquals } from "@std/assert";

import {
  deriveInternalPromptCacheKey,
  readInternalPromptCacheKey,
  withInternalPromptCacheKey,
} from "./internal-cache-key.ts";
import { toLLMConfig } from "./config.ts";

Deno.test("internal prompt cache keys are stable and isolated", async () => {
  const first = await deriveInternalPromptCacheKey("tenant", "thread", "agent");
  const repeated = await deriveInternalPromptCacheKey(
    "tenant",
    "thread",
    "agent",
  );
  const otherThread = await deriveInternalPromptCacheKey(
    "tenant",
    "other",
    "agent",
  );

  assertEquals(first, repeated);
  assertEquals(first.length, 64);
  assertNotEquals(first, otherThread);

  const delimitedNamespace = await deriveInternalPromptCacheKey(
    "tenant:thread",
    "agent",
    "scope",
  );
  const delimitedThread = await deriveInternalPromptCacheKey(
    "tenant",
    "thread:agent",
    "scope",
  );
  assertNotEquals(delimitedNamespace, delimitedThread);
});

Deno.test("internal prompt cache key is runtime-only", () => {
  const runtime = withInternalPromptCacheKey(
    { provider: "openai", model: "gpt-5.6" },
    "stable-key",
  );
  assertEquals(readInternalPromptCacheKey(runtime), "stable-key");
  assertEquals("__copilotzPromptCacheKey" in toLLMConfig(runtime), false);
});
