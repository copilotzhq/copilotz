import { assertEquals } from "@std/assert";
import { createCopilotz, type Tool } from "../index.ts";
import type { ProviderResource } from "../types/resources.ts";

const fakeProvider: ProviderResource = {
  resourceType: "providers",
  kind: "text",
  id: "tool-test-provider",
  create: () => ({
    endpoint: "https://fake.test/chat",
    headers: () => ({}),
    body: () => ({}),
    extractContent: (data: Record<string, unknown>) => {
      const choices = data.choices as Array<{ delta?: { content?: string } }>;
      const content = choices?.[0]?.delta?.content;
      return content ? [{ text: content }] : null;
    },
    extractFinishReason: (data: Record<string, unknown>) => {
      const choices = data.choices as Array<{
        finish_reason?: "stop" | "tool_calls";
      }>;
      return choices?.[0]?.finish_reason ?? null;
    },
  }),
};

Deno.test("parallel tools resume once and preserve result visibility", async () => {
  const originalFetch = globalThis.fetch;
  const replies = [
    {
      content:
        '<tool_calls>\n{"name":"public_tool","arguments":{"value":"public"}}\n{"name":"private_tool","arguments":{"value":"private"}}\n</tool_calls>',
      finish: "tool_calls",
    },
    { content: "Both tools completed.", finish: "stop" },
  ] as const;
  let providerCalls = 0;
  globalThis.fetch = () => {
    const reply = replies[providerCalls++] ?? {
      content: "unexpected",
      finish: "stop",
    };
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

  let active = 0;
  let maximumActive = 0;
  const tool = (
    id: string,
    visibility: "public" | "requester_only",
  ): Tool => ({
    id,
    key: id,
    name: id,
    description: id,
    inputSchema: { type: "object" },
    historyPolicy: { visibility },
    async execute(args) {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active--;
      return args;
    },
  });
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    providers: [fakeProvider],
    tools: [
      tool("public_tool", "public"),
      tool("private_tool", "requester_only"),
    ],
    agents: [{
      id: "agent",
      name: "Agent",
      role: "Use both tools",
      allowedAgents: [],
      allowedTools: ["public_tool", "private_tool"],
      runtimes: {
        text: {
          type: "llm",
          provider: "tool-test-provider",
          model: "fake",
        },
      },
      llmOptions: {
        apiKey: "test",
        estimateCost: false,
      },
      assetOptions: { resolveInLLM: false },
    }],
  });
  try {
    const run = await copilotz.run({
      content: "Use the tools",
      sender: { externalId: "user", type: "user" },
      target: "agent",
    });
    const visible = (async () => {
      const contents: unknown[] = [];
      for await (const event of run.events) {
        if (event.type !== "message.created") continue;
        const payload = event.payload as Record<string, unknown>;
        contents.push(
          ((payload.record ?? payload) as Record<string, unknown>).content,
        );
      }
      return contents;
    })();
    await run.done;
    const visibleContents = await visible;

    assertEquals(providerCalls, 2);
    assertEquals(maximumActive, 2);
    assertEquals(visibleContents.includes('{"value":"public"}'), true);
    assertEquals(visibleContents.includes('{"value":"private"}'), false);
    assertEquals(visibleContents.at(-1), "Both tools completed.");

    const persistedMessages = (await copilotz.events.list({
      correlationId: run.correlationId,
    })).filter((event) => event.type === "message.created");
    assertEquals(persistedMessages.length, 5);
    assertEquals(
      persistedMessages.filter((event) => event.visibility.kind === "tool")
        .map((event) =>
          event.visibility.kind === "tool" ? event.visibility.policy : null
        ).toSorted(),
      ["public", "requester_only"],
    );
  } finally {
    await copilotz.shutdown();
    globalThis.fetch = originalFetch;
  }
});
