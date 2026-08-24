import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { ContentSequence } from "@copilotz/copilotz/content";
import {
  createLlmAdapter,
  defineLlmCredential,
  defineModel,
  type LlmAdapter,
  type LlmAdapterCallInput,
  type LlmAdapterRequest,
  type LlmAdapterResult,
  type LlmCallInput,
  type LlmCallOutput,
  type LlmCredentialResolution,
  type LlmCredentialResource,
  type LlmRequest,
  type ModelResource,
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

Deno.test("defineModel returns the exact normalized built-in structural shape", () => {
  const options = {
    temperature: 0.2,
    nested: { z: true, a: ["one", 2] },
  } as const;
  const extraHeaders = { "X-Account": "primary" };
  const model = defineModel({
    provider: "openai",
    model: " gpt-5 ",
    apiKey: " secret ",
    baseUrl: " https://provider.example/v1 ",
    extraHeaders,
    options,
    runtimeDiagnostics: { enabled: true, credentialSource: "explicit" },
  });

  assertEquals(Object.keys(model), [
    "provider",
    "model",
    "apiKey",
    "baseUrl",
    "extraHeaders",
    "options",
    "runtimeDiagnostics",
  ]);
  assertEquals(model, {
    provider: "openai",
    model: "gpt-5",
    apiKey: "secret",
    baseUrl: "https://provider.example/v1",
    extraHeaders: { "X-Account": "primary" },
    options: {
      nested: { a: ["one", 2], z: true },
      temperature: 0.2,
    },
    runtimeDiagnostics: { enabled: true, credentialSource: "explicit" },
  });
  assert(Object.isFrozen(model));
  assert(Object.isFrozen(model.options));
  assert(Object.isFrozen(model.options?.nested));
  assert("provider" in model);
  assert(Object.isFrozen(model.extraHeaders));
  assert(Object.isFrozen(model.runtimeDiagnostics));

  extraHeaders["X-Account"] = "changed";
  assertEquals(model.extraHeaders, { "X-Account": "primary" });
  assertStrictEquals(model.options === options, false);
});

Deno.test("defineModel accepts the minimal plain declaration", () => {
  const model = defineModel({ adapter: "anthropic", model: "claude" });
  assertEquals(model, { adapter: "anthropic", model: "claude" });
  assertEquals(Object.keys(model), ["adapter", "model"]);
});

Deno.test("defineLlmCredential freezes static and dynamic process-local resources", () => {
  const headers = { "X-Account": "account-1" };
  const staticCredential = defineLlmCredential({
    provider: "openai",
    apiKey: " service-key ",
    extraHeaders: headers,
  });
  assertEquals(staticCredential, {
    provider: "openai",
    apiKey: "service-key",
    extraHeaders: { "X-Account": "account-1" },
  });
  assert(Object.isFrozen(staticCredential));
  assert(Object.isFrozen(staticCredential.extraHeaders));
  headers["X-Account"] = "changed";
  assertEquals(staticCredential.extraHeaders, { "X-Account": "account-1" });

  const resolve = () => ({ available: false as const });
  const dynamicCredential = defineLlmCredential({
    provider: "openai",
    resolve,
  });
  assert(Object.isFrozen(dynamicCredential));
  assertStrictEquals(dynamicCredential.resolve, resolve);
});

Deno.test("credential and Model declarations reject ambiguous or invalid shapes", () => {
  const invalidCredential = (value: unknown) =>
    assertThrows(
      () => defineLlmCredential(value as LlmCredentialResource),
      TypeError,
    );
  invalidCredential({ provider: "openai" });
  invalidCredential({ provider: "openai", resolve: "not-a-function" });
  invalidCredential({ provider: "openai", apiKey: "x", resolve() {} });
  invalidCredential({ provider: "openai", extraHeaders: [] });

  assertThrows(
    () =>
      defineModel({
        provider: "openai",
        model: "gpt-5",
        credentials: "account",
        apiKey: "secret",
      }),
    TypeError,
    "cannot be combined",
  );

  const emptyAvailable = {
    available: true,
    // @ts-expect-error Available credentials require a key or headers.
  } satisfies LlmCredentialResolution;
  assertEquals(emptyAvailable.available, true);
});

Deno.test("ModelResource branches are statically exclusive", () => {
  const mixedBuiltin = {
    provider: "openai",
    adapter: "custom",
    model: "gpt-5",
    // @ts-expect-error A built-in Model cannot also select a custom Adapter.
  } satisfies ModelResource;
  const mixedCustom = {
    adapter: "custom",
    model: "provider-model",
    apiKey: "secret",
    // @ts-expect-error A custom Model cannot carry built-in credentials.
  } satisfies ModelResource;
  assertEquals(mixedBuiltin.adapter, "custom");
  assertEquals(mixedCustom.apiKey, "secret");
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
  invalid({ provider: "unknown", model: "gpt-5" });
  invalid({ provider: "openai", adapter: "custom", model: "gpt-5" });
  invalid({ provider: "openai", model: "gpt-5", apiKey: "" });
  invalid({ provider: "openai", model: "gpt-5", extraHeaders: [] });
  invalid({
    provider: "openai",
    model: "gpt-5",
    runtimeDiagnostics: { enabled: "yes" },
  });
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

  let accessorReads = 0;
  const accessor = Object.defineProperty({}, "temperature", {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error("must never execute");
    },
  });
  invalid({ adapter: "openai", model: "gpt-5", options: accessor });
  invalid({
    provider: "openai",
    model: "gpt-5",
    extraHeaders: accessor,
  });
  invalid({
    provider: "openai",
    model: "gpt-5",
    runtimeDiagnostics: accessor,
  });
  assertEquals(accessorReads, 0);

  const nonEnumerable = Object.defineProperty({}, "temperature", {
    enumerable: false,
    value: 0.2,
  });
  invalid({ adapter: "openai", model: "gpt-5", options: nonEnumerable });
  invalid({
    provider: "openai",
    model: "gpt-5",
    extraHeaders: nonEnumerable,
  });
  invalid({
    provider: "openai",
    model: "gpt-5",
    runtimeDiagnostics: nonEnumerable,
  });

  const symbol = { temperature: 0.2 } as Record<PropertyKey, unknown>;
  symbol[Symbol("tag")] = true;
  invalid({ adapter: "openai", model: "gpt-5", options: symbol });
  invalid({ provider: "openai", model: "gpt-5", extraHeaders: symbol });
  invalid({
    provider: "openai",
    model: "gpt-5",
    runtimeDiagnostics: symbol,
  });

  const inherited = Object.assign(Object.create({ inherited: true }), {
    temperature: 0.2,
  });
  invalid({ adapter: "openai", model: "gpt-5", options: inherited });
  invalid({ provider: "openai", model: "gpt-5", extraHeaders: inherited });
  invalid({
    provider: "openai",
    model: "gpt-5",
    runtimeDiagnostics: inherited,
  });

  const sparse = Array(2);
  sparse[1] = 1;
  invalid({ adapter: "openai", model: "gpt-5", options: { sparse } });
  const tagged = [1] as unknown[] & { tag?: boolean };
  tagged.tag = true;
  invalid({ adapter: "openai", model: "gpt-5", options: { tagged } });

  const polluted = {} as Record<string, unknown>;
  Object.defineProperty(polluted, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  invalid({ adapter: "openai", model: "gpt-5", options: polluted });
  invalid({ provider: "openai", model: "gpt-5", extraHeaders: polluted });
  invalid({
    provider: "openai",
    model: "gpt-5",
    runtimeDiagnostics: polluted,
  });
});

Deno.test("durable call contracts contain only their exact public keys", () => {
  const input = {
    models: ["default", "backup"] as const,
    mode: "generate" as const,
    request,
    stream: { id: "output", metadata: { surface: "chat" } },
    inputStreamId: "live-input",
    options: { temperature: 0.1 },
  } satisfies LlmCallInput;
  assertEquals(Object.keys(input), [
    "models",
    "mode",
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
      providerRequest: true,
      model: "default",
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
    models: ["default"] as const,
    mode: "generate" as const,
    request,
    // @ts-expect-error Action-call metadata belongs in ActionCallOptions.
    metadata: { threadId: "thread-1" },
  } satisfies LlmCallInput;
  assertEquals(invalidInput.metadata, { threadId: "thread-1" });
});

Deno.test("createLlmAdapter freezes the exact custom call boundary", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  let seen: LlmAdapterCallInput | undefined;
  const result: LlmAdapterResult = {
    content: { type: "text", text: "done" },
    attempts: [{ status: "completed" }],
    finishReason: "stop",
  };
  const adapter: LlmAdapter = createLlmAdapter({
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
  });
  assert(Object.isFrozen(adapter));
  assertEquals(Object.keys(adapter), ["call"]);
  const signal = new AbortController().signal;
  const input = new ReadableStream<Uint8Array>();
  const invocation = adapter.call({
    model: "default",
    adapter: "openai",
    providerModel: "gpt-5",
    mode: "session",
    fallbackAvailable: false,
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
