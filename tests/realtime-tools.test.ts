import { assert, assertEquals } from "@std/assert";
import {
  createCopilotz,
  type RealtimeProviderResource,
  type Tool,
} from "../index.ts";
import type { DurableEvent } from "../events/types.ts";
import type { MessageRecord, ProviderResource } from "../types/resources.ts";

function recordOf<T>(event: DurableEvent): T {
  const payload = event.payload as Record<string, unknown>;
  return (payload.record ?? payload) as T;
}

const textProvider: ProviderResource = {
  resourceType: "providers",
  kind: "text",
  id: "realtime-tool-text",
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
      const choices = data.choices as Array<{ finish_reason?: "stop" }>;
      return choices?.[0]?.finish_reason ?? null;
    },
  }),
};

Deno.test("realtime tools and public asks return to the active provider event feed", async () => {
  const originalFetch = globalThis.fetch;
  let textCalls = 0;
  globalThis.fetch = () => {
    textCalls++;
    return Promise.resolve(
      new Response(
        `data: ${
          JSON.stringify({
            choices: [{
              delta: { content: "B's public realtime answer." },
              finish_reason: "stop",
            }],
          })
        }\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  };

  const observedByRealtime: string[] = [];
  const realtimeProvider: RealtimeProviderResource = {
    resourceType: "providers",
    kind: "realtime",
    id: "realtime-tool-provider",
    async *run(input) {
      for await (const _chunk of input.payload) {
        // Consuming the stream preserves input backpressure.
      }
      yield {
        kind: "message",
        input: {
          content: "",
          sender: { id: "a", type: "agent", name: "A" },
          toolCalls: [
            {
              id: "echo-call",
              tool: { id: "echo" },
              args: { value: "from realtime" },
            },
            {
              id: "ask-call",
              tool: { id: "ask" },
              args: { agent: "b", message: "B, answer in public." },
            },
          ],
        },
      };

      let sawToolResult = false;
      let sawAskAnswer = false;
      for await (const event of input.events) {
        if (event.type !== "message.created") continue;
        const message = recordOf<MessageRecord>(event);
        if (
          message.senderType === "tool" &&
          message.content === '{"value":"from realtime"}'
        ) {
          sawToolResult = true;
          observedByRealtime.push("tool");
        }
        if (
          message.senderType === "agent" &&
          message.content === "B's public realtime answer."
        ) {
          sawAskAnswer = true;
          observedByRealtime.push("ask");
        }
        if (sawToolResult && sawAskAnswer) break;
      }

      yield {
        kind: "message",
        input: {
          content: "Realtime continued after the tool and public ask.",
          sender: { id: "a", type: "agent", name: "A" },
        },
      };
    },
  };
  const echo: Tool = {
    id: "echo",
    key: "echo",
    name: "Echo",
    description: "Returns its input.",
    execute: (args) => args,
  };
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    providers: [textProvider, realtimeProvider],
    tools: [echo],
    agents: [
      {
        id: "a",
        name: "A",
        role: "Realtime caller",
        allowedAgents: ["b"],
        allowedTools: ["echo", "ask"],
        runtimes: {
          realtime: {
            type: "realtime",
            provider: realtimeProvider.id,
          },
        },
      },
      {
        id: "b",
        name: "B",
        role: "Text specialist",
        allowedAgents: [],
        runtimes: {
          text: { type: "llm", provider: textProvider.id, model: "fake" },
        },
        llmOptions: { apiKey: "test", estimateCost: false },
        assetOptions: { resolveInLLM: false },
      },
    ],
  });

  try {
    const attachment = await copilotz.connect({
      thread: "realtime-tools",
      participant: { externalId: "user", participantType: "human" },
    });
    const sent = await attachment.send({
      type: "audio.input",
      mediaType: "audio/pcm;rate=24000",
      payload: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      target: "a",
    });
    assert("streamId" in sent);
    await sent.done;

    const events = await copilotz.events.list({
      correlationId: sent.correlationId,
    });
    const messages = events.filter((event) => event.type === "message.created")
      .map((event) => recordOf<MessageRecord>(event));
    const attempts = events.filter((event) =>
      event.type === "llm_attempt.created"
    );
    const deadLetters = await copilotz.deliveries.list({
      correlationId: sent.correlationId,
      status: "dead_letter",
    });

    assertEquals(textCalls, 1);
    assertEquals(observedByRealtime.toSorted(), ["ask", "tool"]);
    assertEquals(
      messages.map((message) => message.content),
      [
        "",
        "B, answer in public.",
        '{"value":"from realtime"}',
        "B's public realtime answer.",
        "Realtime continued after the tool and public ask.",
      ],
    );
    assertEquals(attempts.length, 1);
    assertEquals(
      (recordOf<Record<string, unknown>>(attempts[0])).agentId,
      "b",
    );
    assertEquals(deadLetters.length, 0);
    await attachment.close();
  } finally {
    await copilotz.shutdown();
    globalThis.fetch = originalFetch;
  }
});
