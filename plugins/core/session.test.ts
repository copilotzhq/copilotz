import { assertEquals, assertExists } from "@std/assert";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectLlmAttempts,
  projectMessageById,
  projectMessages,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
  projectToolExecutionById,
  projectToolExecutions,
} from "../../runtime/testing/projections.ts";

import type { Agent } from "../../runtime/resources/index.ts";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import type { ContentInput } from "../../runtime/content/index.ts";
import { createSqlSession } from "../../runtime/events/index.ts";
import {
  type CopilotzEngine,
  createCopilotzEngine,
} from "../../runtime/engine/index.ts";
import {
  COPILOTZ_STREAM_WORKLOAD,
  jsonStreamDispatchMetadata,
} from "../../runtime/streams/index.ts";
import {
  createPluginRegistry,
  definePlugin,
} from "../../runtime/plugins/index.ts";
import { corePlugin } from "@copilotz/copilotz/plugins/core";
import {
  defineLlmProviderResource,
  type LlmSession,
  sessionFromHandler,
} from "@copilotz/copilotz/llm";
import type { ChatResponse } from "../../runtime/llm/types.ts";

const TEST_SCHEMA = "copilotz_session_workflow";
const NAMESPACE = "tenant-a";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const echoAgent: Agent = {
  id: "echo",
  name: "echo",
  role: "assistant",
  instructions: "You are echo.",
  runtime: {
    mode: "session",
    provider: "openai",
    model: "session-model",
  },
};

type Fixture = Readonly<{
  engine: CopilotzEngine;
  close(): Promise<void>;
}>;

function sessionResponse(
  input: { request: { messages: ChatResponse["prompt"] } },
  answer: string,
): ChatResponse {
  return {
    prompt: input.request.messages,
    answer,
    tokens: 0,
    provider: "openai",
    model: "session-model",
    finishReason: "stop",
  };
}

async function createFixture(session: LlmSession): Promise<Fixture> {
  const db = await createTestDatabase({ url: ":memory:" });
  const provider = defineLlmProviderResource({
    id: "openai",
    type: "llm",
    session,
  });
  const app = definePlugin({
    manifest: {
      id: "test.session-workflow.resources",
      version: "1.0.0",
      provides: {
        agents: [echoAgent.id],
        llm: [provider.id],
      },
    },
    resources: {
      agents: [echoAgent],
      llm: [provider],
    },
  });
  const registry = await createPluginRegistry({
    plugins: [corePlugin, app],
  });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: TEST_SCHEMA,
    retryBaseMs: 0,
    random: () => 0,
  });
  return Object.freeze({
    engine,
    async close() {
      await engine.shutdown();
      await db.close();
    },
  });
}

function boundCollection(engine: CopilotzEngine, name: string) {
  const collection = engine.collectionRuntime.get(name);
  if (!collection) throw new Error(`Collection '${name}' is not bound.`);
  return collection;
}

async function persistPreparedContent(
  engine: CopilotzEngine,
  prepared: Awaited<
    ReturnType<CopilotzEngine["content"]["preparer"]["prepare"]>
  >,
) {
  for (const asset of prepared.assets) {
    if (await engine.content.assets.get(asset.namespace, asset.id)) continue;
    await engine.content.assets.publish({
      namespace: asset.namespace,
      id: asset.id,
      mediaType: asset.mediaType,
      body: asset.body,
      ...(asset.idempotencyKey ? { idempotencyKey: asset.idempotencyKey } : {}),
      ...(asset.origin ? { origin: asset.origin } : {}),
      ...(asset.metadata ? { metadata: { ...asset.metadata } } : {}),
    });
  }
  return prepared.content;
}

async function createThread(fixture: Fixture): Promise<void> {
  const namespace = NAMESPACE;
  await boundCollection(fixture.engine, "participant").create({
    id: "user-a",
    externalId: "user-a",
    participantType: "human",
    metadata: {},
  }, { namespace });
  await boundCollection(fixture.engine, "participant").create({
    id: "agent-echo",
    externalId: echoAgent.id,
    participantType: "agent",
    agentId: echoAgent.id,
    metadata: {},
  }, { namespace });
  await boundCollection(fixture.engine, "thread").create({
    id: "thread-a",
    participantIds: ["user-a", "agent-echo"],
    metadata: {},
  }, {
    namespace,
    identity: { deduplicationId: "thread-a:create" },
  });
}

async function createUserMessage(
  fixture: Fixture,
  content: ContentInput | readonly ContentInput[],
  id: string,
) {
  const prepared = await fixture.engine.content.preparer.prepare(content, {
    namespace: NAMESPACE,
    idempotencyKey: `${id}:body`,
  });
  return await boundCollection(fixture.engine, "message").create({
    id,
    threadId: "thread-a",
    senderId: "user-a",
    recipientIds: ["agent-echo"],
    content: await persistPreparedContent(fixture.engine, prepared),
    metadata: {},
  }, {
    namespace: NAMESPACE,
    threadId: "thread-a",
    routing: {
      senderId: "user-a",
      recipientIds: ["agent-echo"],
    },
    identity: {
      correlationId: id,
      deduplicationId: `${id}:create`,
    },
  });
}

async function openTranscriptWrite(fixture: Fixture): Promise<
  Readonly<{
    streamId: string;
    write(text: string): Promise<void>;
    close(): Promise<void>;
  }>
> {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const work = await fixture.engine.execution.dispatchWork({
    workload: COPILOTZ_STREAM_WORKLOAD,
    metadata: jsonStreamDispatchMetadata({
      schema: "copilotz.stream.dispatch.v1",
      databaseSchema: TEST_SCHEMA,
      action: "write",
      namespace: NAMESPACE,
      threadId: "thread-a",
      lane: "transcript",
      mediaType: "text/plain",
      participantId: "user-a",
    }),
    body: stream.readable,
  });
  const metadata = await work.metadata;
  const streamId = String(metadata.streamId ?? "");
  if (!streamId) {
    throw new Error("Transcript write did not return a stream id.");
  }
  const drain = work.output.getReader();
  void (async () => {
    while (true) {
      const next = await drain.read();
      if (next.done) break;
    }
  })().catch(() => undefined);
  return Object.freeze({
    streamId,
    write(text: string) {
      return writer.write(encoder.encode(text));
    },
    async close() {
      await writer.close();
    },
  });
}

async function followStream(
  fixture: Fixture,
  streamId: string,
): Promise<string> {
  const work = await fixture.engine.execution.dispatchWork({
    workload: COPILOTZ_STREAM_WORKLOAD,
    metadata: jsonStreamDispatchMetadata({
      schema: "copilotz.stream.dispatch.v1",
      databaseSchema: TEST_SCHEMA,
      action: "follow",
      namespace: NAMESPACE,
      threadId: "thread-a",
      streamId,
    }),
  });
  const reader = work.output.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    byteLength += next.value.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(bytes);
}

async function waitForRun(
  fixture: Fixture,
  rootEventId: string,
  expectedMessages: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const settlement = await fixture.engine.events.settlement(
      NAMESPACE,
      rootEventId,
    );
    const messages = await projectMessages(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    if (
      settlement.unsettled === 0 && settlement.deadLetters === 0 &&
      messages.length === expectedMessages
    ) return;
    if (settlement.deadLetters > 0) {
      const deliveries = await fixture.engine.deliveries.list({
        namespace: NAMESPACE,
        status: "dead_letter",
      });
      throw new Error(`Run dead-lettered: ${JSON.stringify(deliveries)}`);
    }
    const attempts = await projectLlmAttempts(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    if (attempts.some((attempt) => attempt.status === "failed")) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const deliveries = await fixture.engine.deliveries.list({
    namespace: NAMESPACE,
    limit: 100,
  });
  const messages = await projectMessages(fixture.engine, NAMESPACE, "thread-a");
  const attempts = await projectLlmAttempts(
    fixture.engine,
    NAMESPACE,
    "thread-a",
  );
  const streams = await boundCollection(fixture.engine, "stream").query
    .byThreadId(NAMESPACE, { threadId: "thread-a" });
  const attemptRecords = await Promise.all(
    attempts.map((attempt) =>
      boundCollection(fixture.engine, "llm_attempt").get(attempt.id, NAMESPACE)
    ),
  );
  const errorDetails = await Promise.all(
    attemptRecords.map(async (record) => {
      const content = Array.isArray(record?.content) ? record.content : [];
      const resolved = await fixture.engine.content.resolver.getMany(
        content as never,
        { namespace: NAMESPACE },
      );
      return resolved.map((part) => ({
        role: part.ref?.role,
        text: part.text,
        value: part.value,
      }));
    }),
  );
  throw new Error(
    `Timed out waiting for the session workflow to settle: ${
      JSON.stringify({
        expectedMessages,
        actualMessages: messages.length,
        attempts: attempts.map((attempt) => ({
          id: attempt.id,
          status: attempt.status,
          safeError: attempt.safeError,
        })),
        attemptRecords,
        errorDetails,
        streams: streams.map((record) => ({
          id: record.id,
          lane: record.lane,
          state: record.state,
          mediaType: record.mediaType,
        })),
        deliveries,
      })
    }`,
  );
}

async function waitUntil(
  check: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

Deno.test("session writes content and audio streams from frames and transcript ingress", async () => {
  let reading!: () => void;
  const startedReading = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let received!: () => void;
  const receivedBytes = new Promise<void>((resolve) => {
    received = resolve;
  });
  const fixture = await createFixture(
    sessionFromHandler(async (input, emit) => {
      const chunks: string[] = [];
      const reader = input.input?.getReader();
      reading();
      if (reader) {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(decoder.decode(next.value));
          if (chunks.length === 1) received();
        }
      }
      const heard = chunks.join("");
      emit({ type: "text", payload: `echo:${heard}` });
      emit({
        type: "audio",
        payload: { bytes: encoder.encode("pcm"), mediaType: "audio/pcm" },
      });
      emit({
        type: "tool_call",
        payload: { tool: "noop", args: { heard } },
      });
      emit({ type: "reasoning", payload: "thinking" });
      return sessionResponse(input, `echo:${heard}`);
    }),
  );
  try {
    await createThread(fixture);
    const transcript = await openTranscriptWrite(fixture);
    const root = await createUserMessage(
      fixture,
      "Speak with me.",
      "message:user",
    );
    await startedReading;
    await transcript.write("hello session");
    await receivedBytes;
    await transcript.close();
    await waitForRun(fixture, root.event.id, 2);

    const records = await boundCollection(fixture.engine, "stream").query
      .byThreadId(NAMESPACE, { threadId: "thread-a" });
    const created = records.map((record) => ({
      id: record.id,
      lane: String(record.lane),
      mediaType: String(record.mediaType),
    }));
    const content = created.find((item) =>
      item.lane === "content" && item.mediaType === "text/plain"
    );
    const audio = created.find((item) =>
      item.lane === "content" && item.mediaType === "audio/pcm"
    );
    const reasoning = created.find((item) => item.lane === "reasoning");
    const toolCall = created.find((item) => item.lane === "tool_call");
    assertExists(content);
    assertExists(audio);
    assertExists(reasoning);
    assertExists(toolCall);
    assertEquals(await followStream(fixture, content.id), "echo:hello session");
    assertEquals(await followStream(fixture, audio.id), "pcm");
    assertEquals(await followStream(fixture, reasoning.id), "thinking");
    assertEquals(
      JSON.parse((await followStream(fixture, toolCall.id)).trim()),
      { tool: "noop", args: { heard: "hello session" } },
    );
    const durable = await fixture.engine.events.list({
      namespace: NAMESPACE,
      threadId: "thread-a",
      limit: 1_000,
    });
    assertEquals(
      durable.some((event) =>
        [
          "text.delta",
          "reasoning.delta",
          "tool_call.delta",
          "tool_output.delta",
        ]
          .includes(event.type)
      ),
      false,
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("session routing does not start a second attempt while one is running", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await createFixture(
    sessionFromHandler(async (input, emit) => {
      await held;
      emit({ type: "text", payload: "done" });
      return sessionResponse(input, "done");
    }),
  );
  try {
    await createThread(fixture);
    const first = await createUserMessage(
      fixture,
      "Stay open.",
      "message:user",
    );
    await waitUntil(async () => {
      const attempts = await projectLlmAttempts(
        fixture.engine,
        NAMESPACE,
        "thread-a",
      );
      return attempts.length === 1 && attempts[0]?.status === "running";
    }, "the first session attempt");
    const second = await createUserMessage(
      fixture,
      "Do not start another attempt.",
      "message:user-2",
    );
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const settlement = await fixture.engine.events.settlement(
        NAMESPACE,
        second.event.id,
      );
      if (settlement.unsettled === 0 && settlement.deadLetters === 0) break;
      if (settlement.deadLetters > 0) {
        throw new Error("Second message dead-lettered.");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const during = await projectLlmAttempts(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    assertEquals(during.length, 1);
    assertEquals(during[0]?.status, "running");
    release();
    await waitForRun(fixture, first.event.id, 3);
    const after = await projectLlmAttempts(
      fixture.engine,
      NAMESPACE,
      "thread-a",
    );
    assertEquals(after.length, 1);
    assertEquals(after[0]?.status, "completed");
  } finally {
    await fixture.close();
  }
});
