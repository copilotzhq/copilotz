import { createHash } from "node:crypto";
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
  GeneratedContentSequence,
  PendingContentRef,
  PreparedContent,
  ResolvedContent,
} from "@copilotz/copilotz/content";
import {
  type ActionEventData,
  createActionCallers,
  createActionLifecycleEmitter,
} from "@copilotz/copilotz/actions";
import {
  createContentResolver,
  createMemoryAssetRepository,
  isPendingContentRef,
} from "@copilotz/copilotz/content";
import type {
  ContentStreamAbortInput,
  ContentStreamOpenInput,
  ContentStreamRetentionInput,
  ContentStreamWriter,
} from "@copilotz/copilotz/streams";
import {
  callLlmAction,
  LLM_CALL_ACTION_ALIAS,
  LLM_CALL_ACTION_ID,
  type LlmActionContext,
  prepareLlmCall,
} from "./index.ts";
import {
  type LlmAdapter,
  LlmAdapterCallError,
  type LlmAdapterCallInput,
  type LlmAdapterFrame,
  type LlmAdapterResult,
  type LlmAuthResolution,
  type LlmCallInput,
  type LlmConnectionContext,
  type LlmConnectionExecution,
} from "../../shared/contracts.ts";
import { llmPlugin } from "../../plugin.ts";

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

function memoryEffects(): import("../../../../runtime/actions/effect-client.ts").ActionEffectClient {
  const states = new Map<
    string,
    import("@copilotz/copilotz/actions").ActionEffectState
  >();
  return {
    inspect: (step) =>
      Promise.resolve(structuredClone(states.get(step) ?? { status: "none" })),
    begin(step) {
      const prior = states.get(step);
      if (prior) {
        return Promise.resolve(
          structuredClone(prior) as Exclude<typeof prior, { status: "none" }>,
        );
      }
      states.set(step, { status: "indeterminate" });
      return Promise.resolve({ status: "proceed" });
    },
    confirm(step, outcome) {
      states.set(step, { status: "replay", outcome: structuredClone(outcome) });
      return Promise.resolve();
    },
    notStarted() {
      throw new Error("not configured");
    },
    inventory: () =>
      Promise.resolve(
        [...states].map(([step, value]) => ({
          step,
          status: value.status === "replay" ? "confirmed" : "begun",
        })),
      ),
  };
}

type OpenedStream = {
  input: ContentStreamOpenInput;
  appends: Uint8Array[];
  closed: boolean;
  aborted: boolean;
  abortInput?: ContentStreamAbortInput;
  retentions: ContentStreamRetentionInput[];
  disposeCalls: number;
  disposed: boolean;
};

type FixtureOptions = Readonly<{
  llmConnections: Readonly<
    Record<string, Readonly<Record<string, unknown>> | undefined>
  >;
  actionMetadata?: Readonly<Record<string, unknown>>;
  adapters?: Readonly<Record<string, LlmAdapter | undefined>>;
  resolved?: Readonly<Record<string, ResolvedContent>>;
  signal?: AbortSignal;
  onAppend?: () => void;
  failStreamRetention?: boolean;
  onClose?: (stream: OpenedStream) => void | Promise<void>;
  onAbort?: (stream: OpenedStream) => void | Promise<void>;
  onDispose?: (stream: OpenedStream) => void | Promise<void>;
  onCapture?: () => void | Promise<void>;
}>;

function fixtureDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pending(
  pendingRef: string,
  mediaType: string,
  bytes: Uint8Array,
): PendingContentRef {
  return Object.freeze({
    type: "content.pending",
    pendingRef,
    mediaType,
    byteLength: bytes.byteLength,
    digest: fixtureDigest(bytes),
  });
}

function pendingId(
  value: GeneratedContentSequence[number] | undefined,
): string {
  assert(
    value && "pendingRef" in value,
    "Fresh generated output must remain pending until domain adoption.",
  );
  return value.pendingRef;
}

function fixtureBytes(value: ContentInput): Uint8Array | undefined {
  if (typeof value === "string") return encoder.encode(value);
  if ("assetId" in value) return undefined;
  if (value.type === "text") return encoder.encode(value.text);
  if (value.type === "json") {
    const encoded = JSON.stringify(value.value);
    return encoded === undefined ? undefined : encoder.encode(encoded);
  }
  return value.bytes.slice();
}

function fixture(options: FixtureOptions) {
  const prepared: Array<{
    operationKey: string;
    input: ContentInput | readonly ContentInput[];
  }> = [];
  const captured: PreparedContent[] = [];
  const materialized: DurableContentInput[] = [];
  const opened: OpenedStream[] = [];
  const resolvedRequests: ContentRef[][] = [];
  let inputFollowerCancelled = 0;
  let progressCalls = 0;
  const progressValues: unknown[] = [];

  const prepare = (
    input: ContentInput | readonly ContentInput[],
    prepareOptions: { operationKey: string },
  ): Promise<PreparedContent> => {
    prepared.push({ operationKey: prepareOptions.operationKey, input });
    const values = Array.isArray(input) ? input : [input];
    const assets: PreparedContent["assets"][number][] = [];
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
      const assetId = `prepared:${prepareOptions.operationKey}:${index}`;
      {
        const bytes = fixtureBytes(value);
        if (bytes) {
          assets.push(Object.freeze({
            id: assetId,
            namespace: "tenant-a",
            mediaType,
            body: bytes,
            byteLength: bytes.byteLength,
            digest: fixtureDigest(bytes),
            idempotencyKey: `${prepareOptions.operationKey}:${index}`,
          }));
        }
      }
      return ref(
        assetId,
        kind,
        mediaType,
      );
    });
    return Promise.resolve(Object.freeze({
      content: Object.freeze(content),
      assets: Object.freeze(assets),
    }));
  };

  const effects = memoryEffects();
  const context = {
    effect: effects,
    namespace: "tenant-a",
    operationKey: "operation-a",
    identity: Object.freeze({ correlationId: "correlation-a" }),
    resources: Object.freeze({
      llmConnections: options.llmConnections,
    }),
    adapters: options.adapters
      ? Object.freeze({ llm: options.adapters })
      : Object.freeze({}),
    actions: Object.freeze({}),
    collections: Object.freeze({}),
    content: Object.freeze({
      prepare,
      openCapture(
        input: ContentStreamOpenInput & { operationKey: string },
      ): Promise<ContentStreamWriter> {
        return context.streams.open(input);
      },
      async capture(
        input: ContentInput | readonly ContentInput[] | PreparedContent,
        captureOptions: { operationKey: string },
      ): Promise<GeneratedContentSequence> {
        const batch =
          typeof input === "object" && input !== null && "content" in input &&
            "assets" in input
            ? input as PreparedContent
            : await prepare(
              input as ContentInput | readonly ContentInput[],
              captureOptions,
            );
        captured.push(batch);
        await options.onCapture?.();
        return batch.content.map((value, index) => {
          const asset = batch.assets.find((asset) =>
            asset.id === value.assetId
          );
          return asset
            ? pending(
              `capture:${captureOptions.operationKey}:${index}`,
              asset.mediaType,
              asset.body,
            )
            : value;
        });
      },
      materialize(input: DurableContentInput) {
        materialized.push(input);
        const batch = input as PreparedContent;
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
        resolvedRequests.push([...values]);
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
          retentions: [],
          disposeCalls: 0,
          disposed: false,
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
          async close() {
            await options.onClose?.(record);
            record.closed = true;
            const bytes = new Uint8Array(
              record.appends.flatMap((item) => [...item]),
            );
            return Promise.resolve(
              pending(
                `pending:stream-body:${input.id}`,
                input.mediaType,
                bytes,
              ),
            );
          },
          abort(input?: ContentStreamAbortInput) {
            if (record.closed) return Promise.resolve();
            return Promise.resolve(options.onAbort?.(record)).then(() => {
              record.aborted = true;
              record.abortInput = input;
            });
          },
          retain(input: ContentStreamRetentionInput) {
            if (options.failStreamRetention) {
              throw new Error("stream retention failed");
            }
            record.retentions.push(Object.freeze({ ...input }));
            return Promise.resolve();
          },
          async [Symbol.asyncDispose]() {
            record.disposeCalls++;
            await options.onDispose?.(record);
            record.disposed = true;
            if (!record.closed) record.aborted = true;
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
      metadata: Object.freeze({ ...(options.actionMetadata ?? {}) }),
    }),
    progress(value: unknown) {
      progressCalls += 1;
      progressValues.push(structuredClone(value));
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
    captured,
    opened,
    resolvedRequests: () => resolvedRequests.map((values) => [...values]),
    inputFollowerCancelled: () => inputFollowerCancelled,
    progressCalls: () => progressCalls,
    progressValues: () => structuredClone(progressValues),
  };
}

const baseInput = Object.freeze({
  models: Object.freeze([{ connection: "primary", model: "primary" }] as const),
  mode: "generate" as const,
  request: Object.freeze({ messages: Object.freeze([]) }),
}) satisfies LlmCallInput;

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
      bodyId: `logical:${contentRef.assetId}`,
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

Deno.test("llm.call runs a built-in Model without adapters and never returns its profile secrets", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{
      connection: "primary",
      model: "provider-model",
      options: { estimateCost: false, openaiApi: "chat_completions" },
    }] as const,
  };

  const originalFetch = globalThis.fetch;
  let authorization: string | null = null;
  let requestedUrl = "";
  globalThis.fetch = (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization");
    return Promise.resolve(
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };

  const test = fixture({
    llmConnections: {
      "primary": {
        provider: "openai",
        baseUrl: "https://account.example/v1",
        auth: {
          apiKey: "built-in-secret",
          extraHeaders: { "X-Account": "primary" },
        },
      },
    },
  });
  try {
    const output = await callLlmAction.execute(emptyInput, test.context);
    assertEquals(requestedUrl, "https://account.example/v1/chat/completions");
    assertEquals(authorization, "Bearer built-in-secret");
    assertEquals(output.model, "provider-model");
    assertEquals(output.adapter, "openai");
    assertEquals(output.attempts?.[0]?.connection, "primary");
    assertEquals(output.attempts?.[0]?.provider, "openai");
    assertEquals(output.attempts?.[0]?.model, "provider-model");
    assertEquals(
      JSON.stringify({ input: emptyInput, output }).includes("built-in-secret"),
      false,
    );
    assertEquals(
      JSON.stringify(output).includes("https://account.example/v1"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("llm.call rejects a changed prepared transcript or limit before provider I/O", async () => {
  const connection = {
    provider: "openai",
    baseUrl: "https://account.example/v1",
    auth: { apiKey: "built-in-secret" },
  } as const;
  const input = {
    ...baseInput,
    models: [{
      connection: "primary",
      model: "gpt-4o-mini",
      options: {
        estimateCost: false,
        limitEstimatedInputTokens: 10_000,
        openaiApi: "chat_completions",
      },
    }] as const,
    request: {
      messages: [{
        role: "user",
        content: [{
          assetId: "prepared:original-prompt",
          kind: "text",
          mediaType: "text/plain",
          role: "body",
          value: "Original prepared prompt",
        }],
      }],
    },
  } as unknown as LlmCallInput;
  const preparation = await prepareLlmCall(
    input,
    { primary: connection },
    "tenant-a",
  );
  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = () => {
    providerRequests += 1;
    throw new Error("A stale preparation must fail before provider I/O.");
  };
  const test = fixture({ llmConnections: { primary: connection } });
  try {
    await assertRejects(
      async () =>
        await callLlmAction.execute({
          ...input,
          preparation,
          request: {
            messages: [{
              role: "user",
              content: [{
                assetId: "prepared:original-prompt",
                kind: "text",
                mediaType: "text/plain",
                role: "body",
                value: "Changed prepared prompt",
              }],
            }],
          },
        }, test.context),
      TypeError,
      "preparation no longer matches",
    );
    await assertRejects(
      async () =>
        await callLlmAction.execute({
          ...input,
          preparation,
          models: [{
            ...input.models[0],
            options: {
              ...input.models[0].options,
              limitEstimatedInputTokens: 1,
            },
          }],
        }, test.context),
      TypeError,
      "preparation no longer matches",
    );
    assertEquals(providerRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("direct llm.call without trusted application metadata omits ChatGPT session identity", async () => {
  const originalFetch = globalThis.fetch;
  let headers = new Headers();
  globalThis.fetch = (_input, init) => {
    headers = new Headers(init?.headers);
    return Promise.resolve(
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };
  const test = fixture({
    llmConnections: {
      primary: {
        provider: "openai",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        auth: {
          apiKey: "test",
          extraHeaders: { "ChatGPT-Account-ID": "account" },
        },
      },
    },
  });
  try {
    await callLlmAction.execute({
      ...baseInput,
      models: [{
        connection: "primary",
        model: "public-model",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      }],
    }, test.context);
    assertEquals(headers.get("session-id"), null);
    assertEquals(headers.get("thread-id"), null);
    assertEquals(headers.get("x-client-request-id"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("llm.call accepts only a valid trusted application session for ChatGPT routing", async () => {
  const originalFetch = globalThis.fetch;
  const observed: Headers[] = [];
  globalThis.fetch = (_input, init) => {
    observed.push(new Headers(init?.headers));
    return Promise.resolve(
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };
  const connection = {
    provider: "openai",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    auth: {
      apiKey: "test",
      extraHeaders: { "ChatGPT-Account-ID": "account" },
    },
  } as const;
  const input = {
    ...baseInput,
    models: [{
      connection: "primary",
      model: "selected-model",
      options: { estimateCost: false, openaiApi: "chat_completions" },
    }] as const,
  } satisfies LlmCallInput;
  try {
    const valid = fixture({
      llmConnections: { primary: connection },
      actionMetadata: {
        llmSession: {
          schema: "copilotz.llm-session.v1",
          threadId: "thread-a",
          agentId: "agent-a",
        },
      },
    });
    await callLlmAction.execute(input, valid.context);
    assert(typeof observed[0]?.get("session-id") === "string");
    assertEquals(observed[0]?.get("thread-id"), observed[0]?.get("session-id"));
    assertEquals(
      observed[0]?.get("x-client-request-id"),
      observed[0]?.get("session-id"),
    );

    const malformed = fixture({
      llmConnections: { primary: connection },
      actionMetadata: {
        llmSession: {
          schema: "copilotz.llm-session.v1",
          threadId: "",
          agentId: "agent-a",
        },
      },
    });
    await callLlmAction.execute(input, malformed.context);
    assertEquals(observed[1]?.get("session-id"), null);

    const forged = fixture({ llmConnections: { primary: connection } });
    await assertRejects(
      async () =>
        await callLlmAction.execute({
          ...input,
          models: [{
            ...input.models[0],
            options: {
              ...input.models[0]!.options,
              executionIdentity: { cacheKey: "forged" },
            },
          }],
        }, forged.context),
      TypeError,
      "Unsupported durable LLM provider option 'executionIdentity'",
    );
    assertEquals(observed.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("resolved credentials never enter durable Action lifecycle data", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{
      connection: "connected",
      model: "provider-model",
      options: { estimateCost: false, openaiApi: "chat_completions" },
    }] as const,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    assertEquals(
      new Headers(init?.headers).get("authorization"),
      "Bearer ephemeral-resolver-secret",
    );
    assertEquals(
      new Headers(init?.headers).get("x-connected-account"),
      "account-secret",
    );
    return Promise.resolve(
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"safe"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };
  const test = fixture({
    llmConnections: {
      "connected": {
        provider: "openai",
        baseUrl: "https://nonsecret-endpoint.example/v1",
        auth: {
          resolve: () => ({
            available: true,
            apiKey: "ephemeral-resolver-secret",
            extraHeaders: { "X-Connected-Account": "account-secret" },
          }),
        },
      },
    },
  });
  const lifecycleData: ActionEventData[] = [];
  const lifecycle = createActionLifecycleEmitter({
    namespace: "tenant-a",
    append(input) {
      lifecycleData.push(structuredClone(input.data));
      return Promise.resolve({ deduplicated: false } as never);
    },
  });
  const actions = createActionCallers({ callLlm: callLlmAction }, {
    createEffectClient: () => memoryEffects(),
    actionLifecycle: lifecycle,
    content: test.context.content,
    signal: test.context.signal,
    createInvocationKey: () => "credential-lifecycle",
    createContext(input) {
      return Object.freeze({
        ...test.context,
        action: Object.freeze({
          id: input.frame.actionId,
          runId: input.frame.actionRunId,
          metadata: input.frame.metadata,
        }),
        progress: input.progress,
      });
    },
  });

  try {
    await actions.callLlm(emptyInput, { operationKey: "credential-test" });
    assertEquals(lifecycleData.map((data) => data.status), [
      "invoked",
      "completed",
    ]);
    const durable = JSON.stringify(lifecycleData);
    assertEquals(durable.includes("ephemeral-resolver-secret"), false);
    assertEquals(durable.includes("account-secret"), false);
    assertEquals(durable.includes("X-Connected-Account"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("llm.call reuses one dynamic credential resolver across fallback Models", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{
      connection: "connected",
      model: "gpt-primary",
      options: { estimateCost: false, openaiApi: "chat_completions" },
    }] as const,
  };

  const originalFetch = globalThis.fetch;
  let resolverCalls = 0;
  const resolverContexts: LlmConnectionContext[] = [];
  let providerCalls = 0;
  const seen: Array<Readonly<Record<string, unknown>>> = [];
  globalThis.fetch = (_input, init) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return Promise.reject(new Error("provider unavailable"));
    }
    assertEquals(
      new Headers(init?.headers).get("authorization"),
      "Bearer oauth-secret",
    );
    assertEquals(new Headers(init?.headers).get("x-account"), "account-1");
    return Promise.resolve(
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"resolved"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };
  const test = fixture({
    llmConnections: {
      "connected": {
        provider: "openai",
        auth: {
          resolve(
            context: LlmConnectionContext,
            execution: LlmConnectionExecution,
          ) {
            resolverCalls += 1;
            resolverContexts.push(context);
            seen.push({
              namespace: context.namespace,
              operationKey: context.operationKey,
              runId: context.action.runId,
              correlationId: context.identity.correlationId,
              connection: execution.connection,
            });
            return {
              available: true,
              apiKey: "oauth-secret",
              extraHeaders: { "X-Account": "account-1" },
            };
          },
        },
      },
    },
  });
  try {
    const output = await callLlmAction.execute({
      ...emptyInput,
      models: [{
        connection: "connected",
        model: "gpt-primary",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      }, {
        connection: "connected",
        model: "gpt-backup",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      }],
    }, test.context);
    assertEquals(resolverCalls, 1);
    assertEquals(resolverContexts[0].actions, test.context.actions);
    assertEquals(resolverContexts[0].signal, test.context.signal);
    assertEquals(providerCalls, 2);
    assertEquals(seen, [{
      namespace: "tenant-a",
      operationKey: "operation-a",
      runId: "run-a",
      correlationId: "correlation-a",
      connection: "connected",
    }]);
    assertEquals(output.model, "gpt-backup");
    assertEquals(
      JSON.stringify({ input: emptyInput, output }).includes("oauth-secret"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("an unavailable credential skips its Model without a provider attempt", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{
      connection: "account",
      model: "connected-model",
      options: { estimateCost: false, openaiApi: "chat_completions" },
    }] as const,
  };

  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (input) => {
    providerCalls += 1;
    assertEquals(String(input), "https://backup.example/v1/chat/completions");
    return Promise.resolve(
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"backup"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };
  const test = fixture({
    llmConnections: {
      "account": {
        provider: "openai",
        auth: {
          resolve: () => ({ available: false, reason: "not connected" }),
        },
      },
      "backup": {
        provider: "openai",
        baseUrl: "https://backup.example/v1",
        auth: { apiKey: "backup-secret" },
      },
    },
  });
  try {
    const output = await callLlmAction.execute({
      ...emptyInput,
      models: [{
        connection: "account",
        model: "connected-model",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      }, {
        connection: "backup",
        model: "backup-model",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      }],
    }, test.context);
    assertEquals(providerCalls, 1);
    assertEquals(output.model, "backup-model");
    assertEquals(output.attempts?.map((attempt) => attempt.model), [
      "backup-model",
    ]);
    assertEquals(JSON.stringify(output).includes("backup-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("an invalid dynamic credential result is sanitized and falls back", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "account", model: "connected-model" }] as const,
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
    llmConnections: {
      "account": {
        provider: "openai",
        auth: {
          resolve: () => ({ available: true }) as unknown as LlmAuthResolution,
        },
      },
      "backup": { adapter: "backup" },
    },

    adapters: { backup },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: [{ connection: "account", model: "connected-model" }, {
      connection: "backup",
      model: "backup-model",
    }],
  }, test.context);
  assertEquals(output.model, "backup-model");
  assertEquals(
    output.attempts?.map((attempt) => ({
      connection: attempt.connection,
      model: attempt.model,
      providerRequest: attempt.providerRequest,
      code: attempt.error?.code,
    })),
    [{
      connection: "account",
      model: "connected-model",
      providerRequest: false,
      code: "credential_unavailable",
    }, {
      connection: "backup",
      model: "backup-model",
      providerRequest: true,
      code: undefined,
    }],
  );
});

Deno.test("settled attempts remain accounted when later credentials are unavailable", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "primary-model" }] as const,
  };

  const primary: LlmAdapter = {
    call() {
      return invocation(Promise.reject(
        new LlmAdapterCallError(
          "primary failed",
          {
            attempts: [{
              status: "failed",
              usage: { inputTokens: 3, totalTokens: 3 },
            }],
          },
        ),
      ));
    },
  };
  const test = fixture({
    llmConnections: {
      "primary": { adapter: "primary" },
      "account": {
        provider: "openai",
        auth: { resolve: () => ({ available: false }) },
      },
    },

    adapters: { primary },
  });

  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: [{ connection: "primary", model: "primary-model" }, {
          connection: "account",
          model: "connected-model",
        }],
      }, test.context),
    Error,
    "primary failed",
  );
  assertEquals(test.progressValues(), [{
    schema: "copilotz.llm.attempt-accounting.v1",
    attempts: [{
      connection: "primary",
      id: "run-a:attempt:0",
      index: 0,
      providerRequest: true,
      model: "primary-model",
      adapter: "primary",
      providerModel: "primary-model",
      status: "failed",
      usage: { inputTokens: 3, totalTokens: 3 },
      error: { message: "primary failed" },
    }],
  }]);
});

Deno.test("all unavailable credentials fail without a provider request", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{
      connection: "account",
      model: "connected-model",
      options: { estimateCost: false, openaiApi: "chat_completions" },
    }] as const,
  };

  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = () => {
    providerCalls += 1;
    throw new Error("provider must not be called");
  };
  const test = fixture({
    llmConnections: {
      "account": {
        provider: "openai",
        auth: { resolve: () => ({ available: false }) },
      },
    },
  });
  try {
    await assertRejects(
      async () =>
        await callLlmAction.execute(
          {
            ...emptyInput,
            models: [{
              connection: "account",
              model: "connected-model",
              options: { estimateCost: false, openaiApi: "chat_completions" },
            }],
          },
          test.context,
        ),
      Error,
      "No LLM credential is available",
    );
    assertEquals(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("connection configuration is preflighted before provider I/O", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{
      connection: "first",
      model: "first-model",
      options: { estimateCost: false, openaiApi: "chat_completions" },
    }] as const,
  };

  let providerCalls = 0;
  const test = fixture({
    llmConnections: {
      "first": { provider: "openai", auth: { apiKey: "inline-secret" } },
      "openai-credential": {
        provider: "unsupported-provider",
        auth: { apiKey: "shared-secret" },
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    providerCalls += 1;
    throw new Error("provider must not be called");
  };
  try {
    await assertRejects(
      async () =>
        await callLlmAction.execute(
          {
            ...emptyInput,
            models: [{
              connection: "first",
              model: "first-model",
              options: { estimateCost: false, openaiApi: "chat_completions" },
            }, { connection: "openai-credential", model: "second-model" }],
          },
          test.context,
        ),
      TypeError,
      "must be a built-in LLM provider",
    );
    assertEquals(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("llm.call rejects invalid durable input before Adapter use", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
    llmConnections: { "primary": { adapter: "provider" } },
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
        models: [{ connection: "primary", model: "model-a" }],
        mode: "generate",
        request: { messages: [{ role: "operator", content: [] }] },
      } as unknown as LlmCallInput, test.context),
    TypeError,
    "role",
  );
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        models: [{ connection: "primary", model: "model-a" }],
        mode: "generate",
        request: { messages: [{ role: "user", content: ["inline"] }] },
      } as unknown as LlmCallInput, test.context),
    TypeError,
    "plain object",
  );
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: [{ connection: "primary", model: "model-a" }, {
          connection: "primary",
          model: "model-a",
        }],
      }, test.context),
    TypeError,
    "duplicate selections",
  );
  assertEquals(calls, 0);
});

Deno.test("llm.call validates the complete candidate list before calling", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
    llmConnections: { "primary": { adapter: "provider" } },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: [{ connection: "primary", model: "model-a" }, {
          connection: "missing",
          model: "missing",
        }],
      }, missing.context),
    Error,
    "Unknown LLM connection 'missing'",
  );

  const invalidAdapter = fixture({
    llmConnections: {
      "primary": { adapter: "provider" },
      "backup": { adapter: "absent" },
    },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: [{ connection: "primary", model: "model-a" }, {
          connection: "backup",
          model: "model-b",
        }],
      }, invalidAdapter.context),
    Error,
    "Unknown LLM adapter 'absent'",
  );

  const invalidProfile = fixture({
    llmConnections: {
      "primary": { adapter: "provider" },
      "broken": {
        provider: "openai",
        auth: { apiKey: "" },
      } as Readonly<Record<string, unknown>>,
    },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: [{ connection: "primary", model: "model-a" }, {
          connection: "broken",
          model: "broken",
        }],
      }, invalidProfile.context),
    TypeError,
    "apiKey",
  );

  const laterBuiltin = fixture({
    llmConnections: {
      "primary": { adapter: "provider" },
      "builtin": { provider: "openai", auth: { apiKey: "test" } },
    },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: [{
          connection: "primary",
          model: "model-a",
          options: { apiKey: "must-not-reach-a-provider" },
        }, { connection: "builtin", model: "model-b" }],
      }, laterBuiltin.context),
    TypeError,
    "cannot override connection transport or authentication",
  );
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: [{ connection: "primary", model: "model-a" }, {
          connection: "builtin",
          model: "model-b",
        }],
        mode: "session",
      }, laterBuiltin.context),
    TypeError,
    "does not implement LLM session mode",
  );
  assertEquals(calls, 0);
});

Deno.test("llm.call owns exact ordered candidate attempts", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "first" }] as const,
  };

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
    llmConnections: {
      "primary": { adapter: "provider" },
      "backup": { adapter: "provider" },
      "nested": { adapter: "provider" },
      "last": { adapter: "provider" },
    },
    adapters: { provider: adapter },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: [
      { connection: "primary", model: "first" },
      { connection: "backup", model: "second" },
      { connection: "nested", model: "third" },
      { connection: "last", model: "last" },
    ],
  }, test.context);
  assertEquals(calls, ["first", "second", "third", "last"]);
  assertEquals(output.model, "last");
  assertEquals(output.adapter, "provider");
  assertEquals(output.providerModel, "last");
  assertEquals(output.finishReason, "stop");
  assertEquals(
    output.attempts?.map((attempt) => ({
      id: attempt.id,
      index: attempt.index,
      model: attempt.model,
      status: attempt.status,
    })),
    [
      { id: "run-a:attempt:0", index: 0, model: "first", status: "failed" },
      { id: "run-a:attempt:1", index: 1, model: "second", status: "failed" },
      { id: "run-a:attempt:2", index: 2, model: "third", status: "failed" },
      { id: "run-a:attempt:3", index: 3, model: "last", status: "completed" },
    ],
  );
  assertEquals(output.attempts?.[3].startedAt, "2026-08-23T00:00:01.000Z");
  assertEquals(
    pendingId(output.content[0]),
    "capture:attempt:3:capture:content:0",
  );
});

Deno.test("llm.call propagates Model fallback availability and aggregates every provider attempt", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
            cacheCreationInputTokens: 4,
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
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: [{ connection: "primary", model: "model-a" }, {
      connection: "backup",
      model: "model-b",
    }],
  }, test.context);
  assertEquals(availability, [true, false]);
  assertEquals(output.model, "model-b");
  assertEquals(output.usage, {
    inputTokens: 14,
    outputTokens: 4,
    reasoningTokens: 3,
    cachedInputTokens: 2,
    cacheCreationInputTokens: 4,
    totalTokens: 18,
    cost: { amount: 14, currency: "USD" },
  });
  assertEquals(
    output.attempts?.map((attempt) => ({
      index: attempt.index,
      model: attempt.model,
      adapter: attempt.adapter,
      providerModel: attempt.providerModel,
      status: attempt.status,
    })),
    [
      {
        index: 0,
        model: "model-a",
        adapter: "primary",
        providerModel: "model-a",
        status: "failed",
      },
      {
        index: 1,
        model: "model-a",
        adapter: "primary",
        providerModel: "model-a",
        status: "failed",
      },
      {
        index: 2,
        model: "model-b",
        adapter: "backup",
        providerModel: "model-b",
        status: "failed",
      },
      {
        index: 3,
        model: "model-b",
        adapter: "backup",
        providerModel: "model-b",
        status: "completed",
      },
    ],
  );
});

Deno.test("llm.call omits mixed-currency aggregate cost and preserves attempt costs", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: [{ connection: "primary", model: "model-a" }, {
      connection: "backup",
      model: "model-b",
    }],
  }, test.context);
  assertEquals(output.usage, { inputTokens: 3, totalTokens: 3 });
  assertEquals(
    output.attempts?.map((attempt) => attempt.usage?.cost),
    [
      { amount: 1, currency: "USD" },
      { amount: 2, currency: "EUR" },
    ],
  );
});

Deno.test("llm.call consumes prepared content without asset reads and uses explicit selection options", async () => {
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
    llmConnections: { "primary": { adapter: "provider" } },
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
    models: [{
      connection: "primary",
      model: "provider-model",
      options: { temperature: 0.2, topP: 0.9, maxTokens: 100 },
    }],
    mode: "session",
    request: {
      instructions: "",
      messages: [{
        role: "user",
        content: [{ ...textRef, value: "hello" }, {
          ...jsonRef,
          value: { a: 1 },
        }, { ...imageRef, value: new Uint8Array([1, 2, 3]) }],
        metadata: { source: "message" },
      }],
    },
    inputStreamId: "live-input",
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
  assertEquals(
    pendingId(output.content[0]),
    "capture:attempt:0:capture:content:0",
  );
  assertEquals(
    pendingId(output.reasoning?.[0]),
    "capture:attempt:0:capture:reasoning:0",
  );
  assertEquals(output.usage?.cost, { amount: 0.01, currency: "USD" });
  assertEquals(test.prepared.map((item) => item.operationKey), [
    "attempt:0:content",
    "attempt:0:reasoning",
  ]);
});

Deno.test("llm.call keeps attachments reference-only while preserving mixed content order", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "provider-model" }] as const,
  };

  const textRef = ref("text-a");
  const exportedAttachment = Object.freeze({
    ...ref("tool-export-a", "image", "image/png"),
    role: "tool.output",
    name: "render.png",
    disposition: "attachment" as const,
  });
  const defaultFile = Object.freeze({
    ...ref("file-a", "file", "application/pdf"),
    name: "brief.pdf",
  });
  const inlineFile = Object.freeze({
    ...ref("file-inline-a", "file", "application/pdf"),
    name: "included.pdf",
    disposition: "inline" as const,
  });
  let seen: LlmAdapterCallInput | undefined;
  const test = fixture({
    llmConnections: { "primary": { adapter: "provider" } },
    adapters: {
      provider: {
        call(input) {
          seen = input;
          return invocation({
            content: { type: "text", text: "answer" },
            attempts: [{ status: "completed" }],
          });
        },
      },
    },
    resolved: {
      "text-a": resolved(textRef, {
        bytes: encoder.encode("before attachment"),
        text: "before attachment",
      }),
      "file-inline-a": resolved(inlineFile, {
        bytes: new Uint8Array([1, 2, 3]),
      }),
    },
  });

  await callLlmAction.execute({
    ...emptyInput,
    request: {
      messages: [{
        role: "user",
        content: [
          { ...textRef, value: "before attachment" },
          { ...exportedAttachment, resolve: false },
          { ...defaultFile, resolve: false },
          { ...inlineFile, value: new Uint8Array([1, 2, 3]) },
        ],
      }],
    },
  }, test.context);

  assertEquals(
    test.resolvedRequests().map((refs) => refs.map((item) => item.assetId)),
    [],
  );
  assertEquals(seen?.request.messages[0].content, [
    {
      type: "text",
      text: "before attachment",
      role: "body",
      mediaType: "text/plain",
    },
    {
      type: "text",
      text:
        'Copilotz attachment {"name":"render.png","mediaType":"image/png","assetRef":"asset://tenant-a/tool-export-a"}. Its body is not included in this LLM request; use an asset tool only if you need more than the conversation already says about it.',
      role: "tool.output",
      mediaType: "text/plain; charset=utf-8",
      name: "render.png",
    },
    {
      type: "text",
      text:
        'Copilotz attachment {"name":"brief.pdf","mediaType":"application/pdf","assetRef":"asset://tenant-a/file-a"}. Its body is not included in this LLM request; use an asset tool only if you need more than the conversation already says about it.',
      role: "body",
      mediaType: "text/plain; charset=utf-8",
      name: "brief.pdf",
    },
    {
      type: "file",
      bytes: new Uint8Array([1, 2, 3]),
      role: "body",
      mediaType: "application/pdf",
      name: "included.pdf",
      disposition: "inline",
    },
  ]);
  assert(
    !seen?.request.messages[0].content.some((part) =>
      part.type === "file" && part.name !== "included.pdf"
    ),
  );
});

Deno.test("llm.call does not resolve an attachment-only request", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "provider-model" }] as const,
  };

  const attachment = Object.freeze({
    ...ref("attachment-a", "file", "application/pdf"),
    name: "private.pdf",
    disposition: "attachment" as const,
  });
  let seen: LlmAdapterCallInput | undefined;
  const test = fixture({
    llmConnections: { "primary": { adapter: "provider" } },
    adapters: {
      provider: {
        call(input) {
          seen = input;
          return invocation({
            content: { type: "text", text: "answer" },
            attempts: [{ status: "completed" }],
          });
        },
      },
    },
  });

  await callLlmAction.execute({
    ...emptyInput,
    request: {
      messages: [{
        role: "user",
        content: [{ ...attachment, resolve: false }],
      }],
    },
  }, test.context);

  assertEquals(test.resolvedRequests(), []);
  const part = seen?.request.messages[0].content[0];
  assertEquals(part?.type, "text");
  assert(!("bytes" in (part ?? {})));
  assert(!("file_data" in (part ?? {})));
});

Deno.test("llm.call publishes frames through Streams and captures final pending content", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
    llmConnections: { "primary": { adapter: "provider" } },
    adapters: { provider: adapter },
  });
  const output = await callLlmAction.execute({
    ...emptyInput,
    stream: { id: "visible", metadata: { surface: "chat" } },
  }, test.context);

  assertEquals(test.opened.length, 2);
  assertEquals(test.opened.map((stream) => stream.input.id), [
    "visible:provider-attempt:0:content:text%2Fplain",
    "visible:provider-attempt:0:reasoning:text%2Fplain",
  ]);
  assertEquals(test.opened.map((stream) => stream.input.metadata), [
    {
      connection: "primary",
      surface: "chat",
      llmAttemptId: "run-a",
      providerAttemptIndex: 0,
      lane: "content",
      model: "model-a",
      adapter: "provider",
    },
    {
      connection: "primary",
      surface: "chat",
      llmAttemptId: "run-a",
      providerAttemptIndex: 0,
      lane: "reasoning",
      model: "model-a",
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
  assertEquals(test.opened[0].appends.length, 1);
  assertEquals(test.opened[1].appends.length, 1);
  assert(test.opened.every((stream) => stream.closed && !stream.aborted));
  assert(
    test.opened.every((stream) => stream.disposed && stream.disposeCalls === 1),
  );
  assertEquals(test.materialized.length, 0);
  assertEquals(test.captured.length, 1);
  assertEquals(test.progressCalls(), 0);
  assertEquals(
    pendingId(output.content[0]),
    "capture:attempt:0:capture:content:0",
  );
  assert(!pendingId(output.content[0]).startsWith("pending:stream-body:"));
});

Deno.test("llm.call gives every lane and media tuple an injective stream identity", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

  const frames = new ReadableStream<LlmAdapterFrame>({
    start(controller) {
      for (
        const [lane, mediaType, value] of [
          ["tool-calls", "a\u0000content", "first"],
          ["tool-calls\u0000a", "content", "second"],
          ["lane/one", "text/plain", "third"],
          ["lane_2Fone", "text/plain", "fourth"],
        ] as const
      ) {
        controller.enqueue({
          lane,
          mediaType,
          bytes: encoder.encode(value),
        });
      }
      controller.close();
    },
  });
  const test = fixture({
    llmConnections: { "primary": { adapter: "provider" } },
    adapters: {
      provider: {
        call() {
          return invocation({
            content: "normalized answer",
            attempts: [{ status: "completed" }],
          }, frames);
        },
      },
    },
  });

  await callLlmAction.execute({
    ...emptyInput,
    stream: { id: "collision" },
  }, test.context);

  assertEquals(test.opened.map((stream) => stream.input.id), [
    "collision:provider-attempt:0:tool-calls:a%00content",
    "collision:provider-attempt:0:tool-calls%00a:content",
    "collision:provider-attempt:0:lane%2Fone:text%2Fplain",
    "collision:provider-attempt:0:lane_2Fone:text%2Fplain",
  ]);
  assertEquals(
    test.opened.map((stream) =>
      decoder.decode(
        new Uint8Array(stream.appends.flatMap((chunk) => [...chunk])),
      )
    ),
    ["first", "second", "third", "fourth"],
  );
});

Deno.test("llm.call reuses an exactly equivalent content stream Body", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

  const frames = new ReadableStream<LlmAdapterFrame>({
    start(controller) {
      controller.enqueue({
        lane: "content",
        mediaType: "text/plain; charset=utf-8",
        bytes: encoder.encode("hel"),
      });
      controller.enqueue({
        lane: "content",
        mediaType: "text/plain; charset=utf-8",
        bytes: encoder.encode("lo"),
      });
      controller.close();
    },
  });
  const test = fixture({
    llmConnections: { "primary": { adapter: "provider" } },
    adapters: {
      provider: {
        call() {
          return invocation({
            content: {
              type: "text",
              text: "hello",
              mediaType: "text/plain; charset=utf-8",
            },
            attempts: [{ status: "completed" }],
          }, frames);
        },
      },
    },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    stream: { id: "equivalent" },
  }, test.context);

  assertEquals(test.materialized.length, 0);
  assertEquals(
    test.captured.length,
    0,
    "Equivalent bytes reuse the existing sealed pending body.",
  );
  assertEquals(output.content, [pending(
    "pending:stream-body:equivalent:provider-attempt:0:content:text%2Fplain%3B%20charset%3Dutf-8",
    "text/plain; charset=utf-8",
    encoder.encode("hello"),
  )]);
  assertEquals(
    test.opened[0].retentions,
    [],
    "Canonical retention starts at domain adoption.",
  );
  assertEquals(test.opened[0].disposeCalls, 1);
  assert(test.opened[0].disposed && !test.opened[0].aborted);
});

Deno.test("llm.call retains a non-equivalent stream as an observation Body", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

  const frames = new ReadableStream<LlmAdapterFrame>({
    start(controller) {
      controller.enqueue({
        lane: "content",
        mediaType: "text/plain; charset=utf-8",
        bytes: encoder.encode("visible draft"),
      });
      controller.close();
    },
  });
  const test = fixture({
    llmConnections: { "primary": { adapter: "provider" } },
    adapters: {
      provider: {
        call() {
          return invocation({
            content: "normalized final",
            attempts: [{ status: "completed" }],
          }, frames);
        },
      },
    },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    stream: { id: "different" },
  }, test.context);

  assertEquals(test.materialized.length, 0);
  assertEquals(test.captured.length, 1);
  const final = test.captured[0];
  assertEquals(final.content[0].assetId, "prepared:attempt:0:content:0");
  assertEquals(output.content, [
    pending(
      "capture:attempt:0:capture:content:0",
      final.assets[0].mediaType,
      final.assets[0].body,
    ),
  ]);
  assertEquals(test.opened[0].retentions, [{ retention: "observation" }]);
});

Deno.test("llm.call never falls back after publishing visible output", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
    onAppend: appended,
  });

  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: [{ connection: "primary", model: "model-a" }, {
          connection: "backup",
          model: "model-b",
        }],
        stream: { id: "visible" },
      }, test.context),
    Error,
    "primary failed after output",
  );
  assertEquals(backupCalls, 0);
  assertEquals(test.opened.length, 1);
  assert(test.opened[0].aborted);
  assertEquals(test.opened[0].abortInput, {
    outcome: "failed",
    reason: "provider_error",
  });
});

Deno.test("llm.call aborts and settles both invocation branches before fallback", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

  let primaryResultSettled = false;
  let frameCancelled = false;
  let backupObservedSettled = false;
  const primary: LlmAdapter = {
    call() {
      const result = new Promise<LlmAdapterResult>((_resolve, reject) => {
        queueMicrotask(() => {
          primaryResultSettled = true;
          reject(new Error("primary failed"));
        });
      });
      const frames = new ReadableStream<LlmAdapterFrame>({
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
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: [{ connection: "primary", model: "model-a" }, {
      connection: "backup",
      model: "model-b",
    }],
  }, test.context);
  assert(backupObservedSettled);
  assertEquals(output.model, "model-b");
  assertEquals(output.attempts?.map((item) => item.status), [
    "failed",
    "completed",
  ]);
});

Deno.test("llm.call falls back without awaiting non-cooperative frame cancellation", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
  });

  const output = await within(
    Promise.resolve(callLlmAction.execute({
      ...emptyInput,
      models: [{ connection: "primary", model: "model-a" }, {
        connection: "backup",
        model: "model-b",
      }],
    }, test.context)),
  );
  assertEquals(output.model, "model-b");
  assert(cancellationRequested);
});

Deno.test("llm.call cancellation does not await non-cooperative result or frames", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

  const controller = new AbortController();
  let appended!: () => void;
  const didAppend = new Promise<void>((resolve) => {
    appended = resolve;
  });
  let cancellationRequested = false;
  const adapter: LlmAdapter = {
    call() {
      return invocation(
        new Promise<LlmAdapterResult>(() => {}),
        new ReadableStream<LlmAdapterFrame>({
          start(controller) {
            controller.enqueue({
              lane: "content",
              mediaType: "text/plain",
              bytes: encoder.encode("partial"),
            });
          },
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
    llmConnections: { "primary": { adapter: "provider" } },
    adapters: { provider: adapter },
    signal: controller.signal,
    onAppend: appended,
  });
  const executing = Promise.resolve(
    callLlmAction.execute({
      ...emptyInput,
      stream: { id: "cancelled" },
    }, test.context),
  );
  await didAppend;
  controller.abort(new DOMException("caller cancelled", "AbortError"));

  await within(assertRejects(
    async () => await executing,
    DOMException,
    "caller cancelled",
  ));
  assert(cancellationRequested);
  assertEquals(test.opened[0]?.abortInput, {
    outcome: "cancelled",
    reason: "cancelled",
  });
});

Deno.test("llm.call observes result rejection before acquiring a locked frame reader", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
    llmConnections: { "primary": { adapter: "provider" } },
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
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
    llmConnections: {
      "primary": { adapter: "invalid" },
      "backup": { adapter: "backup" },
    },
    adapters: { invalid, backup },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: [{ connection: "primary", model: "model-a" }, {
      connection: "backup",
      model: "model-b",
    }],
  }, test.context);
  assertEquals(output.model, "model-b");
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
    llmConnections: { "primary": { adapter: "bad" } },
    adapters: { bad: badTool },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, rejected.context),
    Error,
    "malformed tool calls",
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
    llmConnections: { "primary": { adapter: "duplicate" } },
    adapters: { duplicate: duplicateToolCalls },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, duplicate.context),
    Error,
    "malformed tool calls",
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
    llmConnections: { "primary": { adapter: "blank" } },
    adapters: { blank: blankAction },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, blank.context),
    Error,
    "malformed tool calls",
  );
});

Deno.test("llm.call drains a framework-rejected stream before fallback accounting", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "primary-model" }] as const,
  };

  let releaseResult!: () => void;
  const resultReady = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  let backupObservedTerminalUsage = false;
  const primary: LlmAdapter = {
    call() {
      return invocation(
        resultReady.then(() => ({
          content: "provider answer",
          toolCalls: [{ id: "", action: "search", input: {} }],
          attempts: [{
            status: "completed" as const,
            usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          }],
        } as unknown as LlmAdapterResult)),
      );
    },
  };
  const backup: LlmAdapter = {
    call() {
      backupObservedTerminalUsage = true;
      return invocation({
        content: "recovered",
        attempts: [{
          status: "completed",
          usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
        }],
      });
    },
  };
  const test = fixture({
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
  });

  const executing = callLlmAction.execute({
    ...emptyInput,
    models: [{ connection: "primary", model: "primary-model" }, {
      connection: "backup",
      model: "backup-model",
    }],
  }, test.context);
  await Promise.resolve();
  releaseResult();
  const output = await executing;

  assert(backupObservedTerminalUsage);
  assertEquals(output.model, "backup-model");
  assertEquals(
    output.attempts?.map((attempt) => ({
      connection: attempt.connection,
      model: attempt.model,
      providerRequest: attempt.providerRequest,
      status: attempt.status,
      totalTokens: attempt.usage?.totalTokens,
    })),
    [
      {
        connection: "primary",
        model: "primary-model",
        providerRequest: true,
        status: "failed",
        totalTokens: 5,
      },
      {
        connection: "backup",
        model: "backup-model",
        providerRequest: true,
        status: "completed",
        totalTokens: 5,
      },
    ],
  );
});

Deno.test("llm.call falls back after malformed speculative tool drafts without accepting a Tool", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "primary-model" }] as const,
  };

  let releaseResult!: () => void;
  const resultReady = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  let backupCalls = 0;
  const primary: LlmAdapter = {
    call() {
      return invocation(
        resultReady.then(() => ({
          content: "discarded",
          toolCalls: [{ id: "", action: "search", input: {} }],
          attempts: [{ status: "completed" as const }],
        } as unknown as LlmAdapterResult)),
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              lane: "tool-calls",
              mediaType: "application/x-ndjson",
              bytes: encoder.encode('{"draft":true}\n'),
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
      return invocation(
        {
          content: "recovered",
          attempts: [{ status: "completed" }],
        },
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              lane: "content",
              mediaType: "text/plain",
              bytes: encoder.encode("recovered"),
            });
            controller.close();
          },
        }),
      );
    },
  };
  const test = fixture({
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
  });

  const executing = callLlmAction.execute({
    ...emptyInput,
    models: [{ connection: "primary", model: "primary-model" }, {
      connection: "backup",
      model: "backup-model",
    }],
    stream: { id: "tool-draft" },
  }, test.context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(test.opened.length, 1);
  assertEquals(test.opened[0]?.input.role, "tool-calls");
  releaseResult();
  const output = await executing;

  assertEquals(output.model, "backup-model");
  assertEquals(backupCalls, 1);
  assertEquals(output.toolCalls, undefined);
  assertEquals(test.opened[0]?.aborted, true);
  assertEquals(test.opened.map((stream) => stream.input.id), [
    "tool-draft:provider-attempt:0:tool-calls:application%2Fx-ndjson",
    "tool-draft:provider-attempt:1:content:text%2Fplain",
  ]);
  assertEquals(
    test.opened.map((stream) => stream.input.metadata?.llmAttemptId),
    [
      "run-a",
      "run-a",
    ],
  );
  assertEquals(
    test.prepared.some((entry) => entry.operationKey.includes("discarded")),
    false,
  );
});

Deno.test("llm.call falls back after reasoning and malformed speculative tool drafts without accepting a Tool", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "primary-model" }] as const,
  };

  let releaseResult!: () => void;
  const resultReady = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  let backupCalls = 0;
  const primary: LlmAdapter = {
    call() {
      return invocation(
        resultReady.then(() => ({
          content: "discarded",
          toolCalls: [{ id: "", action: "search", input: {} }],
          attempts: [{ status: "completed" as const }],
        } as unknown as LlmAdapterResult)),
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              lane: "reasoning",
              mediaType: "text/plain",
              bytes: encoder.encode("thinking"),
            });
            controller.enqueue({
              lane: "tool-calls",
              mediaType: "application/x-ndjson",
              bytes: encoder.encode('{"draft":true}\n'),
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
      return invocation(
        {
          content: "recovered",
          attempts: [{ status: "completed" }],
        },
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              lane: "content",
              mediaType: "text/plain",
              bytes: encoder.encode("recovered"),
            });
            controller.close();
          },
        }),
      );
    },
  };
  const test = fixture({
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
  });

  const executing = callLlmAction.execute({
    ...emptyInput,
    models: [{ connection: "primary", model: "primary-model" }, {
      connection: "backup",
      model: "backup-model",
    }],
    stream: { id: "tool-draft" },
  }, test.context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(test.opened.length, 2);
  assertEquals(test.opened[0]?.input.role, "reasoning");
  releaseResult();
  const output = await executing;

  assertEquals(output.model, "backup-model");
  assertEquals(backupCalls, 1);
  assertEquals(output.toolCalls, undefined);
  assertEquals(test.opened[0]?.aborted, true);
  assertEquals(test.opened.map((stream) => stream.input.id), [
    "tool-draft:provider-attempt:0:reasoning:text%2Fplain",
    "tool-draft:provider-attempt:0:tool-calls:application%2Fx-ndjson",
    "tool-draft:provider-attempt:1:content:text%2Fplain",
  ]);
  assertEquals(
    test.opened.map((stream) => stream.input.metadata?.llmAttemptId),
    [
      "run-a",
      "run-a",
      "run-a",
    ],
  );
  assertEquals(
    test.prepared.some((entry) => entry.operationKey.includes("discarded")),
    false,
  );
});

Deno.test("llm.call carries bounded Adapter rejected-attempt evidence through Action progress", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model" }] as const,
  };

  const adapter: LlmAdapter = {
    call() {
      return invocation(Promise.reject(
        new LlmAdapterCallError(
          "safe adapter rejection",
          {
            rejectedAttemptEvidence: {
              code: "tool_protocol_rejected",
              message:
                "The provider rejected the tool protocol before execution.",
              location: "toolCalls",
              retryable: true,
            },
          },
        ),
      ));
    },
  };
  const test = fixture({
    llmConnections: { "primary": { adapter: "adapter" } },
    adapters: { adapter },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, test.context),
    LlmAdapterCallError,
    "safe adapter rejection",
  );
  assertEquals(test.progressValues()[0], {
    schema: "copilotz.llm.rejected-attempt-evidence",
    attempt: {
      id: "run-a:attempt:0",
      index: 0,
      model: "model",
      adapter: "adapter",
      providerModel: "model",
    },
    evidence: {
      code: "tool_protocol_rejected",
      message: "The provider rejected the tool protocol before execution.",
      location: "toolCalls",
      retryable: true,
    },
  });
});

Deno.test("llm.call drains invalid local frames before fallback accounting", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "primary-model" }] as const,
  };

  let releaseResult!: () => void;
  const resultReady = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  let backupCalls = 0;
  const primary: LlmAdapter = {
    call() {
      return invocation(
        resultReady.then(() => ({
          content: "provider answer",
          attempts: [{
            status: "completed" as const,
            usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
          }],
        })),
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              lane: "content",
              mediaType: "text/plain",
              bytes: "not-bytes",
            } as unknown as LlmAdapterFrame);
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
        content: "recovered",
        attempts: [{ status: "completed" }],
      });
    },
  };
  const test = fixture({
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
  });

  const executing = callLlmAction.execute({
    ...emptyInput,
    models: [{ connection: "primary", model: "primary-model" }, {
      connection: "backup",
      model: "backup-model",
    }],
  }, test.context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(backupCalls, 0);
  releaseResult();
  const output = await executing;

  assertEquals(backupCalls, 1);
  assertEquals(
    output.attempts?.map((attempt) => ({
      model: attempt.model,
      status: attempt.status,
      totalTokens: attempt.usage?.totalTokens,
    })),
    [{ model: "primary-model", status: "failed", totalTokens: 8 }, {
      model: "backup-model",
      status: "completed",
      totalTokens: undefined,
    }],
  );
  const replay = await callLlmAction.execute({
    ...emptyInput,
    models: [{ connection: "primary", model: "primary-model" }, {
      connection: "backup",
      model: "backup-model",
    }],
  }, test.context);
  assertEquals(replay.model, "backup-model");
  assertEquals(replay.attempts, output.attempts);
  assertEquals(backupCalls, 1);
});

Deno.test("llm.call reports finalized attempts before a terminal framework failure", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model" }] as const,
  };

  const adapter: LlmAdapter = {
    call() {
      return invocation({
        content: "answer",
        toolCalls: [{ id: "", action: "search", input: {} }],
        attempts: [{
          status: "completed",
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        }],
      } as unknown as LlmAdapterResult);
    },
  };
  const test = fixture({
    llmConnections: { "primary": { adapter: "provider" } },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, test.context),
    Error,
    "malformed tool calls",
  );
  assertEquals(test.progressValues(), [{
    schema: "copilotz.llm.rejected-attempt-evidence",
    attempt: {
      id: "run-a:attempt:0",
      index: 0,
      model: "model",
      adapter: "provider",
      providerModel: "model",
    },
    evidence: {
      code: "malformed_tool_call",
      message:
        "The model returned a tool call that does not match the declared tool contract.",
      location: "toolCalls[0].id",
      retryable: true,
    },
  }, {
    schema: "copilotz.llm.attempt-accounting.v1",
    attempts: [{
      connection: "primary",
      id: "run-a:attempt:0",
      index: 0,
      providerRequest: true,
      model: "model",
      adapter: "provider",
      providerModel: "model",
      status: "failed",
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      error: { message: "LLM Adapter returned malformed tool calls." },
    }],
  }]);
});

Deno.test("llm.call canonicalizes durable pipeline roots and bounds pipeline plans", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model" }] as const,
  };

  const valid: LlmAdapter = {
    call() {
      return invocation({
        content: "answer",
        toolCalls: [{
          id: "root",
          action: "extract",
          input: { a: 1, b: { x: true, y: false } },
          pipeline: {
            id: "branch",
            stages: [{
              type: "tool",
              id: "root",
              action: "extract",
              // The durable boundary compares structure, not insertion order.
              input: { b: { y: false, x: true }, a: 1 },
            }, {
              type: "jq",
              filter: ".items",
            }, {
              type: "tool",
              id: "save",
              action: "save",
              input: { notify: true },
            }],
          },
        }],
        attempts: [{ status: "completed" }],
      });
    },
  };
  const accepted = fixture({
    llmConnections: { "primary": { adapter: "valid" } },
    adapters: { valid },
  });
  const output = await callLlmAction.execute(emptyInput, accepted.context);
  assertEquals(output.toolCalls?.[0]?.pipeline?.stages[0], {
    type: "tool",
    id: "root",
    action: "extract",
    input: { a: 1, b: { x: true, y: false } },
  });

  const rejectsPlan = async (toolCalls: unknown) => {
    const adapter: LlmAdapter = {
      call() {
        return invocation({
          content: "answer",
          toolCalls,
          attempts: [{ status: "completed" }],
        } as unknown as LlmAdapterResult);
      },
    };
    const test = fixture({
      llmConnections: { "primary": { adapter: "invalid" } },
      adapters: { invalid: adapter },
    });
    await assertRejects(
      async () => await callLlmAction.execute(emptyInput, test.context),
      Error,
      "malformed tool calls",
    );
  };

  await rejectsPlan(
    Array.from({ length: 65 }, (_, index) => ({
      id: `call-${index}`,
      action: "search",
      input: {},
    })),
  );
  await rejectsPlan([{
    id: "root",
    action: "search",
    input: {},
    pipeline: {
      id: "branch",
      stages: Array.from(
        { length: 33 },
        (_, index) =>
          index === 0
            ? { type: "tool", id: "root", action: "search", input: {} }
            : { type: "jq", filter: "." },
      ),
    },
  }]);
  await rejectsPlan([{
    id: "root",
    action: "search",
    input: {},
    pipeline: {
      id: "branch",
      stages: [{ type: "tool", id: "root", action: "search", input: {} }, {
        type: "jq",
        filter: "x".repeat(16_385),
      }],
    },
  }]);
});

Deno.test("llm.call observes a rejecting result on an invalid invocation", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model" }] as const,
  };

  const adapter: LlmAdapter = {
    call() {
      return {
        frames: "not-a-stream",
        result: Promise.reject(new Error("orphan rejection")),
      } as unknown as ReturnType<LlmAdapter["call"]>;
    },
  };
  const test = fixture({
    llmConnections: { "primary": { adapter: "invalid" } },
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
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: [{ connection: "primary", model: "model-a" }, {
          connection: "backup",
          model: "model-b",
        }],
      }, test.context),
    DOMException,
    "cancelled",
  );
  assertEquals(backupCalls, 0);
});

Deno.test("llm.call settles every opened writer when stream retention fails", async () => {
  const emptyInput = {
    ...baseInput,
    models: [{ connection: "primary", model: "model-a" }] as const,
  };

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
    llmConnections: {
      "primary": { adapter: "primary" },
      "backup": { adapter: "backup" },
    },
    adapters: { primary, backup },
    failStreamRetention: true,
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: [{ connection: "primary", model: "model-a" }, {
          connection: "backup",
          model: "model-b",
        }],
        stream: { id: "visible" },
      }, test.context),
    Error,
    "stream retention failed",
  );
  assertEquals(backupCalls, 0);
  assertEquals(test.opened.length, 2);
  assert(test.opened.every((stream) => stream.closed && !stream.aborted));
  assert(
    test.opened.every((stream) => stream.disposed && stream.disposeCalls === 1),
  );
  assertEquals(test.progressValues(), [{
    schema: "copilotz.llm.attempt-accounting.v1",
    attempts: [{
      connection: "primary",
      id: "run-a:attempt:0",
      index: 0,
      providerRequest: true,
      model: "model-a",
      adapter: "primary",
      providerModel: "model-a",
      status: "completed",
    }],
  }]);
});

Deno.test("llm.call replays matching custom native state and assetizes accepted native output", async () => {
  let received: LlmAdapterCallInput | undefined;
  const adapter: LlmAdapter = {
    call(input) {
      received = input;
      return invocation({
        content: "answer",
        nativeReasoning: {
          api: "custom.api",
          blocks: [{
            type: "json",
            role: "reasoning",
            mediaType: "application/json",
            value: { opaque: "next" },
          }],
        },
        attempts: [
          { status: "failed", usage: { reasoningTokens: 9_000 } },
          { status: "completed", usage: { reasoningTokens: 0 } },
        ],
      });
    },
  };
  const test = fixture({
    llmConnections: { primary: { adapter: "custom" } },
    adapters: { custom: adapter },
  });
  const block = {
    assetId: "previous-native",
    kind: "json" as const,
    role: "reasoning",
    mediaType: "application/json",
    value: { opaque: "previous" },
  };
  const output = await callLlmAction.execute({
    ...baseInput,
    models: [{ connection: "primary", model: "custom-model" }] as const,
    request: {
      messages: [{
        role: "assistant",
        content: [],
        nativeReasoning: {
          schema: "copilotz.llm-native-reasoning.v1",
          adapter: "custom",
          api: "custom.api",
          model: "custom-model",
          blocks: [block],
          reasoningTokens: 123,
        },
      }],
    },
  }, test.context);

  assertEquals(received?.request.messages[0], {
    role: "assistant",
    content: [],
    nativeReasoning: {
      schema: "copilotz.llm-native-reasoning.v1",
      adapter: "custom",
      api: "custom.api",
      model: "custom-model",
      blocks: [{ opaque: "previous" }],
      reasoningTokens: 123,
    },
  });
  assertEquals(test.prepared.map((entry) => entry.operationKey), [
    "attempt:0:content",
    "attempt:0:native-reasoning",
  ]);
  assertEquals(output.usage?.reasoningTokens, 9_000);
  assertEquals(output.nativeReasoning, {
    schema: "copilotz.llm-native-reasoning.v1",
    adapter: "custom",
    api: "custom.api",
    model: "custom-model",
    reasoningTokens: 0,
    blocks: [
      pending(
        "capture:attempt:0:capture:native-reasoning:0",
        "application/json",
        test.captured[1].assets[0].body,
      ),
    ],
  });
});

Deno.test("llm.call strips foreign native state before fallback and replays it only for the matching candidate", async () => {
  let firstRequest: LlmAdapterCallInput | undefined;
  let fallbackRequest: LlmAdapterCallInput | undefined;
  const first: LlmAdapter = {
    call(input) {
      firstRequest = input;
      return invocation(Promise.reject(new LlmAdapterCallError("retry")));
    },
  };
  const fallback: LlmAdapter = {
    call(input) {
      fallbackRequest = input;
      return invocation({
        content: "recovered",
        attempts: [{ status: "completed" }],
      });
    },
  };
  const test = fixture({
    llmConnections: {
      primary: { adapter: "first" },
      fallback: { adapter: "custom" },
    },
    adapters: { first, custom: fallback },
  });
  const block = {
    assetId: "previous-native",
    kind: "json" as const,
    role: "reasoning",
    mediaType: "application/json",
    value: { opaque: "previous" },
  };
  const output = await callLlmAction.execute({
    ...baseInput,
    models: [
      { connection: "primary", model: "first-model" },
      { connection: "fallback", model: "custom-model" },
    ] as const,
    request: {
      messages: [{
        role: "assistant",
        content: [],
        nativeReasoning: {
          schema: "copilotz.llm-native-reasoning.v1",
          adapter: "custom",
          api: "custom.api",
          model: "custom-model",
          blocks: [block],
        },
      }],
    },
  }, test.context);

  const firstAssistant = firstRequest?.request.messages.find((message) =>
    message.role === "assistant"
  );
  const fallbackAssistant = fallbackRequest?.request.messages.find((message) =>
    message.role === "assistant"
  );
  assertEquals(firstAssistant?.nativeReasoning, undefined);
  assertEquals(fallbackAssistant?.nativeReasoning?.blocks, [
    { opaque: "previous" },
  ]);
  assertEquals(output.content, [
    pending(
      "capture:attempt:1:capture:content:0",
      test.captured[0].assets[0].mediaType,
      test.captured[0].assets[0].body,
    ),
  ]);
});

Deno.test("callLlm accepts plain strings as text message content", async () => {
  const assets = createMemoryAssetRepository();
  const resolver = createContentResolver({ assets });
  let seen: LlmAdapterCallInput | undefined;
  const test = fixture({
    llmConnections: { primary: { adapter: "provider" } },
    adapters: {
      provider: {
        call(input) {
          seen = input;
          return invocation({
            content: { type: "text", text: "ok" },
            attempts: [{ status: "completed" }],
          });
        },
      },
    },
  });
  const content = {
    ...test.context.content,
    authorize: (value: ContentRef) =>
      resolver.authorize(value, { namespace: "tenant-a" }),
    getMany: (ids: readonly string[]) => assets.getMany("tenant-a", ids),
    publish: (
      input: { mediaType: string; body: Uint8Array },
      options: { operationKey: string },
    ) =>
      assets.publish({
        ...input,
        namespace: "tenant-a",
        idempotencyKey: options.operationKey,
      }),
    resolveMany: (refs: readonly ContentRef[]) =>
      resolver.getMany(refs, { namespace: "tenant-a" }),
  } as unknown as LlmActionContext["content"];
  const durable: ActionEventData[] = [];
  const actions = createActionCallers({ callLlm: callLlmAction }, {
    createEffectClient: () => memoryEffects(),
    actionLifecycle: {
      emit(data) {
        durable.push(structuredClone(data));
        return Promise.resolve({ deduplicated: false } as never);
      },
      invoked: () => Promise.resolve(null),
      terminal: () => Promise.resolve(null),
    },
    content,
    signal: test.context.signal,
    createInvocationKey: () => "plain-strings",
    createContext(input) {
      return Object.freeze({
        ...test.context,
        content,
        action: Object.freeze({
          id: input.frame.actionId,
          runId: input.frame.actionRunId,
          metadata: input.frame.metadata,
        }),
        progress: input.progress,
      });
    },
  });
  const explicit = (value: string) => ({
    kind: "text" as const,
    role: "body",
    mediaType: "text/plain; charset=utf-8",
    value,
  });

  // The shorthand a caller would naturally write, in every place a message
  // holds content.
  await actions.callLlm({
    models: [{ connection: "primary", model: "provider-model" }],
    mode: "generate",
    request: {
      messages: [
        { role: "system", content: "You title chat rooms." },
        { role: "user", content: ["Name this: ", explicit("a chat")] },
      ],
    },
  } as unknown as LlmCallInput, { operationKey: "plain-strings" });
  assertEquals(
    seen?.request.messages.map((message) =>
      message.content.map((part) => part.type === "text" ? part.text : part)
    ),
    [["You title chat rooms."], ["Name this: ", "a chat"]],
  );
  const sent = durable.find((data) => data.status === "invoked");
  assert(sent);
  assertEquals((sent.input as LlmCallInput).request.messages, [
    { role: "system", content: [explicit("You title chat rooms.")] },
    { role: "user", content: [explicit("Name this: "), explicit("a chat")] },
  ]);

  // Shapes that are not text or entries are still rejected, as before.
  await assertRejects(
    () =>
      actions.callLlm({
        models: [{ connection: "primary", model: "provider-model" }],
        mode: "generate",
        request: { messages: [{ role: "user", content: 42 }] },
      } as unknown as LlmCallInput, { operationKey: "not-text" }),
    TypeError,
    "must be a sequence",
  );
});

Deno.test("misplaced credentials are rejected before any durable Action input is emitted", async () => {
  const test = fixture({ llmConnections: { primary: { adapter: "unused" } } });
  const durable: ActionEventData[] = [];
  const actions = createActionCallers({ callLlm: callLlmAction }, {
    createEffectClient: () => memoryEffects(),
    actionLifecycle: createActionLifecycleEmitter({
      namespace: "tenant-a",
      append(input) {
        durable.push(input.data);
        return Promise.resolve(undefined as never);
      },
    }),
    content: test.context.content,
    signal: test.context.signal,
    createInvocationKey: () => crypto.randomUUID(),
    createContext() {
      return test.context;
    },
  });
  const credential = "must-never-be-persisted";
  for (
    const selection of [
      { connection: "primary", model: "model", apiKey: credential },
      {
        connection: "primary",
        model: "model",
        options: { apiKey: credential },
      },
      {
        connection: "primary",
        model: "model",
        options: { auth: { apiKey: credential } },
      },
      {
        connection: "primary",
        model: "model",
        options: { extraHeaders: { Authorization: credential } },
      },
    ]
  ) {
    await assertRejects(() =>
      actions.callLlm({
        ...baseInput,
        models: [selection],
      } as LlmCallInput, { operationKey: crypto.randomUUID() })
    );
  }
  assertEquals(durable, []);
});

Deno.test("dynamic connection options are preflighted without resolving credentials", async () => {
  let providerCalls = 0;
  let resolverCalls = 0;
  const test = fixture({
    llmConnections: {
      primary: { adapter: "primary" },
      dynamic: {
        provider: "openai",
        auth: {
          resolve() {
            resolverCalls++;
            return { available: false };
          },
        },
      },
    },
    adapters: {
      primary: {
        call() {
          providerCalls++;
          return invocation({
            content: "never",
            attempts: [{ status: "completed" }],
          });
        },
      },
    },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...baseInput,
        mode: "session",
        models: [{ connection: "primary", model: "custom" }, {
          connection: "dynamic",
          model: "openai-model",
        }],
      }, test.context),
    TypeError,
    "does not implement LLM session mode",
  );
  assertEquals(providerCalls, 0);
  assertEquals(resolverCalls, 0);
});

function finalizationFixture(options: Partial<FixtureOptions> = {}) {
  let backupCalls = 0;
  const primary: LlmAdapter = {
    call() {
      return invocation(
        { content: "normalized answer", attempts: [{ status: "completed" }] },
        new ReadableStream({
          start(controller) {
            for (const lane of ["content", "reasoning", "tool-calls"]) {
              controller.enqueue({
                lane,
                mediaType: "text/plain",
                bytes: encoder.encode(`${lane} prefix`),
              });
            }
            controller.close();
          },
        }),
      );
    },
  };
  const backup: LlmAdapter = {
    call() {
      backupCalls++;
      return invocation({
        content: "backup",
        attempts: [{ status: "completed" }],
      });
    },
  };
  const test = fixture({
    llmConnections: {
      primary: { adapter: "primary" },
      backup: { adapter: "backup" },
    },
    adapters: { primary, backup },
    ...options,
  });
  return {
    ...test,
    backupCalls: () => backupCalls,
    run: async () =>
      await callLlmAction.execute({
        ...baseInput,
        models: [{ connection: "primary", model: "model-a" }, {
          connection: "backup",
          model: "model-b",
        }],
        stream: { id: "finalize" },
      }, test.context),
  };
}

Deno.test("llm.call disposes every sealed lane only after final capture and retention", async () => {
  const test = finalizationFixture({
    onDispose(stream) {
      assert(stream.closed && !stream.aborted);
      assertEquals(stream.retentions, [{ retention: "observation" }]);
      assertEquals(test.captured.length, 1);
    },
  });
  const output = await test.run();
  assertEquals(
    pendingId(output.content[0]),
    "capture:attempt:0:capture:content:0",
  );
  assertEquals(test.opened.length, 3);
  assert(
    test.opened.every((stream) => stream.disposed && stream.disposeCalls === 1),
  );
  assertEquals(test.backupCalls(), 0);
});

Deno.test("llm.call capture failure disposes all sealed writers and preserves the primary error", async () => {
  const primary = new Error("synthetic capture failure");
  const test = finalizationFixture({
    onCapture() {
      throw primary;
    },
  });
  assertStrictEquals(await assertRejects(test.run), primary);
  assertEquals(test.opened.length, 3);
  assert(
    test.opened.every((stream) =>
      stream.closed && !stream.aborted && stream.disposed &&
      stream.disposeCalls === 1
    ),
  );
  assertEquals(test.backupCalls(), 0);
});

Deno.test("llm.call partial seal failure aborts remaining lanes and disposes all opened writers", async () => {
  const primary = new Error("synthetic seal failure");
  const test = finalizationFixture({
    onClose(stream) {
      if (stream.input.metadata?.lane === "reasoning") throw primary;
    },
  });
  assertStrictEquals(await assertRejects(test.run), primary);
  const [sealed, failed, related] = test.opened;
  assert(sealed.closed && !sealed.aborted);
  assertEquals(failed.abortInput, { outcome: "failed", reason: "seal_failed" });
  assertEquals(related.abortInput, { reason: "related_stream_failed" });
  assert(!failed.closed && !related.closed);
  assert(
    test.opened.every((stream) => stream.disposed && stream.disposeCalls === 1),
  );
  assertEquals(test.captured.length, 0);
  assertEquals(test.backupCalls(), 0);
});

Deno.test("llm.call preserves primary and cleanup failures and awaits every disposer", async () => {
  const primary = new Error("synthetic capture failure");
  const cleanup = new Error("synthetic disposal failure");
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const test = finalizationFixture({
    onCapture() {
      throw primary;
    },
    onDispose(stream) {
      if (stream.input.metadata?.lane === "content") throw cleanup;
      if (stream.input.metadata?.lane === "reasoning") {
        entered.resolve();
        return release.promise;
      }
    },
  });
  let completed = false;
  const result = assertRejects(test.run, AggregateError).then((error) => {
    completed = true;
    return error;
  });
  try {
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(completed, false);
    assertEquals(test.opened.map((stream) => stream.disposeCalls), [1, 1, 1]);
    release.resolve();
    assertEquals((await result).errors, [primary, cleanup]);
    assertEquals(test.backupCalls(), 0);
  } finally {
    release.resolve();
    await result;
  }
});

Deno.test("llm.call does not release successful output when final disposal fails", async () => {
  const cleanup = new Error("synthetic disposal failure");
  const test = finalizationFixture({
    onDispose(stream) {
      if (stream.input.metadata?.lane === "content") throw cleanup;
    },
  });
  const failure = await assertRejects(
    test.run,
    AggregateError,
    "LLM stream disposal failed",
  );
  assertEquals(failure.errors, [cleanup]);
  assertEquals(test.captured.length, 1);
  assertEquals(test.opened.map((stream) => stream.disposeCalls), [1, 1, 1]);
  assertEquals(test.backupCalls(), 0);
});

Deno.test("llm.call partial seal and abort failures preserve all errors and still dispose", async () => {
  const seal = new Error("synthetic seal failure"),
    abort = new Error("synthetic abort failure"),
    cleanup = new Error("synthetic disposal failure");
  const test = finalizationFixture({
    onClose(stream) {
      if (stream.input.metadata?.lane === "reasoning") throw seal;
    },
    onAbort() {
      throw abort;
    },
    onDispose(stream) {
      if (stream.input.metadata?.lane === "content") throw cleanup;
    },
  });
  const failure = await assertRejects(test.run, AggregateError);
  assertEquals(failure.errors, [seal, abort, abort, cleanup]);
  assertEquals(test.opened.map((stream) => stream.disposeCalls), [1, 1, 1]);
  assertEquals(test.captured.length, 0);
  assertEquals(test.backupCalls(), 0);
});

Deno.test("llm.call preserves an undefined seal rejection while disposing every opened writer", async () => {
  const test = finalizationFixture({
    onClose() {
      return Promise.reject(undefined);
    },
  });
  let rejected = false;
  await test.run().then(() => {
    throw new Error("must reject");
  }, (error) => {
    rejected = true;
    assertEquals(error, undefined);
  });
  assert(rejected);
  assertEquals(test.opened.map((stream) => stream.disposeCalls), [1, 1, 1]);
  assert(test.opened.every((stream) => stream.disposed));
  assertEquals(test.backupCalls(), 0);
});

Deno.test("llm.call holds sealed handles until delayed final capture physically completes", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const test = finalizationFixture({
    onCapture() {
      entered.resolve();
      return release.promise;
    },
  });
  let completed = false;
  const result = test.run().then((output) => {
    completed = true;
    return output;
  });
  try {
    await entered.promise;
    assertEquals(completed, false);
    assertEquals(test.opened.map((stream) => stream.disposeCalls), [0, 0, 0]);
    assert(test.opened.every((stream) => stream.closed && !stream.aborted));
    release.resolve();
    const output = await result;
    assertEquals(
      pendingId(output.content[0]),
      "capture:attempt:0:capture:content:0",
    );
    assertEquals(test.opened.map((stream) => stream.disposeCalls), [1, 1, 1]);
  } finally {
    release.resolve();
    await result;
  }
});

for (const loss of ["seal", "confirmation receipt"] as const) {
  Deno.test(`a completed provider response survives a ${loss} deadline and replays full text without billing twice`, async () => {
    const { createTestDatabase } = await import(
      "../../../../runtime/testing/ominipg.ts"
    );
    const { provisionCopilotzSchema } = await import(
      "../../../../runtime/events/schema.ts"
    );
    const { createOwnerEffectClient } = await import(
      "../../../../runtime/actions/effect-commands.ts"
    );
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    });
    const schema = "llm_completion_replay";
    await provisionCopilotzSchema(db, schema);
    let calls = 0;
    const answer = "Complete streamed answer, including the final paragraph.\n"
      .repeat(50);
    const adapter: LlmAdapter = {
      call() {
        calls++;
        return invocation(
          {
            content: answer,
            attempts: [{ status: "completed", usage: { outputTokens: 51 } }],
            finishReason: "stop",
          },
          new ReadableStream({
            start(controller) {
              controller.enqueue({
                lane: "content",
                mediaType: "text/plain",
                bytes: new TextEncoder().encode(answer),
              });
              controller.close();
            },
          }),
        );
      },
    };
    const { ownerExecutionInterrupted } = await import(
      "../../../../runtime/execution/owner-interruption.ts"
    );
    const receipts = new Map<string, ActionEventData>();
    const lifecycle = createActionLifecycleEmitter({
      namespace: "tenant-a",
      append({ draft, data }) {
        receipts.set(draft.deduplicationId!, structuredClone(data));
        return Promise.resolve({ deduplicated: false } as never);
      },
      load: (_namespace, key) => Promise.resolve(receipts.get(key) ?? null),
    });
    let runId = "";
    let interruptConfirmation = loss === "confirmation receipt";
    const caller = (context: LlmActionContext) =>
      createActionCallers({ callLlm: callLlmAction }, {
        actionLifecycle: lifecycle,
        signal: context.signal,
        content: context.content,
        createInvocationKey: () => "replayed-call",
        createEffectClient(frame) {
          runId = frame.actionRunId;
          const client = createOwnerEffectClient({
            session: db,
            schema,
            namespace: "tenant-a",
            actionRunId: runId,
          });
          return {
            ...client,
            async confirm(step, outcome, options) {
              await client.confirm(step, outcome, options);
              if (interruptConfirmation) {
                interruptConfirmation = false;
                throw Object.assign(ownerExecutionInterrupted(), {
                  code: "deadline_exceeded",
                });
              }
            },
          };
        },
        createContext({ frame, progress }) {
          return {
            ...context,
            progress,
            action: {
              id: frame.actionId,
              runId: frame.actionRunId,
              metadata: frame.metadata,
            },
          };
        },
      }).callLlm;
    try {
      const first = fixture({
        llmConnections: { primary: { adapter: "provider" } },
        adapters: { provider: adapter },
        onClose() {
          if (loss !== "seal") return;
          throw Object.assign(ownerExecutionInterrupted(), {
            code: "deadline_exceeded",
          });
        },
      });
      await assertRejects(async () =>
        await caller(first.context)({ ...baseInput, stream: { id: "reply" } })
      );
      assertEquals(calls, 1);
      assertEquals(
        [...receipts.values()].filter((event) =>
          event.status === "failed" || event.status === "cancelled"
        ),
        [],
      );
      assertEquals(
        (await createOwnerEffectClient({
          session: db,
          schema,
          namespace: "tenant-a",
          actionRunId: runId,
        }).inspect("provider:0")).status,
        "replay",
      );
      // A fresh context/client models a different worker after delivery retry.
      const retry = fixture({
        llmConnections: { primary: { adapter: "provider" } },
        adapters: { provider: adapter },
      });
      const output = await caller(retry.context)({
        ...baseInput,
        stream: { id: "reply" },
      });
      assertEquals(
        [...receipts.values()].filter((event) => event.status === "completed")
          .length,
        1,
      );
      assertEquals(calls, 1);
      assertEquals(retry.opened.length, 0);
      assertEquals(
        new TextDecoder().decode(retry.captured[0].assets[0].body),
        answer,
      );
      assert(isPendingContentRef(output.content[0]));
      assertEquals(
        output.content[0].byteLength,
        new TextEncoder().encode(answer).length,
      );
      assertEquals(output.usage?.outputTokens, 51);
      // A duplicated delivery after recovery must also reuse the one receipt.
      await caller(retry.context)({ ...baseInput, stream: { id: "reply" } });
      assertEquals(calls, 1);
      assertEquals(
        [...receipts.values()].filter((event) => event.status === "completed")
          .length,
        1,
      );
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.close();
    }
  });
}

Deno.test("an empty provider completion fails visibly and stays checkpointed", async () => {
  let calls = 0;
  const test = fixture({
    llmConnections: { primary: { adapter: "provider" } },
    adapters: {
      provider: {
        call() {
          calls++;
          return invocation({
            content: "",
            attempts: [{ status: "completed" }],
            finishReason: "stop",
          });
        },
      },
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assertRejects(
      async () => await callLlmAction.execute(baseInput, test.context),
      Error,
      "without reply content",
    );
  }
  assertEquals(calls, 1);
  assertEquals(test.captured.length, 0);
});

Deno.test("retry preserves credential skips before a completed paid fallback", async () => {
  let resolutions = 0, calls = 0, lost = false;
  const test = fixture({
    llmConnections: {
      primary: {
        provider: "openai",
        auth: {
          resolve() {
            resolutions++;
            if (resolutions > 1) {
              throw new Error("retry must not re-resolve credentials");
            }
            return { available: false };
          },
        },
      },
      backup: { adapter: "backup" },
    },
    adapters: {
      backup: {
        call() {
          calls++;
          return invocation({
            content: "paid fallback answer",
            attempts: [{ status: "completed" }],
          });
        },
      },
    },
    onCapture() {
      if (!lost) {
        lost = true;
        throw new Error("delivery lost");
      }
    },
  });
  const input = {
    ...baseInput,
    models: [{ connection: "primary", model: "gpt-4o" }, {
      connection: "backup",
      model: "backup",
    }] as const,
  };
  await assertRejects(async () =>
    await callLlmAction.execute(input, test.context)
  );
  const output = await callLlmAction.execute(input, test.context);
  assertEquals(output.connection, "backup");
  assertEquals(resolutions, 1);
  assertEquals(calls, 1);
});

for (const status of [429, 503, 408, 401, 400]) {
  Deno.test(`provider HTTP ${status} uses a fresh dispatch only for retryable failures`, async () => {
    let calls = 0;
    const test = fixture({
      llmConnections: { primary: { adapter: "provider" } },
      adapters: {
        provider: {
          call() {
            calls++;
            return invocation(
              calls === 1
                ? Promise.reject(
                  Object.assign(new Error("provider rejected request"), {
                    status,
                    retryAfterMs: 1234,
                  }),
                )
                : {
                  content: "full answer",
                  attempts: [{ status: "completed" }],
                },
            );
          },
        },
      },
    });
    const failure = await assertRejects(() =>
      Promise.resolve(callLlmAction.execute(baseInput, test.context))
    ) as Error & { retryable: boolean; retryAfterMs: number };
    const retryable = [429, 503, 408].includes(status);
    assertEquals(failure.retryable, retryable);
    assertEquals(failure.retryAfterMs, 1234);
    if (retryable) {
      await callLlmAction.execute(baseInput, test.context);
      await callLlmAction.execute(baseInput, test.context);
      assertEquals(calls, 2);
    } else {
      await assertRejects(() =>
        Promise.resolve(callLlmAction.execute(baseInput, test.context))
      );
      assertEquals(calls, 1);
    }
  });
}

Deno.test("a paid fallback is reused before retrying an earlier transient provider failure", async () => {
  let primaryCalls = 0, backupCalls = 0, failedCapture = false;
  const test = fixture({
    llmConnections: {
      primary: { adapter: "primary" },
      backup: { adapter: "backup" },
    },
    adapters: {
      primary: {
        call() {
          primaryCalls++;
          return invocation(Promise.reject(new TypeError("fetch failed")));
        },
      },
      backup: {
        call() {
          backupCalls++;
          return invocation({
            content: "paid fallback",
            attempts: [{ status: "completed" }],
          });
        },
      },
    },
    onCapture() {
      if (!failedCapture) {
        failedCapture = true;
        throw new Error("capture lost");
      }
    },
  });
  const input = {
    ...baseInput,
    models: [{ connection: "primary", model: "first" }, {
      connection: "backup",
      model: "second",
    }] as const,
  };
  await assertRejects(() =>
    Promise.resolve(callLlmAction.execute(input, test.context))
  );
  const output = await callLlmAction.execute(input, test.context);
  assertEquals(output.connection, "backup");
  assertEquals(output.attempts?.map((a) => a.status), ["failed", "completed"]);
  assertEquals(primaryCalls, 1);
  assertEquals(backupCalls, 1);
});

Deno.test("a provider timeout before completion retries without becoming cancellation", async () => {
  const { LLMStreamTimeoutError } = await import("../../shared/errors.ts");
  let calls = 0;
  const test = fixture({
    llmConnections: { primary: { adapter: "provider" } },
    adapters: {
      provider: {
        call() {
          calls++;
          return invocation(
            calls === 1
              ? Promise.reject(new LLMStreamTimeoutError("first_token", 100))
              : {
                content: "answer after timeout",
                attempts: [{ status: "completed" }],
              },
          );
        },
      },
    },
  });
  const error = await assertRejects(() =>
    Promise.resolve(callLlmAction.execute(baseInput, test.context))
  ) as Error & { retryable: boolean; code: string };
  assertEquals(error.code, "llm_provider_timeout");
  assertEquals(error.message, "The model stopped responding.");
  assertEquals(error.retryable, true);
  await callLlmAction.execute(baseInput, test.context);
  assertEquals(calls, 2);
});

Deno.test("an interrupted visible stream retries with the full replacement answer", async () => {
  const failedResult = Promise.withResolvers<LlmAdapterResult>();
  let calls = 0;
  const test = fixture({
    llmConnections: { primary: { adapter: "provider" } },
    adapters: {
      provider: {
        call() {
          calls++;
          return calls === 1
            ? invocation(
              failedResult.promise,
              new ReadableStream({
                start(controller) {
                  controller.enqueue({
                    lane: "content",
                    mediaType: "text/plain",
                    bytes: encoder.encode("discarded partial"),
                  });
                  controller.close();
                },
              }),
            )
            : invocation({
              content: "The complete replacement answer.",
              attempts: [{ status: "completed" }],
            });
        },
      },
    },
    onAppend() {
      failedResult.reject(new TypeError("fetch failed"));
    },
  });
  const input = { ...baseInput, stream: { id: "reply" } };
  const error = await assertRejects(() =>
    Promise.resolve(callLlmAction.execute(input, test.context))
  ) as Error & { retryable: boolean };
  assertEquals(error.retryable, true);
  assertEquals(test.opened.length, 1);
  assertEquals(test.opened[0].aborted, true);
  await callLlmAction.execute(input, test.context);
  assertEquals(calls, 2);
  assertEquals(
    decoder.decode(test.captured.at(-1)!.assets[0].body),
    "The complete replacement answer.",
  );
});

Deno.test("credential resolution failure cannot mask a later provider rejection", async () => {
  const test = fixture({
    llmConnections: {
      missing: {
        provider: "openai",
        auth: {
          resolve() {
            throw new Error("account unavailable");
          },
        },
      },
      primary: { adapter: "provider" },
    },
    adapters: {
      provider: {
        call() {
          return invocation(
            Promise.reject(
              Object.assign(new Error("bad key"), { status: 401 }),
            ),
          );
        },
      },
    },
  });
  const failure = await assertRejects(() =>
    Promise.resolve(callLlmAction.execute({
      ...baseInput,
      models: [{ connection: "missing", model: "first" }, {
        connection: "primary",
        model: "second",
      }],
    }, test.context))
  ) as Error & { code: string; retryable: boolean };
  assertEquals(failure.code, "llm_provider_auth_error");
  assertEquals(failure.retryable, false);
});
