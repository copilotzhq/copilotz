import { assertEquals } from "@std/assert";
import { createCopilotz } from "../index.ts";
import type { ProviderResource } from "../types/resources.ts";

const fakeProvider: ProviderResource = {
  resourceType: "providers",
  kind: "text",
  id: "openai",
  create: () => ({
    endpoint: "https://fake.test/chat",
    headers: () => ({}),
    body: () => ({}),
    extractContent: (data: Record<string, unknown>) => {
      const choices = data.choices as
        | Array<{
          delta?: { content?: string };
        }>
        | undefined;
      const content = choices?.[0]?.delta?.content;
      return content ? [{ text: content }] : null;
    },
    extractFinishReason: (data: Record<string, unknown>) => {
      const choices = data.choices as Array<
        { finish_reason?: "stop" | "tool_calls" }
      >;
      return choices?.[0]?.finish_reason ?? null;
    },
  }),
};

Deno.test("ask creates a public question and answer before resuming the caller", async () => {
  const originalFetch = globalThis.fetch;
  const replies = [
    {
      content:
        '<tool_calls>\n{"name":"ask","arguments":{"agent":"b","message":"What is the answer?"}}\n</tool_calls>',
      finish: "tool_calls",
    },
    { content: "The answer is 42.", finish: "stop" },
    { content: "B says the answer is 42.", finish: "stop" },
  ] as const;
  let calls = 0;
  globalThis.fetch = () => {
    const reply = replies[calls++] ?? { content: "unexpected", finish: "stop" };
    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: { content: reply.content },
              finish_reason: reply.finish,
            }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };

  const runtime = {
    role: "assistant",
    llmOptions: {
      provider: "openai" as const,
      model: "fake",
      apiKey: "test",
      estimateCost: false,
    },
    assetOptions: { resolveInLLM: false },
  };
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    providers: [fakeProvider],
    agents: [
      { id: "a", name: "A", ...runtime, allowedAgents: ["b"] },
      { id: "b", name: "B", ...runtime, allowedAgents: [] },
    ],
  });

  try {
    const handle = await copilotz.run({
      content: "Start",
      sender: { externalId: "user", type: "user" },
      target: "a",
    });
    const outcome = await Promise.race([
      handle.done.then(
        () => "done",
        (error) =>
          `error:${error instanceof Error ? error.message : String(error)}`,
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timeout"), 8_000)
      ),
    ]);
    if (outcome !== "done") {
      const events = await copilotz.events.list({
        correlationId: handle.correlationId,
        limit: 50,
      });
      const deliveries = await copilotz.deliveries.list({
        correlationId: handle.correlationId,
        limit: 50,
      });
      console.error(JSON.stringify(
        {
          outcome,
          calls,
          events: events.map((event) => ({
            type: event.type,
            subject: event.subject,
            payloadStatus: (event.payload as Record<string, unknown>)?.status,
          })),
          deliveries: deliveries.map((delivery) => ({
            consumerId: delivery.consumerId,
            status: delivery.status,
            lastError: delivery.lastError?.message,
          })),
        },
        null,
        2,
      ));
      await handle.cancel("test_diagnostic");
      assertEquals(outcome, "done");
    }
    const events = await copilotz.events.list({
      correlationId: handle.correlationId,
    });
    const messages = events
      .filter((event) => event.type === "message.created")
      .map((event) => {
        const payload = event.payload as Record<string, unknown>;
        const record = (payload.record ?? payload) as Record<string, unknown>;
        return record.content;
      });
    assertEquals(calls, 3);
    assertEquals(messages, [
      "Start",
      "",
      "What is the answer?",
      "The answer is 42.",
      "B says the answer is 42.",
    ]);
  } finally {
    await copilotz.shutdown();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("nested asks remain public and resume each caller in order", async () => {
  const originalFetch = globalThis.fetch;
  const replies = [
    {
      content:
        '<tool_calls>\n{"name":"ask","arguments":{"agent":"b","message":"B, investigate."}}\n</tool_calls>',
      finish: "tool_calls",
    },
    {
      content:
        '<tool_calls>\n{"name":"ask","arguments":{"agent":"c","message":"C, provide the fact."}}\n</tool_calls>',
      finish: "tool_calls",
    },
    { content: "The fact from C.", finish: "stop" },
    { content: "B reports the fact from C.", finish: "stop" },
    { content: "A presents the final result.", finish: "stop" },
  ] as const;
  let calls = 0;
  globalThis.fetch = () => {
    const reply = replies[calls++] ?? { content: "unexpected", finish: "stop" };
    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: { content: reply.content },
              finish_reason: reply.finish,
            }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };
  const runtime = {
    role: "assistant",
    llmOptions: {
      provider: "openai" as const,
      model: "fake",
      apiKey: "test",
      estimateCost: false,
    },
    assetOptions: { resolveInLLM: false },
  };
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    providers: [fakeProvider],
    agents: [
      { id: "a", name: "A", ...runtime, allowedAgents: ["b"] },
      { id: "b", name: "B", ...runtime, allowedAgents: ["c"] },
      { id: "c", name: "C", ...runtime, allowedAgents: [] },
    ],
  });
  try {
    const handle = await copilotz.run({
      content: "Start nested work",
      sender: { externalId: "user", type: "user" },
      target: "a",
    });
    await handle.done;
    const messages = (await copilotz.events.list({
      correlationId: handle.correlationId,
    }))
      .filter((event) => event.type === "message.created")
      .map((event) => {
        const payload = event.payload as Record<string, unknown>;
        return ((payload.record ?? payload) as Record<string, unknown>).content;
      });
    assertEquals(calls, 5);
    assertEquals(messages, [
      "Start nested work",
      "",
      "B, investigate.",
      "",
      "C, provide the fact.",
      "The fact from C.",
      "B reports the fact from C.",
      "A presents the final result.",
    ]);
  } finally {
    await copilotz.shutdown();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("parallel asks settle one public batch before resuming the caller", async () => {
  const originalFetch = globalThis.fetch;
  const replies = [
    {
      content:
        '<tool_calls>\n{"name":"ask","arguments":{"agent":"b","message":"B question"}}\n{"name":"ask","arguments":{"agent":"c","message":"C question"}}\n</tool_calls>',
      finish: "tool_calls",
    },
    { content: "First public answer", finish: "stop" },
    { content: "Second public answer", finish: "stop" },
    { content: "Combined public result", finish: "stop" },
  ] as const;
  let calls = 0;
  globalThis.fetch = () => {
    const reply = replies[calls++] ?? { content: "unexpected", finish: "stop" };
    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: { content: reply.content },
              finish_reason: reply.finish,
            }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };
  const runtime = {
    role: "assistant",
    llmOptions: {
      provider: "openai" as const,
      model: "fake",
      apiKey: "test",
      estimateCost: false,
    },
    assetOptions: { resolveInLLM: false },
  };
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    providers: [fakeProvider],
    agents: [
      { id: "a", name: "A", ...runtime, allowedAgents: ["b", "c"] },
      { id: "b", name: "B", ...runtime, allowedAgents: [] },
      { id: "c", name: "C", ...runtime, allowedAgents: [] },
    ],
  });
  try {
    const handle = await copilotz.run({
      content: "Start parallel work",
      sender: { externalId: "user", type: "user" },
      target: "a",
    });
    await handle.done;
    const messages = (await copilotz.events.list({
      correlationId: handle.correlationId,
    }))
      .filter((event) => event.type === "message.created")
      .map((event) => {
        const payload = event.payload as Record<string, unknown>;
        return ((payload.record ?? payload) as Record<string, unknown>).content;
      });
    assertEquals(calls, 4);
    assertEquals(messages[0], "Start parallel work");
    assertEquals(messages.at(-1), "Combined public result");
    assertEquals(
      messages.filter((message) => message === "B question").length,
      1,
    );
    assertEquals(
      messages.filter((message) => message === "C question").length,
      1,
    );
    assertEquals(
      messages.filter((message) =>
        message === "First public answer" || message === "Second public answer"
      ).length,
      2,
    );
  } finally {
    await copilotz.shutdown();
    globalThis.fetch = originalFetch;
  }
});
