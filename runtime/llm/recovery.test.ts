import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { chat } from "@/runtime/llm/index.ts";
import type {
  ExtractedPart,
  ProviderFinishReason,
  ProviderRegistry,
} from "@/runtime/llm/types.ts";

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(
    "",
  );
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const registry: ProviderRegistry = {
  anthropic: () => ({
    endpoint: "https://example.test/llm",
    headers: () => ({}),
    body: (messages) => ({ messages, stream: true }),
    extractContent: (data: any): ExtractedPart[] | null => {
      const content = data?.choices?.[0]?.delta?.content;
      return typeof content === "string" && content.length > 0
        ? [{ text: content }]
        : null;
    },
    extractFinishReason: (data: any): ProviderFinishReason | null => {
      const reason = data?.choices?.[0]?.finish_reason;
      if (reason === "length") return "length";
      if (reason === "stop") return "stop";
      return null;
    },
  }),
};

Deno.test("chat auto-continues length-truncated text in the same stream", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  const streamed: string[] = [];
  let calls = 0;

  globalThis.fetch = (_url, init) => {
    const body = (init as { body?: unknown } | undefined)?.body;
    bodies.push(JSON.parse(String(body)));
    calls += 1;
    return Promise.resolve(
      calls === 1
        ? sse([
          { choices: [{ delta: { content: "Hello" } }] },
          { choices: [{ delta: {}, finish_reason: "length" }] },
        ])
        : sse([
          { choices: [{ delta: { content: " world" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
    );
  };

  try {
    const response = await chat(
      { messages: [{ role: "user", content: "Say hello" }] },
      { provider: "anthropic", model: "test-model", apiKey: "test" },
      {},
      (chunk) => streamed.push(chunk),
      registry,
    );

    assertEquals(response.answer, "Hello world");
    assertEquals(response.finishReason, "stop");
    assertEquals(streamed.join(""), "Hello world");
    assertEquals(calls, 2);

    const secondBody = bodies[1] as { messages: Array<{ content: string }> };
    assert(
      secondBody.messages.at(-1)?.content.includes(
        "Continue the previous assistant response exactly where it stopped.",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("chat repairs truncated tool calls without streaming protocol markup", async () => {
  const originalFetch = globalThis.fetch;
  const streamed: string[] = [];
  let calls = 0;

  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(
      calls === 1
        ? sse([
          {
            choices: [{
              delta: {
                content:
                  'I will inspect it.\n<function_calls>\n{"name":"sandbox_session","arguments":{',
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "length" }] },
        ])
        : sse([
          {
            choices: [{
              delta: {
                content:
                  '<function_calls>\n{"name":"sandbox_session","arguments":{"sessionId":"s","actions":[]}}\n</function_calls>',
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
    );
  };

  try {
    const response = await chat(
      {
        messages: [{ role: "user", content: "Use the sandbox" }],
        tools: [{
          type: "function",
          function: {
            name: "sandbox_session",
            description: "Run sandbox actions",
            parameters: { type: "object", properties: {} },
          },
        }],
      },
      { provider: "anthropic", model: "test-model", apiKey: "test" },
      {},
      (chunk) => streamed.push(chunk),
      registry,
    );

    assertEquals(response.answer, "I will inspect it.");
    assertEquals(response.toolCalls?.length, 1);
    assertEquals(response.toolCalls?.[0].tool.id, "sandbox_session");
    assertEquals(calls, 2);
    assertEquals(streamed.join("").includes("<function_calls>"), false);
    assertEquals(response.answer.includes("<function_calls>"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
