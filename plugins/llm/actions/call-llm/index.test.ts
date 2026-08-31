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
import {
  type ActionEventData,
  createActionCallers,
  createActionLifecycleEmitter,
} from "@copilotz/copilotz/actions";
import type {
  ContentStreamOpenInput,
  ContentStreamRetentionInput,
  ContentStreamWriter,
} from "@copilotz/copilotz/streams";
import {
  callLlmAction,
  LLM_CALL_ACTION_ALIAS,
  LLM_CALL_ACTION_ID,
  type LlmActionContext,
} from "./index.ts";
import {
  type LlmAdapter,
  LlmAdapterCallError,
  type LlmAdapterCallInput,
  type LlmAdapterFrame,
  type LlmAdapterResult,
  type LlmCallInput,
  type LlmCredentialResolution,
  type LlmCredentialResource,
  type ModelResource,
} from "../../internal/contracts.ts";
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

type OpenedStream = {
  input: ContentStreamOpenInput;
  appends: Uint8Array[];
  closed: boolean;
  aborted: boolean;
  retentions: ContentStreamRetentionInput[];
};

type FixtureOptions = Readonly<{
  models: Readonly<Record<string, ModelResource | undefined>>;
  llmCredentials?: Readonly<Record<string, LlmCredentialResource | undefined>>;
  adapters?: Readonly<Record<string, LlmAdapter | undefined>>;
  resolved?: Readonly<Record<string, ResolvedContent>>;
  signal?: AbortSignal;
  onAppend?: () => void;
  failStreamRetention?: boolean;
  preparedAssets?: boolean;
}>;

function fixtureDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${
    [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")
  }`;
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
      if (options.preparedAssets) {
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

  const context = {
    namespace: "tenant-a",
    operationKey: "operation-a",
    identity: Object.freeze({ correlationId: "correlation-a" }),
    resources: Object.freeze({
      models: options.models,
      ...(options.llmCredentials
        ? { llmCredentials: options.llmCredentials }
        : {}),
    }),
    adapters: options.adapters
      ? Object.freeze({ llm: options.adapters })
      : Object.freeze({}),
    actions: Object.freeze({}),
    collections: Object.freeze({}),
    content: Object.freeze({
      prepare,
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
            const bytes = new Uint8Array(record.appends.flatMap((item) => [
              ...item,
            ]));
            const digest = fixtureDigest(bytes);
            return Promise.resolve(Object.freeze({
              content: Object.freeze([
                ref(assetId, input.kind ?? "text", input.mediaType),
              ]),
              assets: options.preparedAssets
                ? Object.freeze([Object.freeze({
                  id: assetId,
                  namespace: "tenant-a",
                  mediaType: input.mediaType,
                  body: new Uint8Array(),
                  readyBody: Object.freeze({
                    bodyId: `stream-body:${input.id}`,
                    state: "ready" as const,
                    byteLength: bytes.byteLength,
                    mediaType: input.mediaType,
                    digest,
                    maintenanceVersion: 1,
                  }),
                  location: Object.freeze({
                    kind: "memory" as const,
                    backendId: "fixture",
                    key: `stream-body:${input.id}`,
                  }),
                  byteLength: bytes.byteLength,
                  digest,
                  idempotencyKey: `stream:${input.id}`,
                })])
                : Object.freeze([]),
            }));
          },
          abort() {
            record.aborted = true;
            return Promise.resolve();
          },
          retain(input: ContentStreamRetentionInput) {
            if (options.failStreamRetention) {
              throw new Error("stream retention failed");
            }
            record.retentions.push(Object.freeze({ ...input }));
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
    opened,
    resolvedRequests: () => resolvedRequests.map((values) => [...values]),
    inputFollowerCancelled: () => inputFollowerCancelled,
    progressCalls: () => progressCalls,
    progressValues: () => structuredClone(progressValues),
  };
}

const emptyInput = Object.freeze({
  models: Object.freeze(["primary"] as const),
  mode: "generate" as const,
  request: Object.freeze({ messages: Object.freeze([]) }),
}) satisfies LlmCallInput;

function model(
  adapter: string,
  name: string,
): ModelResource {
  return Object.freeze({
    adapter,
    model: name,
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

Deno.test("llm.call runs a built-in Model without adapters and never returns its profile secrets", async () => {
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
    models: {
      primary: {
        provider: "openai",
        model: "provider-model",
        apiKey: "built-in-secret",
        baseUrl: "https://account.example/v1",
        extraHeaders: { "X-Account": "primary" },
        options: { estimateCost: false, openaiApi: "chat_completions" },
      },
    },
  });
  try {
    const output = await callLlmAction.execute(emptyInput, test.context);
    assertEquals(requestedUrl, "https://account.example/v1/chat/completions");
    assertEquals(authorization, "Bearer built-in-secret");
    assertEquals(output.model, "primary");
    assertEquals(output.adapter, "openai");
    assertEquals(output.attempts?.[0]?.model, "primary");
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

Deno.test("resolved credentials never enter durable Action lifecycle data", async () => {
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
    models: {
      primary: {
        provider: "openai",
        model: "provider-model",
        credentials: "connected",
        baseUrl: "https://nonsecret-endpoint.example/v1",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      },
    },
    llmCredentials: {
      connected: {
        provider: "openai",
        resolve: () => ({
          available: true,
          apiKey: "ephemeral-resolver-secret",
          extraHeaders: { "X-Connected-Account": "account-secret" },
        }),
      },
    },
  });
  const lifecycleData: ActionEventData[] = [];
  const lifecycle = createActionLifecycleEmitter({
    namespace: "tenant-a",
    append(input) {
      lifecycleData.push(structuredClone(input.data));
      return Promise.resolve(undefined as never);
    },
  });
  const actions = createActionCallers({ callLlm: callLlmAction }, {
    actionLifecycle: lifecycle,
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
  const originalFetch = globalThis.fetch;
  let resolverCalls = 0;
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
    models: {
      primary: {
        provider: "openai",
        model: "gpt-primary",
        credentials: "connected",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      },
      backup: {
        provider: "openai",
        model: "gpt-backup",
        credentials: "connected",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      },
    },
    llmCredentials: {
      connected: {
        provider: "openai",
        resolve(context, execution) {
          resolverCalls += 1;
          seen.push({
            namespace: context.namespace,
            operationKey: context.operationKey,
            runId: context.action.runId,
            correlationId: context.identity.correlationId,
            credential: execution.credential,
          });
          return {
            available: true,
            apiKey: "oauth-secret",
            extraHeaders: { "X-Account": "account-1" },
          };
        },
      },
    },
  });
  try {
    const output = await callLlmAction.execute({
      ...emptyInput,
      models: ["primary", "backup"],
    }, test.context);
    assertEquals(resolverCalls, 1);
    assertEquals(providerCalls, 2);
    assertEquals(seen, [{
      namespace: "tenant-a",
      operationKey: "operation-a",
      runId: "run-a",
      correlationId: "correlation-a",
      credential: "connected",
    }]);
    assertEquals(output.model, "backup");
    assertEquals(
      JSON.stringify({ input: emptyInput, output }).includes("oauth-secret"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("an unavailable credential skips its Model without a provider attempt", async () => {
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
    models: {
      connected: {
        provider: "openai",
        model: "connected-model",
        credentials: "account",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      },
      backup: {
        provider: "openai",
        model: "backup-model",
        apiKey: "backup-secret",
        baseUrl: "https://backup.example/v1",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      },
    },
    llmCredentials: {
      account: {
        provider: "openai",
        resolve: () => ({ available: false, reason: "not connected" }),
      },
    },
  });
  try {
    const output = await callLlmAction.execute({
      ...emptyInput,
      models: ["connected", "backup"],
    }, test.context);
    assertEquals(providerCalls, 1);
    assertEquals(output.model, "backup");
    assertEquals(output.attempts?.map((attempt) => attempt.model), ["backup"]);
    assertEquals(JSON.stringify(output).includes("backup-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("an invalid dynamic credential result is sanitized and falls back", async () => {
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
      connected: {
        provider: "openai",
        model: "connected-model",
        credentials: "account",
      },
      backup: model("backup", "backup-model"),
    },
    llmCredentials: {
      account: {
        provider: "openai",
        resolve: () =>
          ({ available: true }) as unknown as LlmCredentialResolution,
      },
    },
    adapters: { backup },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: ["connected", "backup"],
  }, test.context);
  assertEquals(output.model, "backup");
  assertEquals(
    output.attempts?.map((attempt) => ({
      model: attempt.model,
      providerRequest: attempt.providerRequest,
      code: attempt.error?.code,
    })),
    [{
      model: "connected",
      providerRequest: false,
      code: "credential_unavailable",
    }, {
      model: "backup",
      providerRequest: true,
      code: undefined,
    }],
  );
});

Deno.test("settled attempts remain accounted when later credentials are unavailable", async () => {
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
    models: {
      primary: model("primary", "primary-model"),
      connected: {
        provider: "openai",
        model: "connected-model",
        credentials: "account",
      },
    },
    llmCredentials: {
      account: {
        provider: "openai",
        resolve: () => ({ available: false }),
      },
    },
    adapters: { primary },
  });

  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: ["primary", "connected"],
      }, test.context),
    Error,
    "No LLM credential is available",
  );
  assertEquals(test.progressValues(), [{
    schema: "copilotz.llm.attempt-accounting.v1",
    attempts: [{
      id: "run-a:attempt:0",
      index: 0,
      providerRequest: true,
      model: "primary",
      adapter: "primary",
      providerModel: "primary-model",
      status: "failed",
      usage: { inputTokens: 3, totalTokens: 3 },
      error: { message: "primary failed" },
    }],
  }]);
});

Deno.test("all unavailable credentials fail without a provider request", async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = () => {
    providerCalls += 1;
    throw new Error("provider must not be called");
  };
  const test = fixture({
    models: {
      connected: {
        provider: "openai",
        model: "connected-model",
        credentials: "account",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      },
    },
    llmCredentials: {
      account: {
        provider: "openai",
        resolve: () => ({ available: false }),
      },
    },
  });
  try {
    await assertRejects(
      async () =>
        await callLlmAction.execute(
          { ...emptyInput, models: ["connected"] },
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

Deno.test("credential aliases and providers are preflighted before provider I/O", async () => {
  let providerCalls = 0;
  const test = fixture({
    models: {
      first: {
        provider: "openai",
        model: "first-model",
        apiKey: "inline-secret",
        options: { estimateCost: false, openaiApi: "chat_completions" },
      },
      invalid: {
        provider: "anthropic",
        model: "second-model",
        credentials: "openai-credential",
      },
    },
    llmCredentials: {
      "openai-credential": { provider: "openai", apiKey: "shared-secret" },
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
          { ...emptyInput, models: ["first", "invalid"] },
          test.context,
        ),
      TypeError,
      "provider must match",
    );
    assertEquals(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
        models: ["primary"],
        mode: "generate",
        request: { messages: [{ role: "operator", content: [] }] },
      } as unknown as LlmCallInput, test.context),
    TypeError,
    "role",
  );
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        models: ["primary"],
        mode: "generate",
        request: { messages: [{ role: "user", content: ["inline"] }] },
      } as unknown as LlmCallInput, test.context),
    TypeError,
    "ContentRefs",
  );
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: ["primary", "primary"],
      }, test.context),
    TypeError,
    "duplicates",
  );
  assertEquals(calls, 0);
});

Deno.test("llm.call validates the complete candidate list before calling", async () => {
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
      primary: model("provider", "model-a"),
    },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: ["primary", "missing"],
      }, missing.context),
    Error,
    "Unknown LLM Model 'missing'",
  );

  const invalidAdapter = fixture({
    models: {
      primary: model("provider", "model-a"),
      backup: model("absent", "model-b"),
    },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: ["primary", "backup"],
      }, invalidAdapter.context),
    Error,
    "Unknown LLM adapter 'absent'",
  );

  const invalidProfile = fixture({
    models: {
      primary: model("provider", "model-a"),
      broken: {
        provider: "openai",
        model: "model-b",
        apiKey: "",
      } as ModelResource,
    },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: ["primary", "broken"],
      }, invalidProfile.context),
    TypeError,
    "apiKey",
  );

  const laterBuiltin = fixture({
    models: {
      primary: model("provider", "model-a"),
      builtin: { provider: "openai", model: "model-b" },
    },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: ["primary", "builtin"],
        options: { apiKey: "must-not-reach-a-provider" },
      }, laterBuiltin.context),
    TypeError,
    "Unsupported durable LLM provider option 'apiKey'",
  );
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: ["primary", "builtin"],
        mode: "session",
      }, laterBuiltin.context),
    TypeError,
    "does not implement LLM session mode",
  );
  assertEquals(calls, 0);
});

Deno.test("llm.call owns exact ordered candidate attempts", async () => {
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
      primary: model("provider", "first"),
      backup: model("provider", "second"),
      nested: model("provider", "third"),
      last: model("provider", "last"),
    },
    adapters: { provider: adapter },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: ["primary", "backup", "nested", "last"],
  }, test.context);
  assertEquals(calls, ["primary", "backup", "nested", "last"]);
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
      { id: "run-a:attempt:0", index: 0, model: "primary", status: "failed" },
      { id: "run-a:attempt:1", index: 1, model: "backup", status: "failed" },
      { id: "run-a:attempt:2", index: 2, model: "nested", status: "failed" },
      { id: "run-a:attempt:3", index: 3, model: "last", status: "completed" },
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
      primary: model("primary", "model-a"),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: ["primary", "backup"],
  }, test.context);
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
      model: attempt.model,
      adapter: attempt.adapter,
      providerModel: attempt.providerModel,
      status: attempt.status,
    })),
    [
      {
        index: 0,
        model: "primary",
        adapter: "primary",
        providerModel: "model-a",
        status: "failed",
      },
      {
        index: 1,
        model: "primary",
        adapter: "primary",
        providerModel: "model-a",
        status: "failed",
      },
      {
        index: 2,
        model: "backup",
        adapter: "backup",
        providerModel: "model-b",
        status: "failed",
      },
      {
        index: 3,
        model: "backup",
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
      primary: model("primary", "model-a"),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: ["primary", "backup"],
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
    models: ["primary"],
    mode: "session",
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

Deno.test("llm.call keeps attachments reference-only while preserving mixed content order", async () => {
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
    models: { primary: model("provider", "provider-model") },
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
        content: [textRef, exportedAttachment, defaultFile, inlineFile],
      }],
    },
  }, test.context);

  assertEquals(
    test.resolvedRequests().map((refs) => refs.map((item) => item.assetId)),
    [["text-a", "file-inline-a"]],
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
        'Copilotz attachment {"name":"render.png","mediaType":"image/png","assetRef":"asset://tenant-a/tool-export-a"}. Use an asset tool to retrieve or inspect this attachment; its body is not included in this LLM request.',
      role: "tool.output",
      mediaType: "text/plain; charset=utf-8",
      name: "render.png",
    },
    {
      type: "text",
      text:
        'Copilotz attachment {"name":"brief.pdf","mediaType":"application/pdf","assetRef":"asset://tenant-a/file-a"}. Use an asset tool to retrieve or inspect this attachment; its body is not included in this LLM request.',
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
  const attachment = Object.freeze({
    ...ref("attachment-a", "file", "application/pdf"),
    name: "private.pdf",
    disposition: "attachment" as const,
  });
  let seen: LlmAdapterCallInput | undefined;
  const test = fixture({
    models: { primary: model("provider", "provider-model") },
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
    request: { messages: [{ role: "user", content: [attachment] }] },
  }, test.context);

  assertEquals(test.resolvedRequests(), []);
  const part = seen?.request.messages[0].content[0];
  assertEquals(part?.type, "text");
  assert(!("bytes" in (part ?? {})));
  assert(!("file_data" in (part ?? {})));
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
  assertEquals(test.opened[0].appends.length, 1);
  assertEquals(test.opened[1].appends.length, 1);
  assert(test.opened.every((stream) => stream.closed && !stream.aborted));
  assertEquals(test.materialized.length, 1);
  assertEquals(test.progressCalls(), 0);
  assertEquals(output.content[0].assetId, "prepared:attempt:0:content:0");
  assert(!output.content[0].assetId.startsWith("stream:"));
});

Deno.test("llm.call reuses an exactly equivalent content stream Body", async () => {
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
    models: { primary: model("provider", "model-a") },
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
    preparedAssets: true,
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    stream: { id: "equivalent" },
  }, test.context);

  assertEquals(test.materialized.length, 1);
  const batch = test.materialized[0] as PreparedContent;
  assertEquals(batch.content[0].assetId, "prepared:attempt:0:content:0");
  assertEquals(batch.assets[0].id, "prepared:attempt:0:content:0");
  assertEquals(
    batch.assets[0].readyBody?.bodyId,
    "stream-body:equivalent:content:text_2Fplain_3B_20charset_3Dutf-8",
  );
  assertEquals(batch.assets[0].body.byteLength, 0);
  assertEquals(output.content, batch.content);
  assertEquals(test.opened[0].retentions, [{
    assetId: "prepared:attempt:0:content:0",
    retention: "canonical",
  }]);
});

Deno.test("llm.call retains a non-equivalent stream as an observation Body", async () => {
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
    models: { primary: model("provider", "model-a") },
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
    preparedAssets: true,
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    stream: { id: "different" },
  }, test.context);

  assertEquals(test.materialized.length, 1);
  const final = test.materialized[0] as PreparedContent;
  assertEquals(final.content[0].assetId, "prepared:attempt:0:content:0");
  assertEquals(output.content, final.content);
  assertEquals(test.opened[0].retentions.length, 1);
  assertEquals(test.opened[0].retentions[0].retention, "observation");
  assertEquals(
    test.opened[0].retentions[0].retention === "observation"
      ? test.opened[0].retentions[0].expiresAt
      : undefined,
    "2026-08-23T00:15:00.000Z",
  );
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
      primary: model("primary", "model-a"),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
    onAppend: appended,
  });

  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: ["primary", "backup"],
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
    models: {
      primary: model("primary", "model-a"),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: ["primary", "backup"],
  }, test.context);
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
      primary: model("primary", "model-a"),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
  });

  const output = await within(
    Promise.resolve(callLlmAction.execute({
      ...emptyInput,
      models: ["primary", "backup"],
    }, test.context)),
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
      primary: model("invalid", "model-a"),
      backup: model("backup", "model-b"),
    },
    adapters: { invalid, backup },
  });

  const output = await callLlmAction.execute({
    ...emptyInput,
    models: ["primary", "backup"],
  }, test.context);
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

Deno.test("llm.call drains a framework-rejected stream before fallback accounting", async () => {
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
    models: {
      primary: model("primary", "primary-model"),
      backup: model("backup", "backup-model"),
    },
    adapters: { primary, backup },
  });

  const executing = callLlmAction.execute({
    ...emptyInput,
    models: ["primary", "backup"],
  }, test.context);
  await Promise.resolve();
  releaseResult();
  const output = await executing;

  assert(backupObservedTerminalUsage);
  assertEquals(output.model, "backup");
  assertEquals(
    output.attempts?.map((attempt) => ({
      model: attempt.model,
      providerRequest: attempt.providerRequest,
      status: attempt.status,
      totalTokens: attempt.usage?.totalTokens,
    })),
    [
      {
        model: "primary",
        providerRequest: true,
        status: "failed",
        totalTokens: 5,
      },
      {
        model: "backup",
        providerRequest: true,
        status: "completed",
        totalTokens: 5,
      },
    ],
  );
});

Deno.test("llm.call drains invalid local frames before fallback accounting", async () => {
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
    models: {
      primary: model("primary", "primary-model"),
      backup: model("backup", "backup-model"),
    },
    adapters: { primary, backup },
  });

  const executing = callLlmAction.execute({
    ...emptyInput,
    models: ["primary", "backup"],
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
    [{ model: "primary", status: "failed", totalTokens: 8 }, {
      model: "backup",
      status: "completed",
      totalTokens: undefined,
    }],
  );
});

Deno.test("llm.call reports finalized attempts before a terminal framework failure", async () => {
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
    models: { primary: model("provider", "model") },
    adapters: { provider: adapter },
  });
  await assertRejects(
    async () => await callLlmAction.execute(emptyInput, test.context),
    Error,
    ".id",
  );
  assertEquals(test.progressValues(), [{
    schema: "copilotz.llm.attempt-accounting.v1",
    attempts: [{
      id: "run-a:attempt:0",
      index: 0,
      providerRequest: true,
      model: "primary",
      adapter: "provider",
      providerModel: "model",
      status: "failed",
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      error: {
        message:
          "LLM Adapter result.toolCalls[0].id must be a non-empty string.",
      },
    }],
  }]);
});

Deno.test("llm.call canonicalizes durable pipeline roots and bounds pipeline plans", async () => {
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
    models: { primary: model("valid", "model") },
    adapters: { valid },
  });
  const output = await callLlmAction.execute(emptyInput, accepted.context);
  assertEquals(output.toolCalls?.[0]?.pipeline?.stages[0], {
    type: "tool",
    id: "root",
    action: "extract",
    input: { a: 1, b: { x: true, y: false } },
  });

  const rejectsPlan = async (toolCalls: unknown, message: string) => {
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
      models: { primary: model("invalid", "model") },
      adapters: { invalid: adapter },
    });
    await assertRejects(
      async () => await callLlmAction.execute(emptyInput, test.context),
      TypeError,
      message,
    );
  };

  await rejectsPlan(
    Array.from({ length: 65 }, (_, index) => ({
      id: `call-${index}`,
      action: "search",
      input: {},
    })),
    "parallel branches",
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
  }], "at most 32 stages");
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
  }], "at most 16384 characters");
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
      primary: model("primary", "model-a"),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: ["primary", "backup"],
      }, test.context),
    DOMException,
    "cancelled",
  );
  assertEquals(backupCalls, 0);
});

Deno.test("llm.call settles every opened writer when stream retention fails", async () => {
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
      primary: model("primary", "model-a"),
      backup: model("backup", "model-b"),
    },
    adapters: { primary, backup },
    failStreamRetention: true,
  });
  await assertRejects(
    async () =>
      await callLlmAction.execute({
        ...emptyInput,
        models: ["primary", "backup"],
        stream: { id: "visible" },
      }, test.context),
    Error,
    "stream retention failed",
  );
  assertEquals(backupCalls, 0);
  assertEquals(test.opened.length, 2);
  assert(test.opened.every((stream) => stream.closed && !stream.aborted));
  assertEquals(test.progressValues(), [{
    schema: "copilotz.llm.attempt-accounting.v1",
    attempts: [{
      id: "run-a:attempt:0",
      index: 0,
      providerRequest: true,
      model: "primary",
      adapter: "primary",
      providerModel: "model-a",
      status: "completed",
    }],
  }]);
});
