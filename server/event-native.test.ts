import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";

import { createCopilotz } from "../runtime/application/index.ts";
import type { AttachmentOutput } from "../runtime/attachments/index.ts";
import type {
  ChannelRequest,
  ChannelResource,
  ChannelRuntime,
} from "../runtime/channels/index.ts";
import { defineCollection } from "../runtime/domain/index.ts";
import type { CopilotzEvent } from "../runtime/events/index.ts";
import { createEphemeralEvent } from "../runtime/events/index.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import type { Agent } from "../runtime/resources/index.ts";
import {
  createEventNativeApp,
  type EventNativeAppError,
  type EventNativeAppRequest,
  type EventNativeAppResponse,
  type EventNativeFeatureContext,
  type EventNativeFeatureResource,
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
    allowedTools: ["lookup"],
    runtimes: {
      text: { type: "llm", provider: "test", model: "test-model" },
    },
  } satisfies Agent,
);

const echoFeature: EventNativeFeatureResource = Object.freeze({
  id: "echo",
  actions: Object.freeze({
    ping(
      request: EventNativeAppRequest,
      context: EventNativeFeatureContext,
    ) {
      return {
        namespace: context.namespace,
        body: request.body,
        hasTypedConversation: typeof context.application.conversation
          .createMessage === "function",
      };
    },
  }),
});

const adapterPlugin = definePlugin({
  manifest: {
    id: "test.event-native-adapter",
    version: "1.0.0",
    provides: {
      agents: [supportAgent.id],
      collections: [notes.name],
      features: [echoFeature.id!],
    },
  },
  resources: {
    agents: [supportAgent],
    collections: [notes],
    features: [echoFeature],
  },
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
  stream: ReadableStream<CopilotzEvent>,
): Promise<readonly CopilotzEvent[]> {
  const events: CopilotzEvent[] = [];
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
    schema: SCHEMA,
    core: false,
    plugins: [adapterPlugin],
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
        "features",
        "participants",
        "threads",
      ],
    );
    assertEquals(
      app.resources().find((resource) => resource.name === "threads")?.methods,
      ["GET", "POST", "PATCH", "DELETE"],
    );

    const agentResponse = await app.handle({
      resource: "agents",
      method: "GET",
    });
    const projectedAgent = object(array(agentResponse.data)[0]);
    assertEquals(projectedAgent.id, "support");
    assertEquals(projectedAgent.name, "Support");
    assertEquals(projectedAgent.allowedTools, ["lookup"]);
    assertEquals("instructions" in projectedAgent, false);
    assertEquals("metadata" in projectedAgent, false);

    const createThread = () =>
      app.handle({
        resource: "threads",
        method: "POST",
        headers: {
          "idempotency-key": "http:thread:a",
          "x-copilotz-correlation-id": "http:correlation:a",
        },
        body: {
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
        },
      });
    const createdThread = await createThread();
    assertEquals(createdThread.status, 201);
    assertEquals(object(createdThread.data).id, "thread-a");
    assertEquals(array(object(createdThread.data).participants).length, 2);
    const repeatedThread = await createThread();
    assertEquals(repeatedThread.status, 200);
    assertEquals(object(repeatedThread.data).id, "thread-a");

    const listedThreads = await app.handle({
      resource: "threads",
      method: "GET",
      query: { participantId: "user-a", status: "active", order: "desc" },
    });
    assertEquals(array(listedThreads.data).length, 1);
    assertEquals(object(array(listedThreads.data)[0]).id, "thread-a");

    const patchedParticipant = await app.handle({
      resource: "participants",
      method: "PATCH",
      path: ["external-user-a"],
      headers: { "idempotency-key": "http:participant:a:update" },
      body: { name: "Alice Updated", metadata: { tier: "pro" } },
    });
    assertEquals(object(patchedParticipant.data).name, "Alice Updated");
    assertEquals(object(object(patchedParticipant.data).metadata).tier, "pro");
    const humanParticipants = await app.handle({
      resource: "participants",
      method: "GET",
      query: { type: "human" },
    });
    assertEquals(array(humanParticipants.data).length, 1);

    const run = await application.run({
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
      content: "Hello from the event-native adapter",
      messageId: "message-a",
      correlationId: "run:message:a",
      deduplicationId: "run:message:a",
    });
    const observed = collect(run.events);
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
    });
    const messages = array(messagesResponse.data);
    assertEquals(messages.length, 1);
    const message = object(messages[0]);
    assertEquals(message.id, "message-a");
    const content = array(message.content);
    const assetId = object(content[0]).assetId;
    assertEquals(typeof assetId, "string");

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
    assertEquals(durableEvents.length, 1);
    const messageEvent = object(durableEvents[0]);
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
      ["thread.created", "message.created"],
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

    const editMessage = () =>
      app.handle({
        resource: "threads",
        method: "POST",
        path: ["thread-a", "messages", "message-a", "edit"],
        headers: {
          "idempotency-key": "http:message:a:edit",
          "x-copilotz-correlation-id": "http:correlation:message:a:edit",
        },
        body: {
          content: [
            "Hello after editing",
            { type: "json", value: { revision: 1 } },
          ],
          metadata: { editedBy: "user-a" },
        },
      });
    const editedMessage = await editMessage();
    assertEquals(editedMessage.status, 201);
    const revisionResult = object(editedMessage.data);
    const revision = object(revisionResult.message);
    assertEquals(revisionResult.rootMessageId, "message-a");
    assertEquals(revisionResult.previousRevisionMessageId, "message-a");
    assertEquals(revisionResult.revisionIndex, 1);
    assertEquals(object(revision.revision).revisionIndex, 1);
    assertEquals(object(revision.metadata).editedBy, "user-a");
    const repeatedEdit = await editMessage();
    assertEquals(repeatedEdit.status, 200);
    assertEquals(
      object(object(repeatedEdit.data).message).id,
      revision.id,
    );

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

    const revisionEvents = array(
      (await app.handle({
        resource: "events",
        method: "GET",
        query: { correlationId: "http:correlation:message:a:edit" },
      })).data,
    );
    assertEquals(revisionEvents.length, 1);
    assertEquals(object(revisionEvents[0]).type, "message.revised");
    const revisionEventId = object(revisionEvents[0]).id as string;
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

    const featureResponse = await app.handle({
      resource: "features",
      method: "POST",
      path: ["echo", "ping"],
      body: { value: 42 },
    });
    assertEquals(featureResponse, {
      status: 200,
      data: {
        namespace: NAMESPACE,
        body: { value: 42 },
        hasTypedConversation: true,
      },
    });

    const patchedThread = await app.handle({
      resource: "threads",
      method: "PATCH",
      path: ["thread-a"],
      body: { status: "archived", metadata: { archivedBy: "test" } },
    });
    assertEquals(object(patchedThread.data).status, "archived");
    const archivedThreads = await app.handle({
      resource: "threads",
      method: "GET",
      query: { status: "archived" },
    });
    assertEquals(array(archivedThreads.data).length, 1);

    const deliveries = await app.handle({
      resource: "deliveries",
      method: "GET",
      query: { status: "succeeded" },
    });
    assertEquals(deliveries.data, []);
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
          context: { schema: "wrong-schema" },
        }),
      400,
      "schema_mismatch",
    );

    const deletedMessages = await app.handle({
      resource: "threads",
      method: "DELETE",
      path: ["thread-a", "messages"],
      headers: { "idempotency-key": "http:thread:a:delete-messages" },
    });
    assertEquals(deletedMessages.status, 204);
    assertEquals(
      (await app.handle({
        resource: "threads",
        method: "GET",
        path: ["thread-a", "messages"],
      })).data,
      [],
    );
    assertEquals(
      object(
        (await app.handle({
          resource: "events",
          method: "GET",
          path: [revisionEventId],
        })).data,
      ).type,
      "message.revised",
    );

    const deletedThread = await app.handle({
      resource: "threads",
      method: "DELETE",
      path: ["thread-a"],
      headers: { "idempotency-key": "http:thread:a:delete" },
    });
    assertEquals(deletedThread.status, 204);
    await expectAppError(
      () =>
        app.handle({
          resource: "threads",
          method: "GET",
          path: ["thread-a"],
        }),
      404,
      "thread_not_found",
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
    for (const resource of ["graph", "queues"]) {
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

Deno.test("event-native app returns request-bound channel output before delivery settlement", async () => {
  const application = await createCopilotz({
    namespace: NAMESPACE,
    schema: `${SCHEMA}_request_bound`,
    core: false,
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
    async dispatch(_namespace: string, request: ChannelRequest) {
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
      return Object.freeze({
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
      });
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
