import { assert, assertEquals, assertExists } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import type { Agent } from "../resources/index.ts";
import { createCopilotzEngine } from "../engine/index.ts";
import { createSqlSession } from "../events/index.ts";
import type {
  ChatRequest,
  ChatResponse,
  ProviderAPI,
  TokenUsage,
} from "../llm/types.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import {
  createAgentAskPlugin,
  createTextWorkflowPlugin,
  defineLlmProviderResource,
  type LlmChat,
  workflowMetadata,
} from "../workflows/index.ts";
import {
  type AttachmentOutput,
  type AttachmentStreamOutput,
  defineRealtimeProviderResource,
  type RealtimeAgentAskResult,
  type RealtimeToolCallResult,
} from "./index.ts";

const namespace = "tenant-realtime-context";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
}

function isStreamOutput(
  output: AttachmentOutput,
): output is AttachmentStreamOutput {
  return output.type === "stream.output" && "payload" in output &&
    output.payload instanceof ReadableStream;
}

async function nextStreamOutput(
  reader: ReadableStreamDefaultReader<AttachmentOutput>,
): Promise<AttachmentStreamOutput> {
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error("Attachment output ended unexpectedly.");
    if (isStreamOutput(next.value)) return next.value;
  }
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(result);
}

async function messageText(
  engine: Awaited<ReturnType<typeof createCopilotzEngine>>,
  message: NonNullable<
    Awaited<ReturnType<typeof engine.conversation.getMessage>>
  >,
): Promise<string> {
  const content = await engine.content.resolver.getMany(message.content, {
    namespace,
  });
  return content.map((item) =>
    item.text ?? (item.value === undefined ? "" : JSON.stringify(item.value))
  ).join("\n");
}

Deno.test("realtime context executes a tool and resumes without a text attempt", async () => {
  let providerResult: RealtimeToolCallResult | undefined;
  const realtime = defineRealtimeProviderResource({
    id: "realtime.tools",
    type: "realtime",
    async open(input) {
      assertExists(input.context);
      providerResult = await input.context.tool({
        tool: "weather",
        arguments: { city: "Lisbon" },
      });
      return {
        mediaType: "text/plain",
        output: encoder.encode(
          JSON.stringify(providerResult.output?.value),
        ),
      };
    },
  });
  const support: Agent = {
    id: "support",
    name: "Support",
    role: "Realtime support",
    allowedTools: ["weather"],
    runtimes: {
      realtime: { type: "realtime", provider: realtime.id },
    },
  };
  const weather = Object.freeze({
    id: "weather",
    key: "weather",
    name: "Weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    execute: (value: unknown) => ({
      city: (value as { city: string }).city,
      forecast: "sunny",
    }),
  });
  const app = definePlugin({
    manifest: {
      id: "test.realtime-tool",
      version: "1.0.0",
      provides: {
        agents: [support.id],
        providers: [realtime.id],
        tools: [weather.key],
      },
    },
    resources: {
      agents: [support],
      providers: [realtime],
      tools: [weather],
    },
  });
  const registry = await createPluginRegistry({
    plugins: [createTextWorkflowPlugin(), app],
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    schema: "copilotz_realtime_tool",
    execution: { capacity: 1 },
    attachments: { settlementPollMs: 1, streamCapacity: 1 },
  });
  try {
    await engine.conversation.createThread({
      namespace,
      id: "thread-a",
      participants: [
        {
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        },
        {
          id: "agent-support",
          externalId: "support",
          participantType: "agent",
          agentId: "support",
        },
      ],
    });
    const attachment = await engine.connect({
      namespace,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["support"],
    });
    const reader = attachment.outputs.getReader();
    const handle = await attachment.send({
      type: "audio.input",
      mediaType: "audio/pcm;rate=24000",
      payload: bytes("weather please"),
      correlationId: "realtime-tool",
    });
    const output = await nextStreamOutput(reader);
    assertEquals(
      JSON.parse(await readText(output.payload)),
      { city: "Lisbon", forecast: "sunny" },
    );
    await handle.done;
    assertExists(providerResult);
    assertEquals(providerResult.execution.status, "completed");
    assertEquals(providerResult.message.sender.participantType, "tool");
    assertEquals(
      workflowMetadata(providerResult.message.metadata)?.continuation,
      "realtime",
    );
    assertEquals(
      await engine.llmAttempts.list(namespace, "thread-a"),
      [],
    );
    const messages = await engine.conversation.listMessages(
      namespace,
      "thread-a",
    );
    assertEquals(messages.length, 1);
    assertEquals(messages[0].id, providerResult.message.id);
    await reader.cancel();
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

const usage: TokenUsage = {
  inputTokens: 4,
  outputTokens: 3,
  totalTokens: 7,
  source: "provider",
  status: "completed",
};

function textResponse(request: ChatRequest, answer: string): ChatResponse {
  return {
    prompt: request.messages,
    answer,
    tokens: usage.totalTokens ?? 0,
    usage,
    provider: "openai",
    model: "realtime-ask-model",
    finishReason: "stop",
  };
}

Deno.test("realtime context asks another agent publicly and resumes the stream", async () => {
  let askResult: RealtimeAgentAskResult | undefined;
  const realtime = defineRealtimeProviderResource({
    id: "realtime.ask",
    type: "realtime",
    async open(input) {
      assertExists(input.context);
      askResult = await input.context.ask({
        target: "expert",
        message: "What should we tell the user?",
      });
      const answer = askResult.answerContent?.map((item) => item.text ?? "")
        .join("") ?? "";
      await input.context.send({
        sender: "agent",
        content: `Realtime synthesis: ${answer}`,
      });
      return { mediaType: "text/plain", output: encoder.encode(answer) };
    },
  });
  const caller: Agent = {
    id: "caller",
    name: "Caller",
    role: "Realtime caller",
    allowedAgents: ["expert"],
    allowedTools: ["ask"],
    runtimes: {
      realtime: { type: "realtime", provider: realtime.id },
    },
  };
  const expert: Agent = {
    id: "expert",
    name: "Expert",
    role: "Text expert",
    instructions: "ACTIVE_AGENT=expert",
    allowedTools: [],
    llmOptions: { provider: "openai", model: "realtime-ask-model" },
  };
  const llm = defineLlmProviderResource({
    id: "openai",
    type: "llm",
    factory: () => ({}) as ProviderAPI,
  });
  let chatCalls = 0;
  const chat: LlmChat = async (request) => {
    chatCalls += 1;
    assert(JSON.stringify(request.messages).includes("ACTIVE_AGENT=expert"));
    assert(
      JSON.stringify(request.messages).includes(
        "What should we tell the user?",
      ),
    );
    return textResponse(request, "Expert public answer");
  };
  const app = definePlugin({
    manifest: {
      id: "test.realtime-ask",
      version: "1.0.0",
      provides: {
        agents: [caller.id, expert.id],
        providers: [realtime.id, llm.id],
      },
    },
    resources: {
      agents: [caller, expert],
      providers: [realtime, llm],
    },
  });
  const registry = await createPluginRegistry({
    plugins: [
      createTextWorkflowPlugin({ chat }),
      createAgentAskPlugin(),
      app,
    ],
  });
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    schema: "copilotz_realtime_ask",
    execution: { capacity: 1 },
    attachments: { settlementPollMs: 1, streamCapacity: 1 },
  });
  try {
    await engine.conversation.createThread({
      namespace,
      id: "thread-a",
      participants: [
        {
          id: "user-a",
          externalId: "user-a",
          participantType: "human",
        },
        {
          id: "agent-caller",
          externalId: "caller",
          participantType: "agent",
          agentId: "caller",
        },
        {
          id: "agent-expert",
          externalId: "expert",
          participantType: "agent",
          agentId: "expert",
        },
      ],
    });
    const attachment = await engine.connect({
      namespace,
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["caller"],
    });
    const reader = attachment.outputs.getReader();
    const handle = await attachment.send({
      type: "audio.input",
      mediaType: "audio/pcm;rate=24000",
      payload: bytes("ask the expert"),
      correlationId: "realtime-ask",
    });
    const output = await nextStreamOutput(reader);
    assertEquals(await readText(output.payload), "Expert public answer");
    await handle.done;
    assertEquals(chatCalls, 1);
    assertExists(askResult?.answer);
    assertEquals(
      await messageText(engine, askResult.answer),
      "Expert public answer",
    );
    const attempts = await engine.llmAttempts.list(namespace, "thread-a");
    assertEquals(attempts.length, 1);
    assertEquals(attempts[0].agentId, "expert");

    const messages = await engine.conversation.listMessages(
      namespace,
      "thread-a",
    );
    assertEquals(
      await Promise.all(
        messages.map((message) => messageText(engine, message)),
      ),
      [
        "What should we tell the user?",
        "Expert public answer",
        JSON.stringify({
          status: "answered",
          askId: askResult.execution.id.replace(/^/, "ask:"),
          questionMessageId: `message:${askResult.execution.id}:ask`,
          answerMessageId: askResult.answer.id,
          askedAgentId: "expert",
          askedParticipantId: "agent-expert",
        }),
        "Realtime synthesis: Expert public answer",
      ],
    );
    assertEquals(messages.map((message) => message.sender.participantType), [
      "agent",
      "agent",
      "tool",
      "agent",
    ]);
    assertEquals(
      workflowMetadata(askResult.message.metadata)?.continuation,
      "realtime",
    );
    await reader.cancel();
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

Deno.test("realtime context remains factory-first and runtime-neutral", async () => {
  const source = await Deno.readTextFile(
    new URL("context.ts", import.meta.url),
  );
  assert(!/\bDeno\b|\bBun\b|\bprocess\b/.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/\bclass\s+\w+/.test(source));
});
