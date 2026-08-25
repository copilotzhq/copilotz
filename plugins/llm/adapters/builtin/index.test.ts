import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";

import {
  type LlmAdapter,
  LlmAdapterCallError,
  type LlmAdapterCallInput,
  type LlmAdapterFrame,
  type LlmBuiltinModelResource,
  type LlmBuiltinProvider,
} from "../../internal/contracts.ts";
import { defineModel } from "../../resources/model/index.ts";
import { materializeBuiltinModel } from "./index.ts";

function builtin(
  provider: LlmBuiltinProvider,
  configuration: Partial<
    Omit<LlmBuiltinModelResource, "provider" | "model">
  > = {},
): LlmAdapter {
  const resource = defineModel({
    provider,
    model: "fixture-model",
    ...configuration,
  });
  if (resource.provider === undefined) {
    throw new Error("Expected built-in Model.");
  }
  return materializeBuiltinModel(
    resource,
    "generate",
    resource.options ?? {},
  );
}

function callInput(
  overrides: Partial<LlmAdapterCallInput> = {},
): LlmAdapterCallInput {
  return {
    model: "default",
    adapter: "openai",
    providerModel: "gpt-4o-mini",
    mode: "generate",
    fallbackAvailable: false,
    options: { estimateCost: false, openaiApi: "chat_completions" },
    request: {
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Say hello." }],
      }],
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collectFrames(
  stream: ReadableStream<LlmAdapterFrame>,
): Promise<LlmAdapterFrame[]> {
  const frames: LlmAdapterFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

function openAiStream(content: string, usage = true): Response {
  const events = [
    {
      choices: [{ delta: { content }, finish_reason: null }],
    },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      ...(usage
        ? {
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
          },
        }
        : {}),
    },
  ];
  const body = events.map((event) => "data: " + JSON.stringify(event) + "\n\n")
    .join("") + "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

Deno.test("all first-party Model providers materialize only the LlmAdapter call boundary", () => {
  const adapters = [
    builtin("openai"),
    builtin("anthropic"),
    builtin("gemini"),
    builtin("groq"),
    builtin("deepseek"),
    builtin("ollama"),
    builtin("minimax"),
  ];
  for (const adapter of adapters) {
    assertEquals(Object.keys(adapter), ["call"]);
    assertEquals(typeof adapter.call, "function");
  }
});

Deno.test("provider configuration stays Model-owned while frames and settled usage normalize", async () => {
  const originalFetch = globalThis.fetch;
  const extraHeaders = { "X-Application": "copilotz-test" };
  const seen: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
  globalThis.fetch = (input, init) => {
    seen.push({ url: String(input), init });
    return Promise.resolve(openAiStream("Hello"));
  };

  const adapter = builtin("openai", {
    apiKey: "captured-secret",
    baseUrl: "https://provider.example/v1",
    extraHeaders,
    options: {
      estimateCost: false,
      openaiApi: "chat_completions",
    },
  });
  extraHeaders["X-Application"] = "mutated";

  try {
    const invocation = adapter.call(callInput({
      options: {
        estimateCost: false,
        openaiApi: "chat_completions",
        temperature: 0.25,
      },
    }));
    const framesPromise = collectFrames(invocation.frames);
    const result = await invocation.result;
    const frames = await framesPromise;

    assertEquals(seen.length, 1);
    assertEquals(
      seen[0]?.url,
      "https://provider.example/v1/chat/completions",
    );
    const headers = new Headers(seen[0]?.init?.headers);
    assertEquals(headers.get("authorization"), "Bearer captured-secret");
    assertEquals(headers.get("x-application"), "copilotz-test");
    const requestBody = String(seen[0]?.init?.body);
    assertStringIncludes(requestBody, '"temperature":0.25');
    assertEquals(requestBody.includes("captured-secret"), false);

    assertEquals(
      frames
        .filter((frame) => frame.lane === "content")
        .map((frame) => new TextDecoder().decode(frame.bytes))
        .join(""),
      "Hello",
    );
    assertEquals(result.content, { type: "text", text: "Hello" });
    assertEquals(result.attempts[0]?.usage?.inputTokens, 5);
    assertEquals(result.attempts[0]?.usage?.outputTokens, 2);
    assertEquals(result.attempts[0]?.usage?.totalTokens, 7);
    assertEquals(JSON.stringify(result).includes("captured-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("separate built-in Models keep same-provider accounts and endpoints isolated", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<Readonly<{ url: string; authorization: string | null }>> =
    [];
  globalThis.fetch = (input, init) => {
    seen.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Promise.resolve(openAiStream("ok"));
  };
  const first = builtin("openai", {
    apiKey: "account-one-secret",
    baseUrl: "https://one.example/v1",
    options: { estimateCost: false, openaiApi: "chat_completions" },
  });
  const second = builtin("openai", {
    apiKey: "account-two-secret",
    baseUrl: "https://two.example/v1",
    options: { estimateCost: false, openaiApi: "chat_completions" },
  });

  try {
    for (const adapter of [first, second]) {
      const invocation = adapter.call(callInput());
      const frames = collectFrames(invocation.frames);
      await invocation.result;
      await frames;
    }
    assertEquals(seen, [{
      url: "https://one.example/v1/chat/completions",
      authorization: "Bearer account-one-secret",
    }, {
      url: "https://two.example/v1/chat/completions",
      authorization: "Bearer account-two-secret",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("first-party bridge defers two empty responses to external Model fallback", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(openAiStream(""));
  };
  const adapter = builtin("openai", {
    apiKey: "test",
    baseUrl: "https://provider.example/v1",
    options: { estimateCost: false, openaiApi: "chat_completions" },
  });

  try {
    const invocation = adapter.call(callInput({ fallbackAvailable: true }));
    const frames = collectFrames(invocation.frames);
    const error = await assertRejects(() => invocation.result);
    assert(error instanceof LlmAdapterCallError);
    assertEquals(calls, 2);
    assertEquals(error.attempts.map((attempt) => attempt.status), [
      "failed",
      "failed",
    ]);
    assertEquals(
      error.attempts.map((attempt) => attempt.usage?.totalTokens),
      [7, 7],
    );
    assertEquals(
      JSON.stringify(error.attempts).includes("Say hello."),
      false,
    );
    await assertRejects(() => frames);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("failed Model accounting awaits finalized usage and sanitizes provider errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    if (calls === 1) return Promise.resolve(openAiStream("END"));
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: { message: "raw-provider-secret" } }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  };
  const adapter = builtin("openai", {
    apiKey: "test",
    baseUrl: "https://provider.example/v1",
    options: { estimateCost: false, openaiApi: "chat_completions" },
  });

  try {
    const invocation = adapter.call(callInput({
      fallbackAvailable: true,
      options: {
        estimateCost: false,
        openaiApi: "chat_completions",
        stop: "END",
      },
    }));
    const frames = collectFrames(invocation.frames);
    const error = await assertRejects(() => invocation.result);
    assert(error instanceof LlmAdapterCallError);
    assertEquals(calls, 2);
    assertEquals(error.attempts[0]?.status, "failed");
    assertEquals(error.attempts[0]?.usage?.inputTokens, 5);
    assertEquals(error.attempts[0]?.usage?.outputTokens, 2);
    assertEquals(error.attempts[0]?.usage?.totalTokens, 7);
    assertEquals(
      JSON.stringify(error.attempts).includes("raw-provider-secret"),
      false,
    );
    await assertRejects(() => frames);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("provider option defaults are deeply snapshotted at construction", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = (_input, init) => {
    requestBody = String(init?.body);
    return Promise.resolve(
      new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };
  const thinking = { includeThoughts: true, thinkingBudget: 111 };
  const adapter = builtin("gemini", {
    apiKey: "test",
    options: {
      estimateCost: false,
      geminiThinkingConfig: thinking,
    },
  });
  thinking.thinkingBudget = 999;

  try {
    const invocation = adapter.call(callInput({
      adapter: "gemini",
      providerModel: "gemini-2.5-flash",
      options: { estimateCost: false },
    }));
    const framesPromise = collectFrames(invocation.frames);
    await invocation.result;
    await framesPromise;
    assertStringIncludes(requestBody, '"thinkingBudget":111');
    assertEquals(requestBody.includes('"thinkingBudget":999'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("durable options reject transport and credential fields before provider I/O", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(openAiStream("unexpected"));
  };

  try {
    const invocation = builtin("openai", {
      apiKey: "captured-secret",
      baseUrl: "https://provider.example/v1",
    }).call(callInput({
      options: {
        apiKey: "durable-secret",
        baseUrl: "https://attacker.example/v1",
      },
    }));
    await assertRejects(
      () => invocation.result,
      TypeError,
      "Transport and credentials belong to built-in Model configuration",
    );
    await assertRejects(() => collectFrames(invocation.frames));
    assertEquals(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("provider tool names normalize to Action aliases in frames and result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      openAiStream(
        'I will look.\n<tool_calls>\n{"name":"search","arguments":{"q":"news"}}\n</tool_calls>',
        false,
      ),
    );

  try {
    const adapter = builtin("openai", {
      apiKey: "test",
      baseUrl: "https://provider.example/v1",
      options: { estimateCost: false, openaiApi: "chat_completions" },
    });
    const invocation = adapter.call(callInput({
      request: {
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Find news." }],
        }],
        tools: [{
          name: "search",
          description: "Search the web.",
          inputSchema: {
            type: "object",
            properties: {
              q: { type: "string" },
            },
          },
        }],
      },
    }));
    const framesPromise = collectFrames(invocation.frames);
    const result = await invocation.result;
    const frames = await framesPromise;

    assertEquals(result.toolCalls?.length, 1);
    const call = result.toolCalls?.[0];
    assert(call);
    assertEquals(call.action, "search");
    assertEquals(call.input, { q: "news" });
    assertEquals(call.pipeline, {
      id: call.id,
      stages: [{
        type: "tool",
        id: call.id,
        action: "search",
        input: { q: "news" },
      }],
    });
    const toolFrames = frames
      .filter((frame) => frame.lane === "tool-calls")
      .map((frame) => new TextDecoder().decode(frame.bytes))
      .join("");
    assertStringIncludes(toolFrames, '"action":"search"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("caller cancellation remains an AbortError and never becomes a provider failure", async () => {
  const controller = new AbortController();
  controller.abort("cancelled by caller");
  const invocation = builtin("openai", { apiKey: "unused" }).call(
    callInput({ signal: controller.signal }),
  );
  const error = await assertRejects(() => invocation.result);
  assert(error instanceof Error);
  assertEquals(error.name, "AbortError");
  await assertRejects(() => collectFrames(invocation.frames));
});

Deno.test("built-in HTTP providers reject unsupported live-session mode explicitly", async () => {
  const invocation = builtin("gemini", { apiKey: "unused" }).call(
    callInput({
      adapter: "gemini",
      providerModel: "gemini-2.5-flash",
      mode: "session",
    }),
  );
  await assertRejects(
    () => invocation.result,
    TypeError,
    "does not implement LLM session mode",
  );
  await assertRejects(() => collectFrames(invocation.frames));

  const streamedInput = builtin("openai", { apiKey: "unused" }).call(
    callInput({
      input: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    }),
  );
  await assertRejects(
    () => streamedInput.result,
    TypeError,
    "does not implement live input streaming",
  );
  await assertRejects(() => collectFrames(streamedInput.frames));
});
