import { assert, assertEquals } from "@std/assert";
import {
  formatLlmRequestForWire,
  prepareLlmCall,
} from "@copilotz/copilotz/llm";
import { estimateTextTokens } from "@copilotz/copilotz/llm/tokens";
import {
  buildMemoryConsolidationInstruction,
  memorySourceManifestEntry,
  selectLongTermMemoryRange,
} from "../authoring/consolidation/index.ts";
import {
  historyBoundaryAdvances,
  sourceMessagesFromTranscript,
} from "./source.ts";

Deno.test("native state triggers consolidation and bounds a whole-turn source without database reads", async () => {
  const model = {
    connection: "openai",
    model: "gpt-6-luna",
    options: { maxTokens: 30_000, limitEstimatedInputTokens: 180_000 },
  };
  const connections = {
    openai: {
      provider: "openai" as const,
      auth: { apiKey: "unused-test-key" },
    },
  };
  const context = {
    namespace: "tenant",
    resources: { llmConnections: connections },
  };
  const prepared = Array.from({ length: 8 }, (_, index) => ({
    sourceId: `source:${index}`,
    message: {
      role: "assistant" as const,
      name: "East",
      content: [{
        assetId: `visible:${index}`,
        kind: "text" as const,
        role: "body",
        mediaType: "text/plain",
        value: "Short visible answer.",
      }],
      nativeReasoning: {
        schema: "copilotz.llm-native-reasoning.v1" as const,
        adapter: "openai",
        api: "openai.responses",
        model: model.model,
        blocks: [{
          assetId: `reasoning:${index}`,
          kind: "json" as const,
          role: "reasoning",
          mediaType: "application/json",
          value: { type: "reasoning", encrypted_content: "x".repeat(45_000) },
        }],
      },
    },
  }));
  const sources = sourceMessagesFromTranscript(context as never, {
    messages: [],
    model,
  }, prepared);
  assert(
    sources.reduce((sum, source) => sum + source.estimatedTokens!, 0) >=
      120_000,
  );
  assert(sources.every((source) => source.text === "Short visible answer."));
  const spaces = [{
    id: "own",
    name: "Own",
    scopeType: "thread",
    access: "read_write" as const,
    defaultWrite: true,
  }];
  const prefix = {
    instructions: "Ordinary Agent prompt prefix.",
    tools: [{
      name: "weather",
      description: "Get the weather.",
      inputSchema: { type: "object" },
    }],
  };
  const head = await prepareLlmCall(
    { mode: "generate", models: [model], request: { ...prefix, messages: [] } },
    connections,
    "tenant",
  );
  const capacity = 180_000 - head.candidates[0].estimatedInputTokens - 30_000;
  const instruction = buildMemoryConsolidationInstruction({
    spaces,
    sourceMessages: [],
    context: [],
  });
  const selected = selectLongTermMemoryRange({
    messages: sources,
    triggerMessageId: sources.at(-1)!.id,
    triggerEstimatedTokens: 120_000,
    maxSourceEstimatedTokens: capacity - estimateTextTokens(instruction),
    sourceMessageOverhead: (source) =>
      estimateTextTokens(
        JSON.stringify(memorySourceManifestEntry(source)) + ",",
      ),
  });
  assert(selected);
  assert(selected.messages.length < prepared.length);
  assertEquals(selected.sourceStartMessageId, sources[0].id);
  const messages = prepared.slice(0, selected.messages.length).map((entry) =>
    entry.message
  );
  const maintenance = {
    role: "user" as const,
    metadata: { preserveWireBoundary: true },
    content: [{
      assetId: "task",
      kind: "text" as const,
      role: "memory.task",
      mediaType: "text/plain",
      value: buildMemoryConsolidationInstruction({
        spaces,
        sourceMessages: selected.messages,
        context: [],
      }),
    }],
  };
  const bounded = await prepareLlmCall(
    {
      mode: "generate",
      models: [model],
      request: { ...prefix, messages: [...messages, maintenance] },
    },
    connections,
    "tenant",
  );
  assertEquals(bounded.candidates[0].status, "fit");
  assert(bounded.candidates[0].estimatedInputTokens + 30_000 <= 180_000);
  assertEquals(
    messages.map((message) => message.nativeReasoning),
    prepared.slice(0, selected.messages.length).map((entry) =>
      entry.message.nativeReasoning
    ),
  );
});

Deno.test("memory progress follows chronological message order rather than opaque IDs", async () => {
  let reads = 0;
  const context = {
    collections: {
      message: {
        get: ({ id }: { id: string }) => {
          reads++;
          return Promise.resolve({
            id,
            threadId: "thread",
            createdAt: id === "a-later"
              ? "2026-10-02T00:00:00Z"
              : "2026-10-01T00:00:00Z",
          });
        },
      },
    },
  };
  assertEquals(
    await historyBoundaryAdvances(context as never, "thread", "same", "same"),
    false,
  );
  assertEquals(reads, 0);
  assertEquals(
    await historyBoundaryAdvances(
      context as never,
      "thread",
      "a-later",
      "z-earlier",
    ),
    true,
  );
  assertEquals(
    await historyBoundaryAdvances(
      context as never,
      "thread",
      "z-earlier",
      "a-later",
    ),
    false,
  );
});

Deno.test("memory source estimation preserves the tenant-scoped attachment notice", () => {
  const namespace = "tenant:a";
  const model = { connection: "test", model: "gpt-6.1-sol" };
  const message = {
    role: "user" as const,
    content: [{
      kind: "file" as const,
      assetId: "voice-note",
      role: "attachment",
      name: "voice.webm",
      mediaType: "audio/webm",
      disposition: "attachment" as const,
      resolve: false as const,
    }],
  };
  const expected = formatLlmRequestForWire({ messages: [message] }, {
    provider: "openai",
    model: model.model,
  }, namespace);
  const [source] = sourceMessagesFromTranscript(
    {
      namespace,
      resources: { llmConnections: { test: { provider: "openai" } } },
    } as never,
    { messages: [], model },
    [{ sourceId: "human", message }],
  );

  assertEquals(source.id, "human");
  assertEquals(source.text.includes("asset://tenant%3Aa/voice-note"), true);
  assertEquals(source.estimatedTokens, expected.estimate.estimatedTokens);
  assertEquals(source.sourceBytes, 0);
});
