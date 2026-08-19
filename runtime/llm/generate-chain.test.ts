import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import type { ScopedPluginResources } from "../engine/index.ts";
import {
  generateChainFromResources,
  generateFromFactory,
  generateTargetsFromConfig,
  invocationFromChat,
  LLMProviderError,
  runGenerateChain,
  runSessionChain,
  sessionFromHandler,
} from "./index.ts";
import type {
  LlmFrame,
  LlmGenerate,
  LlmResult,
  ProviderConfig,
  ProviderRegistry,
} from "./index.ts";

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
  openai: () => ({
    endpoint: "https://example.test/openai",
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

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(
    "",
  );
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function llmResources(source: ProviderRegistry): ScopedPluginResources {
  const items = Object.fromEntries(
    Object.entries(source).map(([id, factory]) => [id, {
      id,
      type: "llm" as const,
      generate: generateFromFactory(id, factory),
    }]),
  );
  return {
    list: (type) => type === "llm" ? Object.values(items) : [],
    get: (type, id) => type === "llm" ? items[id] : undefined,
    require: (type, id) => {
      const resource = type === "llm" ? items[id] : undefined;
      if (!resource) throw new Error(`LLM resource '${id}' is not registered.`);
      return resource;
    },
    origin: () => undefined,
  } as ScopedPluginResources;
}

function chainResult(
  config: ProviderConfig,
  request: Parameters<typeof runGenerateChain>[1]["request"],
  env: Record<string, string> = {},
  source: ProviderRegistry = registry,
) {
  return runGenerateChain(
    generateChainFromResources(llmResources(source), config),
    { request, env },
  ).result;
}

Deno.test("generateTargetsFromConfig groups consecutive same-id fallbacks", () => {
  const targets = generateTargetsFromConfig({
    provider: "openai",
    model: "a",
    apiKey: "openai-secret",
    estimateCost: false,
    fallbacks: [
      { provider: "openai", model: "b" },
      { provider: "anthropic", model: "c" },
      { provider: "openai", model: "d" },
    ],
  });

  assertEquals(targets.map((target) => ({
    provider: target.provider,
    model: target.model,
    fallbacks: target.fallbacks?.map((fallback) => fallback.model),
    apiKey: target.apiKey,
  })), [
    {
      provider: "openai",
      model: "a",
      fallbacks: ["b"],
      apiKey: "openai-secret",
    },
    {
      provider: "anthropic",
      model: "c",
      fallbacks: undefined,
      apiKey: undefined,
    },
    {
      provider: "openai",
      model: "d",
      fallbacks: undefined,
      apiKey: "openai-secret",
    },
  ]);
});

Deno.test("runGenerateChain continues only on LLMCrossResourceFailover", async () => {
  const called: string[] = [];
  const generate = (id: string, result: Promise<LlmResult>): LlmGenerate =>
    (input) => {
      called.push(`${id}:${input.hasExternalFallback === true}`);
      return invocationFromChat(result);
    };

  const response = await runGenerateChain(
    [
      {
        config: { provider: "openai", model: "a" },
        generate: generate(
          "openai",
          Promise.reject(
            new LLMProviderError("switch", {
              reason: "provider_error",
              provider: "openai",
              usageAttempts: [],
              crossResourceFailover: true,
            }),
          ),
        ),
      },
      {
        config: { provider: "anthropic", model: "b" },
        generate: generate(
          "anthropic",
          Promise.resolve({
            answer: "ok",
            provider: "anthropic",
            model: "b",
          } as LlmResult),
        ),
      },
    ],
    { request: { messages: [{ role: "user", content: "hello" }] } },
  ).result;

  assertEquals(called, ["openai:true", "anthropic:false"]);
  assertEquals(response.answer, "ok");
  assertEquals(response.provider, "anthropic");
});

Deno.test("runGenerateChain does not continue on a generic throw", async () => {
  let secondCalled = false;
  await assertRejects(
    () =>
      runGenerateChain(
        [
          {
            config: { provider: "openai", model: "a" },
            generate: () =>
              invocationFromChat(
                Promise.reject(new LLMProviderError("boom", {
                  reason: "provider_error",
                  provider: "openai",
                })),
              ),
          },
          {
            config: { provider: "anthropic", model: "b" },
            generate: () => {
              secondCalled = true;
              return invocationFromChat(
                Promise.resolve({ answer: "ok" } as LlmResult),
              );
            },
          },
        ],
        { request: { messages: [{ role: "user", content: "hello" }] } },
      ).result,
    LLMProviderError,
  );
  assertEquals(secondCalled, false);
});

Deno.test("runGenerateChain materializes messages separately for each provider", async () => {
  const originalFetch = globalThis.fetch;
  const seenContents: string[] = [];
  let calls = 0;
  const source: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: () => ({}),
      body: (messages) => {
        seenContents.push(String(messages[0]?.content ?? ""));
        return {};
      },
      extractContent: () => null,
    }),
    openai: () => ({
      endpoint: "https://example.test/openai",
      headers: () => ({}),
      body: (messages) => {
        seenContents.push(String(messages[0]?.content ?? ""));
        return {};
      },
      extractContent: (data: any) => {
        const content = data?.choices?.[0]?.delta?.content;
        return typeof content === "string" && content.length > 0
          ? [{ text: content }]
          : null;
      },
    }),
  };

  globalThis.fetch = (url) => {
    calls += 1;
    if (String(url).includes("/anthropic")) {
      return Promise.resolve(
        new Response("bad anthropic request", {
          status: 400,
          statusText: "Bad Request",
        }),
      );
    }
    return Promise.resolve(
      sse([
        { choices: [{ delta: { content: "ok" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
  };

  try {
    const response = await chainResult(
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
        fallbacks: [{ provider: "openai", model: "fallback" }],
      },
      {
        messages: [{ role: "user", content: "hello" }],
        materializeMessages: (messages, config) =>
          messages.map((message) => ({
            ...message,
            content: `${message.content} via ${config.provider}`,
          })),
      },
      {},
      source,
    );

    assertEquals(response.answer, "ok");
    assertEquals(response.provider, "openai");
    assertEquals(calls, 2);
    assertEquals(seenContents, ["hello via anthropic", "hello via openai"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("runGenerateChain skips same-provider fallbacks for auth then uses the next resource", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;
  console.warn = () => {};
  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve(
        new Response("forbidden", {
          status: 403,
          statusText: "Forbidden",
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
    const response = await chainResult(
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
        fallbacks: [
          { provider: "anthropic", model: "same-provider-fallback" },
          { provider: "openai", model: "cross-provider-fallback" },
        ],
      },
      { messages: [{ role: "user", content: "hello" }] },
    );

    assertEquals(response.answer, "ok");
    assertEquals(response.provider, "openai");
    assertEquals(response.model, "cross-provider-fallback");
    assertEquals(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("runGenerateChain preserves billing details across a resource switch", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const calls: string[] = [];
  console.warn = () => {};
  globalThis.fetch = (url) => {
    calls.push(String(url));
    if (String(url).includes("/anthropic")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              type: "billing_error",
              code: "insufficient_quota",
              message: "Credit balance is too low",
              param: "account",
              internal_secret: "must-not-be-retained",
            },
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: { "content-type": "application/json" },
          },
        ),
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
    const response = await chainResult(
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "test",
        estimateCost: false,
        fallbacks: [
          { provider: "anthropic", model: "same-provider-fallback" },
          { provider: "openai", model: "cross-provider-fallback" },
        ],
      },
      { messages: [{ role: "user", content: "hello" }] },
    );

    assertEquals(response.answer, "ok");
    assertEquals(calls, [
      "https://example.test/anthropic",
      "https://example.test/openai",
    ]);
    assertEquals(response.usageAttempts?.[0]?.error?.reason, "billing_error");
    assertEquals(response.usageAttempts?.[0]?.error?.details, {
      type: "billing_error",
      code: "insufficient_quota",
      message: "Credit balance is too low",
      param: "account",
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("runGenerateChain resolves provider-specific api keys when the resource changes", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const source: ProviderRegistry = {
    anthropic: () => ({
      endpoint: "https://example.test/anthropic",
      headers: (config) => ({ "x-api-key": config.apiKey ?? "" }),
      body: () => ({}),
      extractContent: () => null,
    }),
    openai: () => ({
      endpoint: "https://example.test/openai",
      headers: (config) => ({ Authorization: `Bearer ${config.apiKey}` }),
      body: () => ({}),
      extractContent: (data: any) => {
        const content = data?.choices?.[0]?.delta?.content;
        return typeof content === "string" && content.length > 0
          ? [{ text: content }]
          : null;
      },
    }),
  };

  globalThis.fetch = (url, init?: RequestInit) => {
    const requestInit = init as { headers?: HeadersInit } | undefined;
    const headers = new Headers(requestInit?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get("authorization") ??
        headers.get("x-api-key"),
    });

    if (String(url).includes("/anthropic")) {
      return Promise.resolve(
        new Response("bad anthropic request", {
          status: 400,
          statusText: "Bad Request",
        }),
      );
    }

    if (headers.get("authorization") !== "Bearer openai-secret") {
      return Promise.resolve(
        new Response("wrong key", {
          status: 401,
          statusText: "Unauthorized",
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
    const response = await chainResult(
      {
        provider: "anthropic",
        model: "primary",
        apiKey: "anthropic-secret",
        estimateCost: false,
        fallbacks: [{ provider: "openai", model: "fallback" }],
      },
      { messages: [{ role: "user", content: "hello" }] },
      { OPENAI_API_KEY: "openai-secret" },
      source,
    );

    assertEquals(response.answer, "ok");
    assertEquals(response.provider, "openai");
    assertEquals(response.model, "fallback");
    assertEquals(calls.length, 2);
    assertEquals(calls[0].authorization, "anthropic-secret");
    assertEquals(calls[1].authorization, "Bearer openai-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sessionFromHandler and runSessionChain expose live frames", async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const session = sessionFromHandler(async (input, emit) => {
    const chunks: string[] = [];
    const reader = input.input?.getReader();
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(decoder.decode(next.value));
      }
    }
    const text = chunks.join("");
    emit({ type: "text", payload: text });
    emit({ type: "audio", payload: { bytes: encoder.encode("pcm"), mediaType: "audio/pcm" } });
    return {
      prompt: input.request.messages,
      answer: text,
      tokens: 0,
      provider: "openai",
      model: "session-model",
      finishReason: "stop",
    };
  });
  const invocation = runSessionChain(
    [{ config: { provider: "openai", model: "session-model" }, session }],
    {
      request: { messages: [{ role: "user", content: "hi" }] },
      input: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("hello"));
          controller.close();
        },
      }),
    },
  );
  const frames: LlmFrame[] = [];
  const pumping = (async () => {
    const reader = invocation.frames.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      frames.push(next.value);
    }
  })();
  const result = await invocation.result;
  await pumping;
  assertEquals(result.answer, "hello");
  assertEquals(frames, [
    { type: "text", payload: "hello" },
    { type: "audio", payload: { bytes: encoder.encode("pcm"), mediaType: "audio/pcm" } },
  ]);
});
