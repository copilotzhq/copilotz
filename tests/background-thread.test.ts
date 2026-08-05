import { assert, assertEquals } from "@std/assert";
import {
  createCopilotz,
  type ProviderResource,
  type ThreadRecord,
} from "../index.ts";
import type { ChatMessage } from "../runtime/llm/types.ts";

function response(content: string, finishReason: "stop" | "tool_calls") {
  return new Response(
    `data: ${
      JSON.stringify({
        choices: [{ delta: { content }, finish_reason: finishReason }],
      })
    }\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

Deno.test("create_thread starts a separate event-native background workflow", async () => {
  const originalFetch = globalThis.fetch;
  let leadCalls = 0;
  globalThis.fetch = (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
    const system = String(body.messages[0]?.content ?? "");
    if (system.includes("You are Worker.")) {
      return Promise.resolve(response("Background complete.", "stop"));
    }
    leadCalls++;
    return Promise.resolve(
      leadCalls > 1 ? response("Background launched.", "stop") : response(
        '<tool_calls>\n{"name":"create_thread","arguments":{"name":"Research","participants":["worker"],"initialMessage":"Investigate this separately."}}\n</tool_calls>',
        "tool_calls",
      ),
    );
  };

  const provider: ProviderResource = {
    resourceType: "providers",
    kind: "text",
    id: "background-provider",
    create: () => ({
      endpoint: "https://fake.test/chat",
      headers: () => ({}),
      body: (messages) => ({ messages }),
      extractContent: (data: Record<string, unknown>) => {
        const choices = data.choices as Array<{
          delta?: { content?: string };
        }>;
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
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    providers: [provider],
    agents: [
      {
        id: "lead",
        name: "Lead",
        role: "Launch background work",
        allowedAgents: ["worker"],
        allowedTools: ["create_thread"],
        runtimes: {
          text: { type: "llm", provider: provider.id, model: "fake" },
        },
        llmOptions: { apiKey: "test", estimateCost: false },
        assetOptions: { resolveInLLM: false },
      },
      {
        id: "worker",
        name: "Worker",
        role: "Do the background work",
        allowedAgents: [],
        allowedTools: [],
        runtimes: {
          text: { type: "llm", provider: provider.id, model: "fake" },
        },
        llmOptions: { apiKey: "test", estimateCost: false },
        assetOptions: { resolveInLLM: false },
      },
    ],
  });

  try {
    const run = await copilotz.run({
      content: "Start background research",
      sender: { externalId: "user", type: "user" },
      target: "lead",
    }, { thread: "parent-thread" });
    await Promise.race([
      run.done,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("parent run did not settle")),
          5_000,
        )
      ),
    ]);

    let events = await copilotz.events.list({ namespace: "default" });
    for (
      let index = 0;
      index < 40 &&
      !events.some((event) =>
        event.type === "message.created" &&
        JSON.stringify(event.payload).includes("Background complete.")
      );
      index++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      events = await copilotz.events.list({ namespace: "default" });
    }

    const childEvent = events.find((event) => {
      if (event.type !== "thread.created") return false;
      return (event.payload as ThreadRecord).parentThreadId === run.threadId;
    });
    assert(childEvent);
    assert(childEvent.correlationId !== run.correlationId);
    assertEquals((childEvent.payload as ThreadRecord).name, "Research");
    assert(
      events.some((event) =>
        event.threadId === childEvent.threadId &&
        event.type === "message.created" &&
        JSON.stringify(event.payload).includes("Background complete.")
      ),
    );
    assert(
      events.some((event) =>
        event.correlationId === run.correlationId &&
        event.type === "message.created" &&
        JSON.stringify(event.payload).includes("Background launched.")
      ),
    );
  } finally {
    await copilotz.shutdown();
    globalThis.fetch = originalFetch;
  }
});
