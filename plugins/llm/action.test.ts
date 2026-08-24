import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import type {
  AssetRecord,
  ContentInput,
  ContentRef,
  DurableContentInput,
  PreparedContent,
  ResolvedContent,
} from "@copilotz/copilotz/content";
import type {
  ContentStreamOpenInput,
  ContentStreamWriter,
} from "@copilotz/copilotz/streams";
import {
  callLlmAction,
  LLM_CALL_ACTION_ALIAS,
  LLM_CALL_ACTION_ID,
  type LlmActionContext,
} from "./action.ts";
import {
  type LlmAdapter,
  LlmAdapterCallError,
  type LlmAdapterCallInput,
  type LlmAdapterFrame,
  type LlmAdapterResult,
  type LlmCallInput,
  type ModelResource,
} from "./contracts.ts";
import { llmPlugin } from "./plugin.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function ref(
  assetId: string,
  kind: ContentRef["kind"] = "text",
  mediaType = "text/plain",
): ContentRef {
  return Object.freeze({ assetId, kind, mediaType, role: "body" });
}

function emptyFrames(
  onCancel?: (reason: unknown) => void,
): ReadableStream<LlmAdapterFrame> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
    cancel: onCancel,
  });
}

function invocation(
  result: LlmAdapterResult | Promise<LlmAdapterResult>,
  frames = emptyFrames(),
) {
  return Object.freeze({ frames, result: Promise.resolve(result) });
}

async function within<T>(promise: Promise<T>, milliseconds = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Test operation did not settle promptly.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type OpenedStream = {
  input: ContentStreamOpenInput;
  appends: Uint8Array[];
  closed: boolean;
  aborted: boolean;
};

type FixtureOptions = Readonly<{
  models: Readonly<Record<string, ModelResource | undefined>>;
  adapters: Readonly<Record<string, LlmAdapter | undefined>>;
  resolved?: Readonly<Record<string, ResolvedContent>>;
  signal?: AbortSignal;
  onAppend?: () => void;
  failStreamMaterialization?: boolean;
}>;

function fixture(options: FixtureOptions) {
  const prepared: Array<{
    operationKey: string;
    input: ContentInput | readonly ContentInput[];
  }> = [];
  const materialized: DurableContentInput[] = [];
  const opened: OpenedStream[] = [];
  let inputFollowerCancelled = 0;
  let progressCalls = 0;

  const prepare = (
    input: ContentInput | readonly ContentInput[],
    prepareOptions: { operationKey: string },
  ): Promise<PreparedContent> => {
    prepared.push({ operationKey: prepareOptions.operationKey, input });
    const values = Array.isArray(input) ? input : [input];
    const content = values.map((value, index): ContentRef => {
      if (typeof value === "object" && value && "assetId" in value) {
        return value as ContentRef;
      }
      const type = typeof value === "string" ? "text" : value.type;
      const kind = type === "text" || type === "json" ? type : type;
      const mediaType = typeof value === "string"
        ? "text/plain"
        : "mediaType" in value && value.mediaType
        ? value.mediaType
        : type === "json"
        ? "application/json"
        : "text/plain";
      return ref(
        `prepared:${prepareOptions.operationKey}:${index}`,
        kind,
        mediaType,
      );
    });
    return Promise.resolve(Object.freeze({
      content: Object.freeze(content),
      assets: Object.freeze([]),
    }));
  };

  const context = {
    namespace: "tenant-a",
    operationKey: "operation-a",
    identity: Object.freeze({ correlationId: "correlation-a" }),
    resources: Object.freeze({ models: options.models }),
    adapters: Object.freeze({ llm: options.adapters }),
    actions: Object.freeze({}),
    collections: Object.freeze({}),
    content: Object.freeze({
      prepare,
      materialize(input: DurableContentInput) {
        materialized.push(input);
        const batch = input as PreparedContent;
        if (
          options.failStreamMaterialization && !Array.isArray(input) &&
          batch.content[0]?.assetId.startsWith("stream:")
        ) throw new Error("stream materialization failed");
        return Promise.resolve(Array.isArray(input) ? input : batch.content);
      },
      publish() {
        throw new Error("not configured");
      },
      get() {
        return Promise.resolve(null);
      },
      getMany() {
        return Promise.resolve([]);
      },
      resolve(value: ContentRef) {
        const resolved = options.resolved?.[value.assetId];
        if (!resolved) throw new Error(`Missing resolved '${value.assetId}'.`);
        return Promise.resolve(resolved);
      },
      resolveMany(values: readonly ContentRef[]) {
        return Promise.all(values.map((value) => {
          const resolved = options.resolved?.[value.assetId];
          if (!resolved) {
            throw new Error(`Missing resolved '${value.assetId}'.`);
          }
          return resolved;
        }));
      },
      open() {
        throw new Error("not configured");
      },
    }),
    streams: Object.freeze({
      open(input: ContentStreamOpenInput) {
        const record: OpenedStream = {
          input,
          appends: [],
          closed: false,
          aborted: false,
        };
        opened.push(record);
        const writer: ContentStreamWriter = Object.freeze({
          id: input.id!,
          offset: () =>
            record.appends.reduce(
              (total, bytes) => total + bytes.byteLength,
              0,
            ),
          append({ bytes }: { bytes: Uint8Array; appendId: string }) {
            record.appends.push(bytes.slice());
            options.onAppend?.();
            return Promise.resolve({
              startOffset: 0,
              endOffset: bytes.byteLength,
            });
          },
          close({ assetId }: { assetId: string }) {
            record.closed = true;
            return Promise.resolve(Object.freeze({
              content: Object.freeze([
                ref(assetId, input.kind ?? "text", input.mediaType),
              ]),
              assets: Object.freeze([]),
            }));
          },
          abort() {
            record.aborted = true;
            return Promise.resolve();
          },
          [Symbol.asyncDispose]() {
            record.aborted = true;
            return Promise.resolve();
          },
        });
        return Promise.resolve(writer);
      },
      follow() {
        return Promise.resolve(Object.freeze({
          bodyId: "followed-input",
          offset: 0,
          mediaType: "audio/pcm",
          body: new ReadableStream<Uint8Array>({
            cancel() {
              inputFollowerCancelled += 1;
            },
          }, { highWaterMark: 0 }),
        }));
      },
    }),
    signal: options.signal ?? new AbortController().signal,
    action: Object.freeze({
      id: LLM_CALL_ACTION_ID,
      runId: "run-a",
      metadata: Object.freeze({}),
    }),
    progress() {
      progressCalls += 1;
      return Promise.resolve();
    },
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    transaction() {
      throw new Error("not configured");
    },
  } as unknown as LlmActionContext;

  return {
    context,
    prepared,
    materialized,
    opened,
    inputFollowerCancelled: () => inputFollowerCancelled,
    progressCalls: () => progressCalls,
  };
}

const emptyInput = Object.freeze({
  model: "primary",
  request: Object.freeze({ messages: Object.freeze([]) }),
}) satisfies LlmCallInput;

function model(
  adapter: string,
  name: string,
  fallbacks?: readonly string[],
): ModelResource {
  return Object.freeze({
    adapter,
    model: name,
    ...(fallbacks ? { fallbacks: Object.freeze(fallbacks) } : {}),
  });
}

function resolved(
  contentRef: ContentRef,
  input: Readonly<{ bytes: Uint8Array; text?: string; value?: unknown }>,
): ResolvedContent {
  return Object.freeze({
    ref: contentRef,
    asset: Object.freeze({
      id: contentRef.assetId,
      namespace: "tenant-a",
      mediaType: contentRef.mediaType,
      byteLength: input.bytes.byteLength,
      digest: "sha256:test",
      state: "ready",
      location: { kind: "memory", key: contentRef.assetId },
      createdAt: "2026-08-23T00:00:00.000Z",
    }) as AssetRecord,
    bytes: input.bytes,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
  });
}

Deno.test("llmPlugin installs only the callLlm Action", () => {
  assertEquals(LLM_CALL_ACTION_ALIAS, "callLlm");
  assertEquals(callLlmAction.id, "llm.call");
  assertStrictEquals(llmPlugin.actions.callLlm, callLlmAction);
  assertEquals(llmPlugin.collections, {});
  assertEquals(llmPlugin.processors, {});
  assertEquals(llmPlugin.resources, {});
  assertEquals(llmPlugin.adapters, {});
});

Deno.test("llm.call rejects invalid durable input before Adapter use", async () => {
  let calls = 0;
  const adapter: LlmAdapter = {
    call() {
      calls += 1;
      return invocation({
        content: "unused",
        attempts: [{ status: "completed" }],
      });
    },
  };
  const test = fixture({
    models: { primary: model("provider", "model-a") },
    adapters: { provider: adapter },
  });

  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        unexpected: true,
      } as LlmCallInput, test.context),
    TypeError,
    "unexpected",
  );
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        model: "primary",
        request: { messages: [{ role: "operator", content: [] }] },
      } as unknown as LlmCallInput, test.context),
    TypeError,
    "role",
  );
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        model: "primary",
        request: { messages: [{ role: "user", content: ["inline"] }] },
      } as unknown as LlmCallInput, test.context),
    TypeError,
    "ContentRefs",
  );
  assertEquals(calls, 0);
});

Deno.test("llm.call validates the complete fallback graph before calling", async () => {
  let calls = 0;
  const adapter: LlmAdapter = {
    call() {
      calls += 1;
      return invocation({
        content: "unused",
        attempts: [{ status: "completed" }],
      });
    },
  };
  const missing = fixture({
    models: {
      primary: model("provider", "model-a", ["missing"]),
    },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, missing.context),
    Error,
    "Unknown LLM Model 'missing'",
  );

  const cycle = fixture({
    models: {
      primary: model("provider", "model-a", ["backup"]),
      backup: model("provider", "model-b", ["primary"]),
    },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, cycle.context),
    Error,
    "primary -> backup -> primary",
  );
  assertEquals(calls, 0);
});

Deno.test("llm.call flattens fallback priority and owns deterministic attempts", async () => {
  const calls: string[] = [];
  const adapter: LlmAdapter = {
    call(input) {
      calls.push(input.model);
      if (input.model !== "last") {
        return invocation(Promise.reject(new Error(`failed ${input.model}`)));
      }
      return invocation({
        content: "done",
        attempts: [{
          status: "completed",
          usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
          startedAt: "2026-08-23T00:00:01.000Z",
          finishedAt: "2026-08-23T00:00:02.000Z",
        }],
        finishReason: "stop",
      });
    },
  };
  const test = fixture({
    models: {
      primary: model("provider", "first", ["backup", "last"]),
      backup: model("provider", "second", ["nested"]),
      nested: model("provider", "third"),
      last: model("provider", "last"),
    },
    adapters: { provider: adapter },
  });

  const output = await callLlmAction.execute(emptyInput, test.context);
  assertEquals(calls, ["primary", "backup", "nested", "last"]);
  assertEquals(output.model, "last");
  assertEquals(output.adapter, "provider");
  assertEquals(output.providerModel, "last");
  assertEquals(output.finishReason, "stop");
  assertEquals(
    output.attempts?.map((attempt) => ({
      id: attempt.id,
      index: attempt.index,
      status: attempt.status,
    })),
    [
      { id: "run-a:attempt:0", index: 0, status: "failed" },
      { id: "run-a:attempt:1", index: 1, status: "failed" },
      { id: "run-a:attempt:2", index: 2, status: "failed" },
      { id: "run-a:attempt:3", index: 3, status: "completed" },
    ],
  );
  assertEquals(output.attempts?.[3].startedAt, "2026-08-23T00:00:01.000Z");
  assertEquals(output.content[0].assetId, "prepared:attempt:3:content:0");
});

Deno.test("llm.call propagates Model fallback availability and aggregates every provider attempt", async () => {
  const availability: boolean[] = [];
  const primary: LlmAdapter = {
    call(input) {
      availability.push(input.fallbackAvailable);
      return invocation(Promise.reject(
        new LlmAdapterCallError(
          "sanitized primary failure",
          {
            attempts: [{
              status: "failed",
              usage: {
                inputTokens: 2,
                outputTokens: 1,
                reasoningTokens: 1,
                totalTokens: 3,
                cost: { amount: 2, currency: "USD" },
              },
              error: { code: "empty_response", message: "Empty response." },
            }, {
              status: "failed",
              usage: {
                inputTokens: 3,
                outputTokens: 0,
                totalTokens: 3,
                cost: { amount: 3, currency: "USD" },
              },
              error: { code: "empty_response", message: "Empty response." },
            }],
          },
        ),
      ));
    },
  };
  const backup: LlmAdapter = {
    call(input) {
      availability.push(input.fallbackAvailable);
      return invocation({
        content: "backup answer",
        attempts: [{
          status: "failed",
          usage: {
            inputTokens: 4,
            outputTokens: 1,
            cachedInputTokens: 2,
            totalTokens: 5,
            cost: { amount: 4, currency: "USD" },
          },
          error: { code: "network", message: "Network failure." },
        }, {
          status: "completed",
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            reasoningTokens: 2,
            totalTokens: 7,
            cost: { amount: 5, currency: "USD" },
          },
          finishReason: "stop",
        }],
        finishReason: "stop",
      });
    },
  };
  const test = fixture({
    models: {
      primary: model("primary", "model-a", ["backup"]),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
  });

  const output = await callLlmAction.execute(emptyInput, test.context);
  assertEquals(availability, [true, false]);
  assertEquals(output.model, "backup");
  assertEquals(output.usage, {
    inputTokens: 14,
    outputTokens: 4,
    reasoningTokens: 3,
    cachedInputTokens: 2,
    totalTokens: 18,
    cost: { amount: 14, currency: "USD" },
  });
  assertEquals(
    output.attempts?.map((attempt) => ({
      index: attempt.index,
      adapter: attempt.adapter,
      providerModel: attempt.providerModel,
      status: attempt.status,
    })),
    [
      {
        index: 0,
        adapter: "primary",
        providerModel: "model-a",
        status: "failed",
      },
      {
        index: 1,
        adapter: "primary",
        providerModel: "model-a",
        status: "failed",
      },
      {
        index: 2,
        adapter: "backup",
        providerModel: "model-b",
        status: "failed",
      },
      {
        index: 3,
        adapter: "backup",
        providerModel: "model-b",
        status: "completed",
      },
    ],
  );
});

Deno.test("llm.call omits mixed-currency aggregate cost and preserves attempt costs", async () => {
  const primary: LlmAdapter = {
    call() {
      return invocation(Promise.reject(
        new LlmAdapterCallError("failed", {
          attempts: [{
            status: "failed",
            usage: {
              inputTokens: 1,
              cost: { amount: 1, currency: "USD" },
            },
            error: { message: "Failed." },
          }],
        }),
      ));
    },
  };
  const backup: LlmAdapter = {
    call() {
      return invocation({
        content: "answer",
        attempts: [{
          status: "completed",
          usage: {
            inputTokens: 2,
            cost: { amount: 2, currency: "EUR" },
          },
        }],
      });
    },
  };
  const test = fixture({
    models: {
      primary: model("primary", "model-a", ["backup"]),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
  });

  const output = await callLlmAction.execute(emptyInput, test.context);
  assertEquals(output.usage, { inputTokens: 3, totalTokens: 3 });
  assertEquals(
    output.attempts?.map((attempt) => attempt.usage?.cost),
    [
      { amount: 1, currency: "USD" },
      { amount: 2, currency: "EUR" },
    ],
  );
});

Deno.test("llm.call resolves request content and overlays call options", async () => {
  const textRef = ref("text-a");
  const jsonRef = ref("json-a", "json", "application/json");
  const imageRef = Object.freeze({
    ...ref("image-a", "image", "image/png"),
    name: "plot.png",
    alt: "A plot",
  });
  let seen: LlmAdapterCallInput | undefined;
  const adapter: LlmAdapter = {
    call(input) {
      seen = input;
      return invocation({
        content: { type: "text", text: "answer" },
        reasoning: { type: "text", text: "thought", role: "reasoning" },
        toolCalls: [{ id: "call-a", action: "search", input: { q: "x" } }],
        attempts: [{
          status: "completed",
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            totalTokens: 6,
            cost: { amount: 0.01, currency: "USD" },
          },
        }],
      });
    },
  };
  const test = fixture({
    models: {
      primary: {
        adapter: "provider",
        model: "provider-model",
        mode: "session",
        options: { temperature: 0.8, topP: 0.9 },
      },
    },
    adapters: { provider: adapter },
    resolved: {
      "text-a": resolved(textRef, {
        bytes: encoder.encode("hello"),
        text: "hello",
      }),
      "json-a": resolved(jsonRef, {
        bytes: encoder.encode('{"a":1}'),
        value: { a: 1 },
      }),
      "image-a": resolved(imageRef, {
        bytes: new Uint8Array([1, 2, 3]),
      }),
    },
  });
  const output = await callLlmAction.execute({
    model: "primary",
    request: {
      instructions: "",
      messages: [{
        role: "user",
        content: [textRef, jsonRef, imageRef],
        metadata: { source: "message" },
      }],
    },
    inputStreamId: "live-input",
    options: { temperature: 0.2, maxTokens: 100 },
  }, test.context);

  assertEquals(seen?.mode, "session");
  assertEquals(seen?.options, {
    maxTokens: 100,
    temperature: 0.2,
    topP: 0.9,
  });
  assertEquals(seen?.request.instructions, "");
  assertEquals(seen?.request.messages[0].content[0], {
    type: "text",
    text: "hello",
    role: "body",
    mediaType: "text/plain",
  });
  assertEquals(seen?.request.messages[0].content[1], {
    type: "json",
    value: { a: 1 },
    role: "body",
    mediaType: "application/json",
  });
  assertEquals(seen?.request.messages[0].content[2], {
    type: "image",
    bytes: new Uint8Array([1, 2, 3]),
    role: "body",
    mediaType: "image/png",
    name: "plot.png",
    alt: "A plot",
  });
  assert(seen?.input instanceof ReadableStream);
  assertEquals(test.inputFollowerCancelled(), 1);
  assertEquals(output.toolCalls, [
    { id: "call-a", action: "search", input: { q: "x" } },
  ]);
  assertEquals(output.content[0].assetId, "prepared:attempt:0:content:0");
  assertEquals(
    output.reasoning?.[0].assetId,
    "prepared:attempt:0:reasoning:0",
  );
  assertEquals(output.usage?.cost, { amount: 0.01, currency: "USD" });
  assertEquals(test.prepared.map((item) => item.operationKey), [
    "attempt:0:content",
    "attempt:0:reasoning",
  ]);
});

Deno.test("llm.call publishes frames only through Streams and materializes them", async () => {
  const frames = new ReadableStream<LlmAdapterFrame>({
    start(controller) {
      controller.enqueue({
        lane: "content",
        mediaType: "text/plain",
        bytes: encoder.encode("hel"),
      });
      controller.enqueue({
        lane: "content",
        mediaType: "text/plain",
        bytes: encoder.encode("lo"),
      });
      controller.enqueue({
        lane: "reasoning",
        mediaType: "text/plain",
        bytes: encoder.encode("why"),
      });
      controller.close();
    },
  });
  const adapter: LlmAdapter = {
    call() {
      return invocation({
        content: "normalized answer",
        attempts: [{ status: "completed" }],
      }, frames);
    },
  };
  const test = fixture({
    models: { primary: model("provider", "model-a") },
    adapters: { provider: adapter },
  });
  const output = await callLlmAction.execute({
    ...emptyInput,
    stream: { id: "visible", metadata: { surface: "chat" } },
  }, test.context);

  assertEquals(test.opened.length, 2);
  assertEquals(test.opened.map((stream) => stream.input.id), [
    "visible:content:text_2Fplain",
    "visible:reasoning:text_2Fplain",
  ]);
  assertEquals(test.opened.map((stream) => stream.input.metadata), [
    { surface: "chat", lane: "content", model: "primary", adapter: "provider" },
    {
      surface: "chat",
      lane: "reasoning",
      model: "primary",
      adapter: "provider",
    },
  ]);
  assertEquals(
    decoder.decode(
      new Uint8Array(test.opened[0].appends.flatMap((item) => [
        ...item,
      ])),
    ),
    "hello",
  );
  assert(test.opened.every((stream) => stream.closed && !stream.aborted));
  assertEquals(test.materialized.length, 3);
  assertEquals(test.progressCalls(), 0);
  assertEquals(output.content[0].assetId, "prepared:attempt:0:content:0");
  assert(!output.content[0].assetId.startsWith("stream:"));
});

Deno.test("llm.call never falls back after publishing visible output", async () => {
  let appended!: () => void;
  const didAppend = new Promise<void>((resolve) => {
    appended = resolve;
  });
  let backupCalls = 0;
  const primary: LlmAdapter = {
    call() {
      return invocation(
        didAppend.then(() => {
          throw new Error("primary failed after output");
        }),
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              lane: "content",
              mediaType: "text/plain",
              bytes: encoder.encode("visible"),
            });
          },
        }),
      );
    },
  };
  const backup: LlmAdapter = {
    call() {
      backupCalls += 1;
      return invocation({
        content: "backup",
        attempts: [{ status: "completed" }],
      });
    },
  };
  const test = fixture({
    models: {
      primary: model("primary", "model-a", ["backup"]),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
    onAppend: appended,
  });

  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        stream: { id: "visible" },
      }, test.context),
    Error,
    "primary failed after output",
  );
  assertEquals(backupCalls, 0);
  assertEquals(test.opened.length, 1);
  assert(test.opened[0].aborted);
});

Deno.test("llm.call aborts and settles both invocation branches before fallback", async () => {
  let primaryResultSettled = false;
  let frameCancelled = false;
  let backupObservedSettled = false;
  const primary: LlmAdapter = {
    call(input) {
      const result = new Promise<LlmAdapterResult>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => {
          primaryResultSettled = true;
          reject(new Error("primary stopped"));
        }, { once: true });
      });
      const frames = new ReadableStream<LlmAdapterFrame>({
        start(controller) {
          controller.enqueue({
            lane: "content",
            mediaType: "text/plain",
            bytes: new Uint8Array(),
            extra: true,
          } as LlmAdapterFrame);
        },
        cancel() {
          frameCancelled = true;
        },
      });
      return invocation(result, frames);
    },
  };
  const backup: LlmAdapter = {
    call() {
      backupObservedSettled = primaryResultSettled && frameCancelled;
      return invocation({
        content: "backup",
        attempts: [{ status: "completed" }],
      });
    },
  };
  const test = fixture({
    models: {
      primary: model("primary", "model-a", ["backup"]),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
  });

  const output = await callLlmAction.execute(emptyInput, test.context);
  assert(backupObservedSettled);
  assertEquals(output.model, "backup");
  assertEquals(output.attempts?.map((item) => item.status), [
    "failed",
    "completed",
  ]);
});

Deno.test("llm.call falls back without awaiting non-cooperative frame cancellation", async () => {
  let cancellationRequested = false;
  const primary: LlmAdapter = {
    call() {
      return invocation(
        Promise.reject(new Error("primary result failed")),
        new ReadableStream<LlmAdapterFrame>({
          pull() {
            return new Promise<void>(() => {});
          },
          cancel() {
            cancellationRequested = true;
            return new Promise<void>(() => {});
          },
        }),
      );
    },
  };
  const backup: LlmAdapter = {
    call() {
      return invocation({
        content: "backup",
        attempts: [{ status: "completed" }],
      });
    },
  };
  const test = fixture({
    models: {
      primary: model("primary", "model-a", ["backup"]),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
  });

  const output = await within(
    Promise.resolve(callLlmAction.execute(emptyInput, test.context)),
  );
  assertEquals(output.model, "backup");
  assert(cancellationRequested);
});

Deno.test("llm.call cancellation does not await non-cooperative result or frames", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancellationRequested = false;
  const adapter: LlmAdapter = {
    call() {
      started();
      return invocation(
        new Promise<LlmAdapterResult>(() => {}),
        new ReadableStream<LlmAdapterFrame>({
          pull() {
            return new Promise<void>(() => {});
          },
          cancel() {
            cancellationRequested = true;
            return new Promise<void>(() => {});
          },
        }),
      );
    },
  };
  const test = fixture({
    models: { primary: model("provider", "model-a") },
    adapters: { provider: adapter },
    signal: controller.signal,
  });
  const executing = Promise.resolve(
    callLlmAction.execute(emptyInput, test.context),
  );
  await didStart;
  controller.abort(new DOMException("caller cancelled", "AbortError"));

  await within(assertRejects(
    async () => await executing,
    DOMException,
    "caller cancelled",
  ));
  assert(cancellationRequested);
});

Deno.test("llm.call observes result rejection before acquiring a locked frame reader", async () => {
  const frames = emptyFrames();
  const lock = frames.getReader();
  const adapter: LlmAdapter = {
    call() {
      return {
        frames,
        result: Promise.reject(new Error("observed result rejection")),
      };
    },
  };
  const test = fixture({
    models: { primary: model("provider", "model-a") },
    adapters: { provider: adapter },
  });

  try {
    await assertRejects(
      async () => await callLlmAction.execute(emptyInput, test.context),
      TypeError,
      "locked",
    );
    await Promise.resolve();
  } finally {
    lock.releaseLock();
  }
});

Deno.test("llm.call rejects untrusted Adapter data before persistence", async () => {
  const invalid: LlmAdapter = {
    call() {
      return invocation({
        content: "invalid",
        attempts: [{
          status: "completed",
          usage: { inputTokens: Number.POSITIVE_INFINITY },
        }],
      } as unknown as LlmAdapterResult);
    },
  };
  const backup: LlmAdapter = {
    call() {
      return invocation({
        content: "safe",
        toolCalls: [{ id: "call", action: "search", input: { q: "x" } }],
        attempts: [{ status: "completed" }],
      });
    },
  };
  const test = fixture({
    models: {
      primary: model("invalid", "model-a", ["backup"]),
      backup: model("backup", "model-b"),
    },
    adapters: { invalid, backup },
  });

  const output = await callLlmAction.execute(emptyInput, test.context);
  assertEquals(output.model, "backup");
  assertEquals(output.attempts?.[0].status, "failed");

  const badTool: LlmAdapter = {
    call() {
      return invocation({
        content: "answer",
        toolCalls: [{ id: "", action: "search", input: [] }],
        attempts: [{ status: "completed" }],
      } as unknown as LlmAdapterResult);
    },
  };
  const rejected = fixture({
    models: { primary: model("bad", "model") },
    adapters: { bad: badTool },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, rejected.context),
    TypeError,
    "id",
  );
  assertEquals(rejected.prepared.length, 0);

  const duplicateToolCalls: LlmAdapter = {
    call() {
      return invocation({
        content: "answer",
        toolCalls: [{ id: "same", action: "search", input: {} }, {
          id: "same",
          action: "lookup",
          input: {},
        }],
        attempts: [{ status: "completed" }],
      });
    },
  };
  const duplicate = fixture({
    models: { primary: model("duplicate", "model") },
    adapters: { duplicate: duplicateToolCalls },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, duplicate.context),
    TypeError,
    "duplicate id 'same'",
  );

  const blankAction: LlmAdapter = {
    call() {
      return invocation({
        content: "answer",
        toolCalls: [{ id: "call", action: " ", input: {} }],
        attempts: [{ status: "completed" }],
      });
    },
  };
  const blank = fixture({
    models: { primary: model("blank", "model") },
    adapters: { blank: blankAction },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, blank.context),
    TypeError,
    ".action",
  );
});

Deno.test("llm.call observes a rejecting result on an invalid invocation", async () => {
  const adapter: LlmAdapter = {
    call() {
      return {
        frames: "not-a-stream",
        result: Promise.reject(new Error("orphan rejection")),
      } as unknown as ReturnType<LlmAdapter["call"]>;
    },
  };
  const test = fixture({
    models: { primary: model("invalid", "model") },
    adapters: { invalid: adapter },
  });

  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, test.context),
    TypeError,
    "invalid invocation",
  );
  // Give the rejected result its host microtask checkpoint; Deno fails this
  // test if the invocation validator left it unobserved.
  await Promise.resolve();
});

Deno.test("llm.call does not fall back on abort", async () => {
  let backupCalls = 0;
  const primary: LlmAdapter = {
    call() {
      return invocation(Promise.reject(
        new DOMException("cancelled", "AbortError"),
      ));
    },
  };
  const backup: LlmAdapter = {
    call() {
      backupCalls += 1;
      return invocation({
        content: "backup",
        attempts: [{ status: "completed" }],
      });
    },
  };
  const test = fixture({
    models: {
      primary: model("primary", "model-a", ["backup"]),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, test.context),
    DOMException,
    "cancelled",
  );
  assertEquals(backupCalls, 0);
});

Deno.test("llm.call settles every opened writer when stream materialization fails", async () => {
  let backupCalls = 0;
  const primary: LlmAdapter = {
    call() {
      return invocation(
        { content: "answer", attempts: [{ status: "completed" }] },
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              lane: "content",
              mediaType: "text/plain",
              bytes: encoder.encode("answer"),
            });
            controller.enqueue({
              lane: "reasoning",
              mediaType: "text/plain",
              bytes: encoder.encode("reason"),
            });
            controller.close();
          },
        }),
      );
    },
  };
  const backup: LlmAdapter = {
    call() {
      backupCalls += 1;
      return invocation({
        content: "backup",
        attempts: [{ status: "completed" }],
      });
    },
  };
  const test = fixture({
    models: {
      primary: model("primary", "model-a", ["backup"]),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
    failStreamMaterialization: true,
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        stream: { id: "visible" },
      }, test.context),
    Error,
    "stream materialization failed",
  );
  assertEquals(backupCalls, 0);
  assertEquals(test.opened.length, 2);
  assert(test.opened[0].closed);
  assert(test.opened[1].aborted);
});
