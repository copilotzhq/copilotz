import { assertEquals, assertExists } from "@std/assert";
import { createDatabase } from "@/database/index.ts";
import type { Event, NewEvent, ProcessorDeps, Thread } from "@/types/index.ts";
import type { ProviderRegistry, ToolDefinition } from "@/runtime/llm/types.ts";
import { buildRoutingControlToolDefinitions } from "@/runtime/routing/index.ts";
import { process } from "./llm_attempt.created.ts";

const agents = [
  {
    id: "planner",
    name: "Planner",
    role: "assistant",
    allowedAgents: ["reviewer"],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "assistant",
  },
];

const routingTools = buildRoutingControlToolDefinitions({
  ask: [{ id: "reviewer", name: "Reviewer" }],
  handoff: [
    { id: "reviewer", name: "Reviewer" },
    { id: "user", name: "User" },
  ],
});

const searchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "search",
    description: "Search for information.",
    inputTypes: "type SearchInput = { query: string };",
  },
};

function registry(): ProviderRegistry {
  return {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: () => ({}),
      body: () => ({}),
      extractContent: (data: unknown) => {
        const delta = (data as {
          choices?: Array<{
            delta?: { content?: unknown; reasoning?: unknown };
          }>;
        })?.choices?.[0]?.delta;
        const parts = [
          ...(typeof delta?.reasoning === "string" &&
              delta.reasoning.length > 0
            ? [{ text: delta.reasoning, isReasoning: true }]
            : []),
          ...(typeof delta?.content === "string" && delta.content.length > 0
            ? [{ text: delta.content }]
            : []),
        ];
        return parts.length > 0 ? parts : null;
      },
      extractFinishReason: () => "tool_calls" as const,
    }),
  };
}

function sse(content: string): Response {
  return new Response(
    `data: ${
      JSON.stringify({
        choices: [{ delta: { content }, finish_reason: "tool_calls" }],
      })
    }\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function sseChunks(chunks: string[]): Response {
  return new Response(
    chunks.map((content) =>
      `data: ${
        JSON.stringify({
          choices: [{ delta: { content }, finish_reason: "tool_calls" }],
        })
      }\n\n`
    ).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function sseDeltas(
  deltas: Array<{ content?: string; reasoning?: string }>,
): Response {
  return new Response(
    deltas.map((delta) =>
      `data: ${
        JSON.stringify({
          choices: [{ delta, finish_reason: "stop" }],
        })
      }\n\n`
    ).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function toolBlock(
  name: string,
  args: Record<string, unknown>,
  id: string,
): string {
  return [
    "<tool_calls>",
    JSON.stringify({ name, arguments: args, tool_call_id: id }),
    "</tool_calls>",
  ].join("\n");
}

async function setup() {
  const db = await createDatabase({ url: ":memory:" });
  const thread = await db.ops.findOrCreateThread(undefined, {
    namespace: "routing-test",
    name: "Routing Test",
    participants: ["planner", "reviewer", "human-1"],
    status: "active",
    mode: "immediate",
  });
  const event = {
    id: crypto.randomUUID(),
    threadId: thread.id,
    type: "LLM_CALL",
    payload: {
      agent: { id: "planner", name: "Planner" },
      messages: [{ role: "user", content: "Coordinate this work." }],
      tools: [...routingTools, searchTool],
      config: {
        provider: "anthropic",
        model: "routing-test-model",
        apiKey: "test",
        estimateCost: false,
      },
    },
    parentEventId: null,
    traceId: crypto.randomUUID(),
    priority: 1000,
    metadata: {
      targetId: "planner",
      targetQueue: ["human-1"],
      sourceMessageId: crypto.randomUUID(),
    },
    ttlMs: null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "processing",
  } as unknown as Event;
  const deps = {
    db,
    thread: thread as Thread,
    context: {
      stream: false,
      agents,
      multiAgent: { enabled: true },
      llmProviders: registry(),
      usage: { enabled: false },
      namespace: "routing-test",
    },
    emitToStream: () => {},
  } as unknown as ProcessorDeps;
  return { event, deps };
}

function onlyResult(
  result: Awaited<ReturnType<typeof process>>,
): NewEvent {
  assertExists(result);
  const normalized = result as {
    producedEvents?: unknown[];
  };
  assertExists(normalized.producedEvents);
  assertEquals(normalized.producedEvents.length, 1);
  const produced = normalized.producedEvents[0] as NewEvent;
  assertEquals(produced.type, "LLM_RESULT");
  return produced;
}

Deno.test("llm_call materializes one routing control without tool artifacts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      sse(toolBlock("ask_in_thread", {
        target: "reviewer",
        message: "Please review the proposed design.",
      }, "route-1")),
    );

  try {
    const { event, deps } = await setup();
    const produced = onlyResult(await process(event, deps));
    const payload = produced.payload as Record<string, unknown>;

    assertEquals(payload.status, "completed");
    assertEquals(payload.finishReason, "tool_calls");
    assertEquals(payload.answer, "");
    assertEquals(payload.toolCalls, null);
    assertEquals(produced.metadata?.routing, {
      action: "ask",
      targetId: "reviewer",
      source: "model_control",
      message: "Please review the proposed design.",
      controlCallId: "route-1",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("llm_call privately corrects a mixed routing/tool response once", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(sse([
        toolBlock("ask_in_thread", {
          target: "reviewer",
          message: "Review this.",
        }, "route-invalid"),
        toolBlock("search", { query: "should not run" }, "tool-invalid"),
      ].join("\n")));
    }
    return Promise.resolve(
      sse(toolBlock("handoff_in_thread", {
        target: "reviewer",
        message: "Take over and finish the review.",
      }, "route-corrected")),
    );
  };

  try {
    const { event, deps } = await setup();
    const produced = onlyResult(await process(event, deps));
    const payload = produced.payload as Record<string, unknown>;

    assertEquals(calls, 2);
    assertEquals(payload.status, "completed");
    assertEquals(payload.answer, "");
    assertEquals(payload.toolCalls, null);
    assertEquals(produced.metadata?.routing, {
      action: "handoff",
      targetId: "reviewer",
      source: "model_control",
      message: "Take over and finish the review.",
      controlCallId: "route-corrected",
    });
    assertEquals(produced.metadata?.routingError, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("llm_call streams visible text while routing controls are exposed", async () => {
  const originalFetch = globalThis.fetch;
  let closeStream: (() => void) | undefined;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              `data: ${
                JSON.stringify({
                  choices: [{
                    delta: { content: "Visible immediately." },
                    finish_reason: null,
                  }],
                })
              }\n\n`,
            ));
            closeStream = () => controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

  try {
    const { event, deps } = await setup();
    const emitted: Event[] = [];
    deps.context.stream = true;
    deps.emitToStream = (streamEvent: Event) => emitted.push(streamEvent);

    let settled = false;
    const processing = Promise.resolve(process(event, deps)).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 20; i += 1) {
      if (
        emitted.some((streamEvent) =>
          streamEvent.type === "TOKEN" &&
          (streamEvent.payload as Record<string, unknown>).token ===
            "Visible immediately."
        )
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assertEquals(settled, false);
    assertEquals(
      emitted.some((streamEvent) =>
        streamEvent.type === "TOKEN" &&
        (streamEvent.payload as Record<string, unknown>).token ===
          "Visible immediately."
      ),
      true,
    );

    assertExists(closeStream);
    const finishStream = closeStream;
    closeStream = undefined;
    finishStream();
    const produced = onlyResult(await processing);
    assertEquals(
      (produced.payload as Record<string, unknown>).answer,
      "Visible immediately.",
    );
  } finally {
    closeStream?.();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("llm_call hides split routing markup while preserving visible text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(sseChunks([
      "Public framing. ",
      "<tool_",
      "calls>\n",
      JSON.stringify({
        name: "handoff_in_thread",
        arguments: {
          target: "reviewer",
          message: "Private implementation brief.",
        },
        tool_call_id: "route-split",
      }),
      "\n</tool_",
      "calls>",
    ]));

  try {
    const { event, deps } = await setup();
    const emitted: Event[] = [];
    deps.context.stream = true;
    deps.emitToStream = (streamEvent: Event) => emitted.push(streamEvent);

    const produced = onlyResult(await process(event, deps));
    const visibleTokens = emitted
      .filter((streamEvent) => streamEvent.type === "TOKEN")
      .map((streamEvent) => streamEvent.payload as Record<string, unknown>)
      .filter((payload) => payload.isReasoning !== true)
      .map((payload) => String(payload.token ?? ""))
      .join("");

    assertEquals(visibleTokens, "Public framing. ");
    assertEquals(visibleTokens.includes("tool_calls"), false);
    assertEquals(visibleTokens.includes("Private implementation brief"), false);
    assertEquals(
      (produced.payload as Record<string, unknown>).answer,
      "Public framing.",
    );
    assertEquals(produced.metadata?.routing, {
      action: "handoff",
      targetId: "reviewer",
      source: "model_control",
      message: "Private implementation brief.",
      controlCallId: "route-split",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("llm_call coalesces partial answer and reasoning persistence", async () => {
  const originalFetch = globalThis.fetch;
  const deltas = Array.from({ length: 50 }, (_, index) => ({
    reasoning: `r${index} `,
    content: `a${index} `,
  }));
  globalThis.fetch = () => Promise.resolve(sseDeltas(deltas));

  try {
    const { event, deps } = await setup();
    Object.assign(event, {
      type: "llm_attempt.created",
      subjectId: "attempt-partial",
    });
    deps.context.stream = true;

    let concurrentWrites = 0;
    let maxConcurrentWrites = 0;
    const snapshots: Array<Record<string, unknown>> = [];
    const llmAttemptMutations = deps.db.ops.mutate.llmAttempts as unknown as {
      update: (
        id: string,
        patch: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<unknown>;
      complete: (...args: unknown[]) => Promise<unknown>;
    };
    llmAttemptMutations.update = async (_id, patch, _options) => {
      if (patch.status !== "processing") return;
      concurrentWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, concurrentWrites);
      snapshots.push({ ...patch });
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrentWrites -= 1;
    };
    llmAttemptMutations.complete = () => Promise.resolve();

    await process(event, deps);

    assertEquals(maxConcurrentWrites, 1);
    assertEquals(snapshots.length, 2);
    assertEquals(
      snapshots.at(-1)?.partialAnswer,
      deltas.map((delta) => delta.content).join(""),
    );
    assertEquals(
      snapshots.at(-1)?.partialReasoning,
      deltas.map((delta) => delta.reasoning).join(""),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("llm_call emits a typed failure after one invalid correction", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(sse(toolBlock("ask_in_thread", {
      target: "outside-thread",
      message: "This must not route.",
    }, `route-invalid-${calls}`)));
  };

  try {
    const { event, deps } = await setup();
    const produced = onlyResult(await process(event, deps));
    const payload = produced.payload as Record<string, unknown>;
    const error = payload.error as Record<string, unknown>;

    assertEquals(calls, 2);
    assertEquals(payload.status, "failed");
    assertEquals(payload.finishReason, "error");
    assertEquals(payload.toolCalls, null);
    assertEquals(error.reason, "invalid_routing_control");
    assertEquals(error.retryable, false);
    assertEquals(produced.metadata?.routing, undefined);
    assertExists(produced.metadata?.routingError);
    assertEquals(
      (produced.metadata?.routingError as Record<string, unknown>)
        .correctionAttempted,
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
