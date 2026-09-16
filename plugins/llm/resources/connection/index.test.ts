import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { ContentSequence } from "@copilotz/copilotz/content";
import type {
  LlmAdapter,
  LlmAdapterCallInput,
  LlmAdapterRequest,
  LlmAdapterResult,
  LlmCallInput,
  LlmCallOutput,
  LlmConnectionResource,
  LlmRequest,
} from "../../shared/contracts.ts";
import { createLlmAdapter } from "../../authoring/custom-adapter/index.ts";
import { defineLlmConnection, normalizeLlmModelSelections } from "./index.ts";

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

Deno.test("connections clone and freeze static auth and preserve dynamic resolver identity", () => {
  const headers = { "X-Account": "original" };
  const value = defineLlmConnection({
    provider: "openai",
    baseUrl: " https://example.test/v1 ",
    auth: { apiKey: " key ", extraHeaders: headers },
    runtimeDiagnostics: { enabled: true, credentialSource: "explicit" },
  });
  headers["X-Account"] = "changed";
  assertEquals(value, {
    provider: "openai",
    baseUrl: "https://example.test/v1",
    auth: { apiKey: "key", extraHeaders: { "X-Account": "original" } },
    runtimeDiagnostics: { enabled: true, credentialSource: "explicit" },
  });

  const resolve = () => ({ available: false as const });
  const dynamic = defineLlmConnection({
    provider: "openai",
    auth: { resolve },
  });
  assertStrictEquals(dynamic.auth?.resolve, resolve);
  assertEquals(defineLlmConnection({ adapter: "custom" }), {
    adapter: "custom",
  });
});

Deno.test("connections reject ambiguous auth, invalid fields, accessors, and non-data records", () => {
  for (
    const value of [
      undefined,
      {},
      { provider: "unknown", auth: { apiKey: "x" } },
      { adapter: "" },
      { adapter: "custom", provider: "openai" },
      { adapter: "custom", auth: { apiKey: "x" } },
      { provider: "openai" },
      { provider: "openai", auth: {} },
      { provider: "openai", auth: { apiKey: "" } },
      { provider: "openai", auth: { resolve: "not a function" } },
      { provider: "openai", auth: { resolve() {}, apiKey: "x" } },
      { provider: "openai", auth: { extraHeaders: [] } },
      { provider: "openai", auth: { apiKey: "x" }, model: "move to selection" },
      {
        provider: "openai",
        auth: { apiKey: "x" },
        runtimeDiagnostics: { enabled: "yes" },
      },
      Object.assign(Object.create({}), { adapter: "custom" }),
      Object.defineProperty({}, "adapter", {
        enumerable: true,
        get() {
          throw new Error("must not run");
        },
      }),
    ]
  ) {
    assertThrows(
      () => defineLlmConnection(value as LlmConnectionResource),
      TypeError,
    );
  }
});

Deno.test("selections share connections across models and options without mutable aliases", () => {
  const options = { reasoningEffort: "high", nested: { values: [1, "two"] } };
  const selections = normalizeLlmModelSelections([
    { connection: "service", model: "same-model", options },
    {
      connection: "service",
      model: "same-model",
      options: { reasoningEffort: "low" },
    },
  ]);
  options.nested.values.push(3);
  assertEquals(selections[0].options?.nested, { values: [1, "two"] });

  assertEquals(selections.length, 2);
  assertThrows(
    () =>
      normalizeLlmModelSelections([
        { connection: "a", model: "b", options: { x: 1, y: 2 } },
        { connection: "a", model: "b", options: { y: 2, x: 1 } },
      ]),
    TypeError,
    "duplicate selections",
  );
});

Deno.test("selections reject unsafe JSON and misplaced transport configuration", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = Array(2);
  sparse[1] = 1;
  const tagged = Object.assign([1], { tag: true });
  const getter = Object.defineProperty({}, "computed", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });
  const symbol = { [Symbol("secret")]: "not JSON" };
  const polluted = Object.defineProperty({}, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  for (
    const options of [
      [],
      { value: NaN },
      { value: undefined },
      new Date(),
      cycle,
      { sparse },
      { tagged },
      getter,
      symbol,
      polluted,
      Object.assign(Object.create({ inherited: true }), { value: 1 }),
      ...[
        "provider",
        "adapter",
        "baseUrl",
        "apiKey",
        "extraHeaders",
        "auth",
        "connection",
        "model",
      ].map((key) => ({ [key]: "forbidden" })),
    ]
  ) {
    assertThrows(
      () =>
        normalizeLlmModelSelections([{ connection: "a", model: "b", options }]),
      TypeError,
    );
  }
  for (
    const value of [[], ["old-alias"], [{ connection: "", model: "b" }], [{
      connection: "a",
      model: "",
    }], [{ connection: "a", model: "b", apiKey: "secret" }]]
  ) {
    assertThrows(() => normalizeLlmModelSelections(value), TypeError);
  }
});

Deno.test("durable call contracts contain only their exact public keys", () => {
  const input = {
    models: [{
      connection: "account",
      model: "gpt-5",
      options: { temperature: 0.1 },
    }, { connection: "account", model: "backup" }] as const,
    mode: "generate" as const,
    request,
    stream: { id: "output", metadata: { surface: "chat" } },
    inputStreamId: "live-input",
  } satisfies LlmCallInput;
  assertEquals(Object.keys(input), [
    "models",
    "mode",
    "request",
    "stream",
    "inputStreamId",
  ]);
  assertEquals("metadata" in input, false);

  const output = {
    connection: "account",
    model: "gpt-5",
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
      connection: "account",
      model: "gpt-5",
      adapter: "openai",
      providerModel: "gpt-5",
      status: "completed" as const,
    }],
    finishReason: "tool_calls",
  } satisfies LlmCallOutput;
  assertEquals(Object.keys(output), [
    "connection",
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
    models: [{ connection: "account", model: "gpt-5" }] as const,
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

  assertEquals(Object.keys(adapter), ["call"]);
  const signal = new AbortController().signal;
  const input = new ReadableStream<Uint8Array>();
  const invocation = adapter.call({
    model: "gpt-5",
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

Deno.test("connection branches are statically exclusive", () => {
  const mixed = { adapter: "custom", provider: "openai" } as const;
  const leaked = { adapter: "custom", auth: { apiKey: "secret" } } as const;
  // @ts-expect-error A custom connection cannot also select a built-in provider.
  const invalidProvider: LlmConnectionResource = mixed;
  // @ts-expect-error Custom connections cannot carry built-in credentials.
  const invalidAuth: LlmConnectionResource = leaked;
  assertEquals<object>(invalidProvider, mixed);
  assertEquals<object>(invalidAuth, leaked);
});
