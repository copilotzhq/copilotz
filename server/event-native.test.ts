import { message as coreMessage } from "@copilotz/copilotz/core";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createTestDomainContext } from "../runtime/testing/domain-context.ts";

import { createCopilotz } from "../runtime/application/index.ts";
import type { AttachmentOutput } from "../runtime/attachments/index.ts";
import type {
  ChannelRequest,
  ChannelResource,
  ChannelRuntime,
} from "../plugins/channels/index.ts";
import { defineCollection } from "../runtime/collections/index.ts";
import {
  createEphemeralEvent,
  provisionCopilotzSchema,
} from "../runtime/events/index.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import { coreCollectionsPlugin } from "../plugins/core/plugin.ts";
import type { Agent } from "../runtime/resources/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import {
  createEventNativeApp,
  type EventNativeAppError,
  type EventNativeAppResponse,
  isEventNativeOutputStream,
} from "./event-native.ts";

const SCHEMA = "copilotz_event_native_server";
const NAMESPACE = "tenant-a";

const notes = defineCollection({
  name: "notes",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      label: { type: "string" },
    },
    required: ["label"],
  } as const,
});

const supportAgent = Object.freeze(
  {
    id: "support",
    name: "Support",
    role: "support",
    instructions: "Never expose this instruction.",
    metadata: { apiKey: "never-expose-this-either" },
    capabilities: { tools: ["lookup"] },
    runtime: { provider: "test", model: "test-model" },
  } satisfies Agent,
);

const adapterPlugin = definePlugin({
  id: "test.event-native-adapter",
  version: "1.0.0",
  collections: { notes },
  resources: { agents: { support: supportAgent } },
});

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  assert(Array.isArray(value));
  return value;
}

async function collect(
  stream: ReadableStream<AttachmentOutput>,
): Promise<readonly AttachmentOutput[]> {
  const events: AttachmentOutput[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function expectAppError(
  operation: () => Promise<EventNativeAppResponse>,
  status: number,
  code: string,
): Promise<EventNativeAppError> {
  const error = await assertRejects(operation);
  assertEquals((error as EventNativeAppError).status, status);
  assertEquals((error as EventNativeAppError).code, code);
  return error as EventNativeAppError;
}

Deno.test("event-native app exposes graph, event, asset, collection, and plugin capabilities without legacy storage routes", async () => {
  const application = await createCopilotz({
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    plugins: [coreCollectionsPlugin, adapterPlugin],
  });
  const app = createEventNativeApp(application);
  try {
    assert(Object.isFrozen(app));
    assertEquals(
      app.resources().map((resource) => resource.name),
      [
        "agents",
        "assets",
        "channels",
        "collections",
        "deliveries",
        "events",
        "participants",
        "threads",
      ],
    );
    assertEquals(
      app.resources().find((resource) => resource.name === "threads")?.methods,
      ["GET"],
    );
    assertEquals(
      app.resources().find((resource) => resource.name === "participants")
        ?.methods,
      ["GET"],
    );

    const agentResponse = await app.handle({
      resource: "agents",
      method: "GET",
    });
    const projectedAgent = object(array(agentResponse.data)[0]);
    assertEquals(projectedAgent.id, "support");
    assertEquals(projectedAgent.name, "Support");
    assertEquals(projectedAgent.capabilities, { tools: ["lookup"] });
    assertEquals("instructions" in projectedAgent, false);
    assertEquals("metadata" in projectedAgent, false);

    const domain = createTestDomainContext(application, NAMESPACE);
    await domain.actions.createThread({
      id: "thread-a",
      externalId: "external-thread-a",
      participants: [{
        id: "user-a",
        externalId: "external-user-a",
        participantType: "human",
        name: "Alice",
        email: "alice@example.test",
      }, {
        id: "agent-a",
        externalId: "support",
        participantType: "agent",
        agentId: "support",
        name: "Support",
      }],
      metadata: { source: "test" },
    });
    await domain.actions.addThreadParticipant({
      threadId: "thread-a",
      participant: {
        id: "user-b",
        externalId: "external-user-b",
        participantType: "human",
        name: "Bob",
      },
    });

    const listedThreads = await app.handle({
      resource: "threads",
      method: "GET",
      query: { participantId: "user-a", status: "active", order: "desc" },
    });
    assertEquals(array(listedThreads.data).length, 1);
    assertEquals(object(array(listedThreads.data)[0]).id, "thread-a");

    const participant = await app.handle({
      resource: "participants",
      method: "GET",
      path: ["external-user-a"],
    });
    assertEquals(object(participant.data).name, "Alice");
    const humanParticipants = await app.handle({
      resource: "participants",
      method: "GET",
      query: { type: "human" },
    });
    assertEquals(array(humanParticipants.data).length, 2);

    const run = await application.send(coreMessage({
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
      content: "Hello from the event-native adapter",
      id: "message-a",
      correlationId: "run:message:a",
      deduplicationId: "run:message:a",
    }));
    const observed = collect(run.outputs);
    await run.done;
    assertEquals(
      (await observed).filter((event) => event.type === "message.created")
        .length,
      1,
    );

    const messagesResponse = await app.handle({
      resource: "threads",
      method: "GET",
      path: ["thread-a", "messages"],
      query: { include: "content" },
    });
    const messages = array(messagesResponse.data);
    assertEquals(messages.length, 1);
    const message = object(messages[0]);
    assertEquals(message.id, "message-a");
    const content = array(message.content);
    const assetId = object(content[0]).assetId;
    assertEquals(typeof assetId, "string");
    const included = object(messagesResponse.included);
    const includedContent = array(included.content);
    assertEquals(includedContent.length, 1);
    assertEquals(object(object(includedContent[0]).ref).assetId, assetId);
    assertEquals(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(object(includedContent[0]).base64 as string),
          (c) => c.charCodeAt(0),
        ),
      ),
      "Hello from the event-native adapter",
    );

    await expectAppError(
      () =>
        app.handle({
          resource: "threads",
          method: "GET",
          path: ["thread-a", "messages"],
          query: { include: "legacyProjection" },
        }),
      400,
      "invalid_query",
    );

    const assetResponse = await app.handle({
      resource: "assets",
      method: "GET",
      path: [assetId as string],
      query: { format: "dataUrl" },
    });
    const dataUrl = object(assetResponse.data).dataUrl;
    assertEquals(typeof dataUrl, "string");
    assertStringIncludes(dataUrl as string, "base64,");
    const encoded = (dataUrl as string).split("base64,")[1];
    assertEquals(
      new TextDecoder().decode(
        Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
      ),
      "Hello from the event-native adapter",
    );

    const runEvents = await app.handle({
      resource: "events",
      method: "GET",
      query: { correlationId: "run:message:a" },
    });
    const durableEvents = array(runEvents.data);
    assertEquals(
      durableEvents.map((event) => object(event).type),
      [
        "copilotz.core.message.input",
        "copilotz.core.thread-message.create.invoked",
        "message.created",
        "copilotz.core.thread-message.create.completed",
      ],
    );
    const messageEvent = object(
      durableEvents.find((event) => object(event).type === "message.created"),
    );
    assertEquals(messageEvent.type, "message.created");
    assertEquals(typeof messageEvent.position, "string");
    const eventById = await app.handle({
      resource: "events",
      method: "GET",
      path: [messageEvent.id as string],
    });
    assertEquals(object(eventById.data).id, messageEvent.id);
    const threadEvents = await app.handle({
      resource: "threads",
      method: "GET",
      path: ["thread-a", "events"],
      query: { limit: "10" },
    });
    assertEquals(
      array(threadEvents.data).map((value) => object(value).type),
      [
        "thread.created",
        "participant.created",
        "thread.updated",
        "message.created",
      ],
    );
    assertEquals(threadEvents.pageInfo, { hasMore: false });
    const threadActivity = await app.handle({
      resource: "threads",
      method: "GET",
      path: ["thread-a", "activity"],
      query: { includeDeliveries: "true" },
    });
    assertEquals(object(threadActivity.data).status, "idle");
    assertEquals(object(threadActivity.data).activeCount, 0);
    assertEquals(object(threadActivity.data).activeDeliveries, []);
    assertEquals(object(threadActivity.data).lastFailure, null);

    const revisionResult = object(
      await domain.actions.reviseMessage({
        id: "message-a:revision:1",
        threadId: "thread-a",
        messageId: "message-a",
        content: [
          "Hello after editing",
          { type: "json", value: { revision: 1 } },
        ],
        metadata: { editedBy: "user-a" },
      }),
    );
    const revision = object(revisionResult.message);
    assertEquals(revisionResult.rootMessageId, "message-a");
    assertEquals(revisionResult.previousRevisionMessageId, "message-a");
    assertEquals(revisionResult.revisionIndex, 1);
    assertEquals(object(revision.revision).revisionIndex, 1);
    assertEquals(object(revision.metadata).editedBy, "user-a");
    const activeMessages = array(
      (await app.handle({
        resource: "threads",
        method: "GET",
        path: ["thread-a", "messages"],
      })).data,
    );
    assertEquals(activeMessages.map((value) => object(value).id), [
      revision.id,
    ]);
    const allMessages = array(
      (await app.handle({
        resource: "threads",
        method: "GET",
        path: ["thread-a", "messages"],
        query: { view: "all" },
      })).data,
    );
    assertEquals(allMessages.map((value) => object(value).id), [
      "message-a",
      revision.id,
    ]);

    await expectAppError(
      () => app.handle({ resource: "events", method: "POST" }),
      405,
      "method_not_allowed",
    );

    const createdNote = await app.handle({
      resource: "collections",
      method: "POST",
      path: ["notes"],
      headers: { "idempotency-key": "http:note:a" },
      body: { id: "note-a", label: "First" },
    });
    assertEquals(createdNote.status, 201);
    assertEquals(object(createdNote.data).label, "First");
    const updatedNote = await app.handle({
      resource: "collections",
      method: "PATCH",
      path: ["notes", "note-a"],
      body: { label: "Updated" },
    });
    assertEquals(object(updatedNote.data).label, "Updated");
    const listedNotes = await app.handle({
      resource: "collections",
      method: "GET",
      path: ["notes"],
      query: { where: JSON.stringify({ label: "Updated" }) },
    });
    assertEquals(array(listedNotes.data).length, 1);
    assertEquals(
      (await app.handle({
        resource: "collections",
        method: "DELETE",
        path: ["notes", "note-a"],
      })).status,
      204,
    );
    await expectAppError(
      () =>
        app.handle({
          resource: "collections",
          method: "GET",
          path: ["notes", "note-a"],
        }),
      404,
      "record_not_found",
    );

    const deliveries = await app.handle({
      resource: "deliveries",
      method: "GET",
      query: { status: "succeeded" },
    });
    const succeededDeliveries = array(deliveries.data);
    assertEquals(succeededDeliveries.length, 1);
    assertEquals(
      object(succeededDeliveries[0]).consumerId,
      "processor:copilotz.core.message-input",
    );
    await expectAppError(
      () =>
        app.handle({
          resource: "deliveries",
          method: "GET",
          query: { status: "unknown" },
        }),
      400,
      "invalid_query",
    );
    await expectAppError(
      () =>
        app.handle({
          resource: "threads",
          method: "GET",
          path: ["thread-a"],
          context: { namespace: "tenant-b" },
        }),
      404,
      "thread_not_found",
    );
    await expectAppError(
      () =>
        app.handle({
          resource: "threads",
          method: "GET",
          context: { databaseSchema: "wrong-schema" },
        }),
      400,
      "schema_mismatch",
    );

    assertEquals(
      object(
        (await app.handle({
          resource: "events",
          method: "GET",
          path: [messageEvent.id as string],
        })).data,
      ).type,
      "message.created",
    );
    for (const resource of ["features", "graph", "queues"]) {
      await expectAppError(
        () => app.handle({ resource, method: "GET" }),
        404,
        "route_not_found",
      );
    }
  } finally {
    await application.shutdown();
  }
});

Deno.test("message history resolves canonical semantic content without operational projections", async () => {
  const application = await createCopilotz({
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_history`,
    plugins: [coreCollectionsPlugin],
  });
  const app = createEventNativeApp(application);
  try {
    const domain = createTestDomainContext(application, NAMESPACE);
    await domain.actions.createThread({
      id: "history-thread",
      participants: [{
        id: "history-human",
        externalId: "history-human",
        participantType: "human",
        name: "Human",
      }, {
        id: "history-agent",
        externalId: "support",
        participantType: "agent",
        agentId: "support",
        name: "Support",
      }],
    });
    await domain.actions.createThreadMessage({
      id: "history-user-message",
      threadId: "history-thread",
      sender: {
        id: "history-human",
        externalId: "history-human",
        participantType: "human",
      },
      recipientIds: ["history-agent"],
      content: "Run lookup",
    });
    const reasoning = await application.content.preparer.prepare({
      type: "text",
      text: "I should run lookup.",
      role: "reasoning",
    }, {
      namespace: NAMESPACE,
      idempotencyKey: "history:attempt:reasoning",
    });
    for (const asset of reasoning.assets) {
      await application.content.assets.publish({
        namespace: asset.namespace,
        id: asset.id,
        mediaType: asset.mediaType,
        body: asset.body,
        ...(asset.idempotencyKey
          ? { idempotencyKey: asset.idempotencyKey }
          : {}),
      });
    }
    const toolCalls = [{
      id: "history-call",
      tool: { id: "lookup", name: "Lookup" },
      args: JSON.stringify({ query: "canonical" }),
      status: "pending",
    }];
    await domain.actions.createThreadMessage({
      id: "history-agent-message",
      threadId: "history-thread",
      sender: {
        id: "history-agent",
        externalId: "support",
        participantType: "agent",
        agentId: "support",
      },
      content: "Running lookup",
      metadata: {
        llmReasoning: reasoning.content,
        llmToolCalls: toolCalls,
        copilotzWorkflow: {
          kind: "agent_output",
          llmAttemptId: "history-attempt",
          agentParticipantId: "history-agent",
        },
      },
    });
    await domain.actions.createThreadMessage({
      id: "history-tool-message",
      threadId: "history-thread",
      sender: {
        externalId: "tool:lookup",
        participantType: "tool",
        name: "Lookup",
      },
      recipientIds: ["history-agent"],
      content: {
        type: "json",
        value: { ok: false, error: "Lookup unavailable" },
        role: "tool.projected_output",
      },
      metadata: {
        toolId: "lookup",
        toolStatus: "failed",
        requesterId: "history-agent",
        historyVisibility: "public",
        toolInvocation: toolCalls[0],
        copilotzWorkflow: {
          kind: "tool_result",
          llmAttemptId: "history-attempt",
          toolCallId: "history-call",
          toolExecutionId: "history-execution",
          sourceMessageId: "history-agent-message",
          agentParticipantId: "history-agent",
        },
      },
    });

    const response = await app.handle({
      resource: "threads",
      method: "GET",
      path: ["history-thread", "messages"],
      query: { include: "content", order: "desc", limit: "2" },
    });
    assertEquals(response.pageInfo, {
      next: "history-agent-message",
      hasMore: true,
    });
    const included = object(response.included);
    const roles = array(included.content).map((value) =>
      object(object(value).ref).role
    );
    for (
      const role of [
        "body",
        "reasoning",
        "tool.projected_output",
      ]
    ) {
      assert(
        roles.includes(role),
        `Expected canonical content role '${role}'.`,
      );
    }
    const agentMessage = array(response.data).map(object).find((message) =>
      message.id === "history-agent-message"
    )!;
    assertEquals(
      object(object(agentMessage.metadata).copilotzWorkflow).llmAttemptId,
      "history-attempt",
    );
    assertEquals("senderType" in agentMessage, false);
    assert(Array.isArray(agentMessage.content));

    const older = await app.handle({
      resource: "threads",
      method: "GET",
      path: ["history-thread", "messages"],
      query: {
        include: "content",
        order: "desc",
        limit: "2",
        before: "history-agent-message",
      },
    });
    assertEquals(
      array(older.data).map((message) => object(message).id),
      ["history-user-message"],
    );
    assertEquals(older.pageInfo, { hasMore: false });
    assertEquals(array(object(older.included).content).length, 1);
  } finally {
    await application.shutdown();
  }
});

Deno.test("event-native server adapter remains factory-first and avoids raw graph and queue contracts", async () => {
  const source = await Deno.readTextFile(
    new URL("event-native.ts", import.meta.url),
  );
  assertEquals(/\bclass\s+\w+/.test(source), false);
  assertEquals(
    /unsafeGraph|queueId|queueTTL|ackMode|runGeneration/.test(source),
    false,
  );
  assertEquals(
    /\.query\s*\(|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b/.test(
      source,
    ),
    false,
  );
});

Deno.test("trusted schema resolution isolates identical HTTP resource identities", async () => {
  const defaultSchema = `${SCHEMA}_trusted_default`;
  const alternateSchema = `${SCHEMA}_trusted_alternate`;
  const database = await createTestDatabase({ url: ":memory:" });
  await provisionCopilotzSchema(database, alternateSchema);
  const application = await createCopilotz({
    namespace: NAMESPACE,
    databaseSchema: defaultSchema,
    plugins: [coreCollectionsPlugin],
    database,
  });
  let authorizedSchema = defaultSchema;
  const app = createEventNativeApp(application, {
    resolveDatabaseSchema: () => authorizedSchema,
  });
  const create = (status: string) =>
    app.handle({
      resource: "collections",
      method: "POST",
      path: ["thread"],
      body: { id: "shared-thread", status, participantIds: [] },
      context: { databaseSchema: authorizedSchema },
    });
  try {
    assertEquals((await create("default")).status, 201);
    authorizedSchema = alternateSchema;
    assertEquals((await create("alternate")).status, 201);

    const alternate = await app.handle({
      resource: "threads",
      method: "GET",
      path: ["shared-thread"],
      context: { databaseSchema: alternateSchema },
    });
    assertEquals(object(alternate.data).status, "alternate");

    authorizedSchema = defaultSchema;
    const original = await app.handle({
      resource: "threads",
      method: "GET",
      path: ["shared-thread"],
      context: { databaseSchema: defaultSchema },
    });
    assertEquals(object(original.data).status, "default");
    await expectAppError(
      () =>
        app.handle({
          resource: "threads",
          method: "GET",
          path: ["shared-thread"],
          context: { databaseSchema: alternateSchema },
        }),
      400,
      "schema_mismatch",
    );
  } finally {
    await application.shutdown();
    await database.close();
  }
});

Deno.test("event-native app returns request-bound channel output before delivery settlement", async () => {
  const application = await createCopilotz({
    namespace: NAMESPACE,
    databaseSchema: `${SCHEMA}_request_bound`,
    plugins: [coreCollectionsPlugin],
  });
  let release!: () => void;
  const settlement = new Promise<void>((resolve) => {
    release = resolve;
  });
  let cancelled: string | undefined;
  const channel: ChannelResource = Object.freeze({
    id: "web",
    ingress: Object.freeze({ handle: () => ({ inputs: [] }) }),
    egress: Object.freeze({
      requestBound: true,
      deliver: () => undefined,
    }),
  });
  const channels: ChannelRuntime = Object.freeze({
    list: () => [channel],
    get: (id) => id === channel.id ? channel : undefined,
    dispatch(_namespace: string, request: ChannelRequest) {
      const event = createEphemeralEvent({
        type: "text.delta",
        namespace: NAMESPACE,
        payload: { text: "streamed" },
        correlationId: "request-bound-a",
      });
      const done = (async () => {
        await request.callback!(event as AttachmentOutput);
        await settlement;
      })();
      return Promise.resolve(Object.freeze({
        status: 202,
        response: { accepted: true },
        requestBound: true,
        executions: Object.freeze([]),
        done,
        cancel(reason = "cancelled") {
          cancelled = reason;
          release();
          return Promise.resolve();
        },
      }));
    },
  });
  try {
    const response = await createEventNativeApp(application, { channels })
      .handle({
        resource: "channels",
        method: "POST",
        path: ["web"],
        body: {},
      });
    assertEquals(response.status, 200);
    assert(isEventNativeOutputStream(response.data));
    let settled = false;
    response.data.done.then(() => settled = true);
    assertEquals(settled, false);
    const reader = response.data.outputs.getReader();
    const first = await reader.read();
    assertEquals(first.value?.type, "text.delta");
    assertEquals(settled, false);
    release();
    await response.data.done;
    assertEquals((await reader.read()).done, true);
    await response.data.cancel("test_cleanup");
    assertEquals(cancelled, "test_cleanup");
  } finally {
    release();
    await application.shutdown();
  }
});
