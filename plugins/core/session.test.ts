import { assertEquals } from "@std/assert";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectActionEvents,
  projectMessageById,
  projectMessages,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
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
  createPluginRegistry,
  definePlugin,
} from "../../runtime/plugins/index.ts";
import { corePlugin } from "@copilotz/copilotz/core";
import {
  defineLlmProviderResource,
  type LlmSession,
  sessionFromHandler,
} from "@copilotz/copilotz/llm";
import type { ChatResponse } from "../../runtime/llm/types.ts";

const TEST_SCHEMA = "copilotz_session_workflow";
const NAMESPACE = "tenant-a";

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
    id: "test.session-workflow.resources",
    version: "1.0.0",
    resources: { agents: { echo: echoAgent } },
    adapters: { llm: { openai: provider } },
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
  const collection = engine.collections.get(name);
  if (!collection) throw new Error(`Collection '${name}' is not bound.`);
  return collection;
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
    content: prepared,
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

async function projectLlmEvents(fixture: Fixture) {
  return [
    ...await projectActionEvents(
      fixture.engine,
      NAMESPACE,
      "copilotz.core.llm.generate",
    ),
    ...await projectActionEvents(
      fixture.engine,
      NAMESPACE,
      "copilotz.core.llm.session",
    ),
  ];
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
    const attempts = await projectLlmEvents(fixture);
    if (
      attempts.some((attempt) =>
        attempt.status === "failed" || attempt.status === "cancelled"
      )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const deliveries = await fixture.engine.deliveries.list({
    namespace: NAMESPACE,
    limit: 100,
  });
  const messages = await projectMessages(fixture.engine, NAMESPACE, "thread-a");
  const attempts = await projectLlmEvents(fixture);
  throw new Error(
    `Timed out waiting for the session workflow to settle: ${
      JSON.stringify({
        expectedMessages,
        actualMessages: messages.length,
        attempts: attempts.map((attempt) => ({
          id: attempt.actionRunId,
          status: attempt.status,
          error: "error" in attempt ? attempt.error : undefined,
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

Deno.test("session routing does not start a second attempt while one is running", async () => {
  let sessionCalls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await createFixture(
    sessionFromHandler(async (input, emit) => {
      sessionCalls += 1;
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
      const attempts = await projectLlmEvents(fixture);
      return attempts.length === 1 && attempts[0]?.status === "invoked";
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
    const during = await projectLlmEvents(fixture);
    assertEquals(during.map((event) => event.status), [
      "invoked",
      "invoked",
      "completed",
    ]);
    assertEquals(sessionCalls, 1);
    release();
    await waitForRun(fixture, first.event.id, 3);
    const after = await projectLlmEvents(fixture);
    assertEquals(
      after.filter((event) => event.status === "invoked").length,
      2,
    );
    assertEquals(
      after.filter((event) => event.status === "completed").length,
      2,
    );
    assertEquals(sessionCalls, 1);
  } finally {
    await fixture.close();
  }
});
