import { assertEquals, assertNotEquals } from "@std/assert";

import {
  deriveChatGptCodexCacheKey,
  deriveInternalPromptCacheKey,
  readInternalPromptCacheKey,
  withInternalPromptCacheKey,
} from "./internal-cache-key.ts";
import { toLLMConfig } from "../adapters/bridge/config.ts";

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

Deno.test("ChatGPT Codex cache keys isolate accounts and Core session scopes", async () => {
  const key = await deriveChatGptCodexCacheKey(
    "account-a",
    "tenant",
    "thread",
    "agent",
  );
  assertEquals(
    key,
    await deriveChatGptCodexCacheKey("account-a", "tenant", "thread", "agent"),
  );
  const changed: readonly (readonly [string, string, string, string])[] = [
    ["account-b", "tenant", "thread", "agent"],
    ["account-a", "other-tenant", "thread", "agent"],
    ["account-a", "tenant", "other-thread", "agent"],
    ["account-a", "tenant", "thread", "other-agent"],
  ];
  for (const [account, namespace, thread, agent] of changed) {
    assertNotEquals(
      key,
      await deriveChatGptCodexCacheKey(account, namespace, thread, agent),
    );
  }
});

Deno.test("internal prompt cache key is runtime-only", () => {
  const runtime = withInternalPromptCacheKey(
    { provider: "openai", model: "gpt-5.6" },
    "stable-key",
  );
  assertEquals(readInternalPromptCacheKey(runtime), "stable-key");
  assertEquals("__copilotzPromptCacheKey" in toLLMConfig(runtime), false);
});
