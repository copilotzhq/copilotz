import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { process } from "./index.ts";
import type { Event, ProcessorDeps } from "@/types/index.ts";
import type { ProviderRegistry } from "@/runtime/llm/types.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";

const registry: ProviderRegistry = {
  anthropic: () => ({
    endpoint: "https://example.test/anthropic",
    headers: () => ({}),
    body: () => ({}),
    extractContent: () => null,
  }),
};

Deno.test("llm_call processor converts provider failures into failed LLM_RESULT events", async () => {
  const originalFetch = globalThis.fetch;
  const emitted: Event[] = [];
  globalThis.fetch = () =>
    Promise.resolve(
      new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
      }),
    );

  try {
    const result = await process(
      {
        id: "evt-llm-call",
        threadId: "thread-1",
        type: "LLM_CALL",
        payload: {
          agent: { id: "researcher", name: "Researcher" },
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          config: {
            provider: "anthropic",
            model: "claude-test",
            apiKey: "test",
          },
        },
        parentEventId: null,
        traceId: "trace-1",
        priority: 1000,
        metadata: { targetId: "user-1" },
        ttlMs: null,
        expiresAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "processing",
      } as never,
      {
        context: {
          stream: true,
          llmProviders: registry,
        },
        emitToStream: (event: Event) => emitted.push(event),
      } as unknown as ProcessorDeps,
    );

    assertExists(result);
    if (!("producedEvents" in result) || !result.producedEvents) {
      throw new Error("Expected producedEvents");
    }

    const produced = result.producedEvents[0] as {
      type: string;
      payload: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      priority?: number;
    };
    assertEquals(produced.type, "LLM_RESULT");
    assertEquals(produced.priority, EVENT_PRIORITIES.SETTLEMENT);
    assertEquals(produced.payload.status, "failed");
    assertEquals(produced.payload.finishReason, "error");
    assertEquals(
      (produced.payload.error as Record<string, unknown>).reason,
      "rate_limit",
    );
    assertEquals(produced.metadata?.targetId, "user-1");
    assertEquals(emitted.at(-1)?.type, "TOKEN");
    assertEquals(
      (emitted.at(-1)?.payload as Record<string, unknown>)?.isComplete,
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
