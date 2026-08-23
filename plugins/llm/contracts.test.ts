import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { ContentSequence } from "@copilotz/copilotz/content";
import {
  defineModel,
  type LlmAdapter,
  type LlmAdapterCallInput,
  type LlmAdapterRequest,
  type LlmAdapterResult,
  type LlmCallInput,
  type LlmCallOutput,
  type LlmRequest,
} from "./contracts.ts";

const content = Object.freeze([Object.freeze({
  assetId: "asset-1",
  kind: "text" as const,
  role: "body",
  mediaType: "text/plain",
})]) satisfies ContentSequence;

const request = Object.freeze({
  instructions: "Answer precisely.",
  messages: Object.freeze([Object.freeze({
    role: "user" as const,
    content,
    metadata: Object.freeze({ source: "message" }),
  })]),
  tools: Object.freeze([Object.freeze({
    name: "search",
    description: "Search indexed documents.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        query: Object.freeze({ type: "string" }),
      }),
    }),
  })]),
}) satisfies LlmRequest;

Deno.test("defineModel returns the exact normalized structural shape", () => {
  const options = {
    temperature: 0.2,
    nested: { z: true, a: ["one", 2] },
  } as const;
  const fallbacks = [" backup "];
  const model = defineModel({
    adapter: " openai ",
    model: " gpt-5 ",
    mode: "generate",
    options,
    fallbacks,
  });

  assertEquals(Object.keys(model), [
    "adapter",
    "model",
    "mode",
    "options",
    "fallbacks",
  ]);
  assertEquals(model, {
    adapter: "openai",
    model: "gpt-5",
    mode: "generate",
    options: {
      nested: { a: ["one", 2], z: true },
      temperature: 0.2,
    },
    fallbacks: ["backup"],
  });
  assert(Object.isFrozen(model));
  assert(Object.isFrozen(model.options));
  assert(Object.isFrozen(model.options?.nested));
  assert(Object.isFrozen(model.fallbacks));

  fallbacks[0] = "changed";
  assertEquals(model.fallbacks, ["backup"]);
  assertStrictEquals(model.options === options, false);
});

Deno.test("defineModel accepts the minimal plain declaration", () => {
  const model = defineModel({ adapter: "anthropic", model: "claude" });
  assertEquals(model, { adapter: "anthropic", model: "claude" });
  assertEquals(Object.keys(model), ["adapter", "model"]);
});

Deno.test("defineModel rejects missing and invalid structural values", () => {
  const invalid = (value: unknown) =>
    assertThrows(
      () => defineModel(value as Parameters<typeof defineModel>[0]),
      TypeError,
    );

  invalid(undefined);
  invalid({ model: "gpt-5" });
  invalid({ adapter: " ", model: "gpt-5" });
  invalid({ adapter: "openai", model: "" });
  invalid({ adapter: "openai", model: "gpt-5", mode: "batch" });
  invalid({ adapter: "openai", model: "gpt-5", fallbacks: "backup" });
  invalid({ adapter: "openai", model: "gpt-5", fallbacks: [""] });
  invalid({ adapter: "openai", model: "gpt-5", options: [] });
  invalid({ adapter: "openai", model: "gpt-5", options: { value: NaN } });
  invalid({ adapter: "openai", model: "gpt-5", options: { value: undefined } });
  invalid({ adapter: "openai", model: "gpt-5", options: new Date() });
  invalid({ adapter: "openai", model: "gpt-5", apiKey: "secret" });
  invalid(Object.assign(Object.create({}), {
    adapter: "openai",
    model: "gpt-5",
  }));

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  invalid({ adapter: "openai", model: "gpt-5", options: cycle });
});

Deno.test("durable call contracts contain only their exact public keys", () => {
  const input = {
    model: "default",
    request,
    stream: { id: "output", metadata: { surface: "chat" } },
    inputStreamId: "live-input",
    options: { temperature: 0.1 },
  } satisfies LlmCallInput;
  assertEquals(Object.keys(input), [
    "model",
    "request",
    "stream",
    "inputStreamId",
    "options",
  ]);
  assertEquals("metadata" in input, false);

  const output = {
    model: "default",
    adapter: "openai",
    providerModel: "gpt-5",
    content,
    reasoning: content,
    toolCalls: [{ id: "call-1", action: "search", input: { query: "x" } }],
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    attempts: [{
      id: "attempt-1",
      index: 0,
      adapter: "openai",
      providerModel: "gpt-5",
      status: "completed" as const,
    }],
    finishReason: "tool_calls",
  } satisfies LlmCallOutput;
  assertEquals(Object.keys(output), [
    "model",
    "adapter",
    "providerModel",
    "content",
    "reasoning",
    "toolCalls",
    "usage",
    "attempts",
    "finishReason",
  ]);
});

Deno.test("LlmCallInput does not admit Action metadata", () => {
  const invalidInput = {
    model: "default",
    request,
    // @ts-expect-error Action-call metadata belongs in ActionCallOptions.
    metadata: { threadId: "thread-1" },
  } satisfies LlmCallInput;
  assertEquals(invalidInput.metadata, { threadId: "thread-1" });
});

Deno.test("adapter request is resolved and may carry runtime bytes and streams", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  let seen: LlmAdapterCallInput | undefined;
  const result: LlmAdapterResult = {
    content: { type: "text", text: "done" },
    finishReason: "stop",
  };
  const adapter: LlmAdapter = {
    call(input) {
      seen = input;
      return {
        frames: new ReadableStream({
          start(controller) {
            controller.enqueue({
              lane: "content",
              mediaType: "audio/pcm",
              bytes,
            });
            controller.close();
          },
        }),
        result: Promise.resolve(result),
      };
    },
  };
  const signal = new AbortController().signal;
  const input = new ReadableStream<Uint8Array>();
  const invocation = adapter.call({
    model: "default",
    adapter: "openai",
    providerModel: "gpt-5",
    mode: "session",
    options: {},
    request: {
      instructions: request.instructions,
      tools: request.tools,
      messages: [{
        role: "user",
        content: [{
          type: "audio",
          bytes,
          mediaType: "audio/pcm",
        }],
      }],
    },
    signal,
    input,
  });

  assertStrictEquals(seen?.signal, signal);
  assertStrictEquals(seen?.input, input);
  const frame = await invocation.frames.getReader().read();
  assertStrictEquals(frame.value?.bytes, bytes);
  assertStrictEquals(await invocation.result, result);
});

Deno.test("adapter messages reject unresolved durable content refs", () => {
  const unresolved = {
    messages: [{
      role: "user" as const,
      content: [
        // @ts-expect-error llm.call must resolve ContentRefs before Adapter use.
        content[0],
      ],
    }],
  } satisfies LlmAdapterRequest;
  assertStrictEquals(unresolved.messages[0].content[0], content[0]);
});
