import { assertEquals } from "@std/assert";
import {
  createCopilotz,
  type MemoryResource,
  type ProviderResource,
} from "../index.ts";
import type { ChatMessage } from "../runtime/llm/types.ts";

Deno.test("memory resources prepare event-native provider context inside delivery work", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: { content: "Memory applied." },
              finish_reason: "stop",
            }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

  let providerMessages: ChatMessage[] = [];
  const provider: ProviderResource = {
    resourceType: "providers",
    kind: "text",
    id: "memory-provider",
    create: () => ({
      endpoint: "https://fake.test/chat",
      headers: () => ({}),
      body: (messages) => {
        providerMessages = messages;
        return {};
      },
      extractContent: (data: Record<string, unknown>) => {
        const choices = data.choices as Array<{ delta?: { content?: string } }>;
        const content = choices?.[0]?.delta?.content;
        return content ? [{ text: content }] : null;
      },
      extractFinishReason: (data: Record<string, unknown>) => {
        const choices = data.choices as Array<{ finish_reason?: "stop" }>;
        return choices?.[0]?.finish_reason ?? null;
      },
    }),
  };
  let prepared = 0;
  const memory: MemoryResource = {
    id: "account-memory",
    name: "Account memory",
    kind: "custom",
    prepare(context) {
      prepared++;
      assertEquals(context.event.type, "llm_attempt.created");
      assertEquals(context.history.at(-1)?.content, "Use my account context");
      assertEquals(context.thread.externalId, "memory-thread");
      return [{
        role: "system",
        content: "Account tier: enterprise",
      }];
    },
  };
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    providers: [provider],
    memory: [memory],
    agents: [{
      id: "agent",
      name: "Agent",
      role: "Use memory",
      allowedAgents: [],
      runtimes: {
        text: { type: "llm", provider: provider.id, model: "fake" },
      },
      llmOptions: { apiKey: "test", estimateCost: false },
      assetOptions: { resolveInLLM: false },
    }],
  });

  try {
    const run = await copilotz.run({
      content: "Use my account context",
      sender: { externalId: "user", type: "user" },
      target: "agent",
    }, { thread: "memory-thread" });
    await run.done;
    assertEquals(prepared, 1);
    assertEquals(providerMessages.map((message) => message.content), [
      "You are Agent.\n\nUse memory\n\nAccount tier: enterprise",
      "Use my account context",
    ]);
  } finally {
    await copilotz.shutdown();
    globalThis.fetch = originalFetch;
  }
});
