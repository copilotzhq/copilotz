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

Deno.test("llm_call processor reports transcript construction failures as local and non-retryable", async () => {
  const circularOutput: Record<string, unknown> = {};
  circularOutput.self = circularOutput;

  const result = await process(
    {
      id: "evt-invalid-transcript",
      threadId: "thread-1",
      type: "LLM_CALL",
      payload: {
        agent: { id: "researcher", name: "Researcher" },
        messages: [{
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "legacy-result",
            tool: { id: "search" },
            args: "{}",
            output: circularOutput,
            status: "completed",
          }],
        }],
        tools: [],
        config: {
          provider: "anthropic",
          model: "claude-test",
          apiKey: "test",
        },
      },
      parentEventId: null,
      traceId: "trace-invalid-transcript",
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
    payload: Record<string, unknown>;
  };
  const error = produced.payload.error as Record<string, unknown>;
  assertEquals(produced.payload.status, "failed");
  assertEquals(
    produced.payload.answer,
    "The conversation history could not be prepared for the model.",
  );
  assertEquals(error.reason, "invalid_transcript");
  assertEquals(error.retryable, false);
  assertEquals(error.fallbackAttempted, false);
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

Deno.test("llm_call processor drains superseded LLM streams for usage and debug", async () => {
  const db = await createDatabase({ url: ":memory:" });
  const thread = await db.ops.findOrCreateThread(undefined, {
    namespace: "tenant-test",
    name: "Superseded Drain Thread",
    participants: ["researcher"],
    status: "active",
    mode: "immediate",
  });
  const originalFetch = globalThis.fetch;
  const emitted: Event[] = [];
  const cancellationController = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const encoder = new TextEncoder();
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
      extractUsage: (data: any) =>
        data?.usage
          ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
            rawUsage: data.usage,
          }
          : null,
    }),
  };

  globalThis.fetch = (_url, init?: RequestInit) => {
    providerSignal = init?.signal ?? undefined;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${
                  JSON.stringify({
                    choices: [{ delta: { content: "first " } }],
                  })
                }\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${
                  JSON.stringify({
                    choices: [{
                      delta: { content: "second" },
                      finish_reason: "stop",
                    }],
                    usage: {
                      prompt_tokens: 10,
                      completion_tokens: 2,
                      total_tokens: 12,
                    },
                  })
                }\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };

  try {
    const result = await process(
      {
        id: "evt-superseded-drain",
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
          },
        },
        parentEventId: null,
        traceId: "trace-superseded-drain",
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
          stream: true,
          llmProviders: registry,
        },
        emitToStream: (event: Event) => {
          emitted.push(event);
          if (
            event.type === "TOKEN" &&
            (event.payload as Record<string, unknown>).token === "first "
          ) {
            cancellationController.abort("newer_interrupting_event");
          }
        },
        cancellation: {
          signal: cancellationController.signal,
          isAborted: () => cancellationController.signal.aborted,
          reason: () =>
            cancellationController.signal.aborted
              ? "newer_interrupting_event"
              : undefined,
          onCancel: (cb: () => void) => {
            cancellationController.signal.addEventListener("abort", cb, {
              once: true,
            });
            return () =>
              cancellationController.signal.removeEventListener("abort", cb);
          },
        },
      } as unknown as ProcessorDeps,
    );

    assertExists(result);
    if (!("producedEvents" in result)) {
      throw new Error("Expected producedEvents");
    }
    assertEquals(result.producedEvents, []);
    assertEquals(providerSignal?.aborted, false);

    const emittedTokens = emitted
      .filter((event) => event.type === "TOKEN")
      .map((event) => event.payload as Record<string, unknown>);
    assertEquals(emittedTokens.map((payload) => payload.token), ["first "]);

    let attempt: Record<string, any> | undefined;
    for (let i = 0; i < 20; i += 1) {
      const attempts = await db.query<{
        data: Record<string, any>;
      }>(
        `SELECT "data"
         FROM "nodes"
         WHERE "source_type" = 'llm_attempt'
           AND "type" = 'llm_attempt'
           AND "data"->>'threadId' = $1
         ORDER BY "created_at" ASC`,
        [thread.id as string],
      );
      attempt = attempts.rows[0]?.data;
      if (attempt?.status === "superseded") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assertExists(attempt);
    assertEquals(attempt.status, "superseded");
    assertEquals(attempt.partialAnswer, "first second");
    assertEquals(attempt.usage.status, "completed");
    assertEquals(attempt.usage.totalTokens, 12);
    assertEquals(attempt.debug.rawOutput.content, "first second");
    assertEquals(attempt.debug.parsedOutput.answer, "first second");
    assertEquals(attempt.metadata.superseded, true);
    assertEquals(
      attempt.metadata.cancellationReason,
      "newer_interrupting_event",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
