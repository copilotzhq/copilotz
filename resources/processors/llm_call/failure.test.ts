import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { process } from "./index.ts";
import { createDatabase } from "@/database/index.ts";
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

Deno.test("llm_call processor persists one llm_usage node per provider attempt", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const thread = await db.ops.findOrCreateThread(undefined, {
    namespace: "tenant-test",
    name: "Usage Attempts Thread",
    participants: ["researcher"],
    status: "active",
    mode: "immediate",
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const registry: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: () => ({}),
      body: () => ({}),
      extractContent: (data: any) => {
        const content = data?.choices?.[0]?.delta?.content;
        return typeof content === "string" && content.length > 0
          ? [{ text: content }]
          : null;
      },
      extractFinishReason: (data: any) =>
        data?.choices?.[0]?.finish_reason ?? null,
    }),
  };

  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        new Response("server failed", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );
    }
    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };

  try {
    const result = await process(
      {
        id: "evt-usage-attempts",
        threadId: thread.id,
        type: "LLM_CALL",
        payload: {
          agent: { id: "researcher", name: "Researcher" },
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          config: {
            provider: "anthropic",
            model: "primary",
            apiKey: "test",
            estimateCost: false,
            fallbacks: [{ provider: "anthropic", model: "fallback" }],
          },
        },
        parentEventId: null,
        traceId: "trace-usage",
        priority: 1000,
        metadata: { targetId: "user-1" },
        ttlMs: null,
        expiresAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "processing",
      } as never,
      {
        db,
        context: {
          stream: false,
          llmProviders: registry,
        },
      } as unknown as ProcessorDeps,
    );

    assertExists(result);
    if (!("producedEvents" in result) || !result.producedEvents) {
      throw new Error("Expected producedEvents");
    }

    const produced = result.producedEvents[0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    assertEquals(produced.type, "LLM_RESULT");
    assertEquals(produced.payload.status, "completed");
    assertEquals(produced.payload.usageNodeId !== undefined, true);
    assertEquals(calls, 2);

    const usageRows = await db.query<{
      id: string;
      data: Record<string, unknown>;
    }>(
      `SELECT "id", "data"
       FROM "nodes"
       WHERE "source_type" = 'thread'
         AND "source_id" = $1
         AND "type" = 'usage'
       ORDER BY "created_at" ASC`,
      [thread.id as string],
    );

    assertEquals(usageRows.rows.length, 2);
    assertEquals(usageRows.rows[0].data.status, "aborted");
    assertEquals(usageRows.rows[0].data.statusReason, "server_error");
    assertEquals(usageRows.rows[0].data.model, "primary");
    assertEquals(usageRows.rows[1].data.status, "completed");
    assertEquals(usageRows.rows[1].data.statusReason, null);
    assertEquals(usageRows.rows[1].data.model, "fallback");
    assertEquals(produced.payload.usageNodeId, usageRows.rows[1].id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
