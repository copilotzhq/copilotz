import { assertEquals, assertRejects } from "@std/assert";

import {
  type CollectionRecord,
  createCollectionRuntime,
} from "@copilotz/copilotz/collections";
import {
  CORE_COLLECTION_NAMES,
  messageCollection,
  messageRevisionFrom,
  participantCollection,
  projectActiveMessageBranch,
  threadCollection,
} from "./index.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import { createTestProcessorContext } from "../../runtime/testing/processor-context.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type EventCoordinator,
  type EventStore,
  type SqlSession,
} from "../../runtime/events/index.ts";
import {
  createDeliveryExecutor,
  type DeliveryExecutor,
} from "../../runtime/execution/index.ts";
import {
  createBodyStorageRuntime,
  createDatabaseAssetRepository,
} from "../../runtime/content/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "@copilotz/copilotz/plugins";

const NOW = "2026-08-17T23:00:00.000Z";
const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
const NAMESPACE = "tenant-a";

const BODY = Object.freeze({
  assetId: "asset-body",
  kind: "text",
  role: "body",
  mediaType: "text/plain",
});

type Fixture = Readonly<{
  db: TestDatabase;
  session: SqlSession;
  store: EventStore;
  coordinator: EventCoordinator;
  executor: DeliveryExecutor;
  runtime: ReturnType<typeof createCollectionRuntime>;
  participants: ReturnType<typeof createCollectionRuntime> extends infer _
    ? ReturnType<ReturnType<typeof createCollectionRuntime>["bind"]>
    : never;
  threads: ReturnType<ReturnType<typeof createCollectionRuntime>["bind"]>;
  messages: ReturnType<ReturnType<typeof createCollectionRuntime>["bind"]>;
}>;

async function count(
  session: SqlSession,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const result = await session.query<{ n: number }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

async function createFixture(url: string, schema: string): Promise<Fixture> {
  const db = await createTestDatabase({ url });
  const session = createSqlSession(db);
  for (const statement of createCoreSchemaStatements(schema)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema });
  const processor = defineProcessor({
    id: "core.audit",
    on: [
      { eventType: "participant.created" },
      { eventType: "thread.created" },
      { eventType: "thread.updated" },
      { eventType: "message.created" },
    ],
    handle: () => undefined,
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.core-collections",
      version: "1.0.0",
      processors: { audit: processor },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "core-collections-test",
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  const assets = createDatabaseAssetRepository({
    coordinator,
    session,
    eventStore: store,
    databaseSchema: schema,
    storage: createBodyStorageRuntime({ storage: { type: "database" } }),
  });
  for (const id of ["asset-body", "asset-revised"]) {
    await assets.publish({
      namespace: NAMESPACE,
      id,
      mediaType: "text/plain",
      body: new TextEncoder().encode(id),
    });
  }
  let nextId = 0;
  const runtime = createCollectionRuntime({
    coordinator,
    session,
    eventStore: store,
    assets,
    createId: () => `core-${++nextId}`,
    now: () => new Date(NOW),
  });
  return Object.freeze({
    db,
    session,
    store,
    coordinator,
    executor,
    runtime,
    participants: runtime.bind(participantCollection),
    threads: runtime.bind(threadCollection),
    messages: runtime.bind(messageCollection),
  });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.shutdown();
  await fixture.db.close();
}

Deno.test("core collections cover semantic conversation state only", () => {
  assertEquals([...CORE_COLLECTION_NAMES], [
    "participant",
    "thread",
    "message",
  ]);
  assertEquals(
    CORE_COLLECTION_NAMES.includes(
      "relation" as typeof CORE_COLLECTION_NAMES[number],
    ),
    false,
  );
});

async function runCoreSuite(url: string, schema: string): Promise<void> {
  const fixture = await createFixture(url, schema);
  const {
    runtime,
    participants,
    threads,
    messages,
    store,
    session,
  } = fixture;
  const tables = store.tables;
  try {
    const created = await runtime.transaction({
      operationKey: "thread:create:inbox",
      namespace: NAMESPACE,
      async execute({ collections }) {
        const human = await collections.participant.create({
          id: "participant-human",
          externalId: "user:ada",
          participantType: "human",
          name: "Ada",
        });
        const agent = await collections.participant.create({
          id: "participant-agent",
          externalId: "agent:copilot",
          participantType: "agent",
          name: "Copilot",
          agentId: "agent-1",
        });
        const thread = await collections.thread.create({
          id: "thread-a",
          externalId: "ext-thread-a",
          name: "Inbox",
          participantIds: [human.id, agent.id],
        });
        return { human, agent, thread };
      },
    });
    await Promise.all(created.dispatch.handles.map((handle) => handle.done));

    assertEquals(
      created.writes.map((write) =>
        !write.noop ? write.event.eventType : "noop"
      ),
      ["participant.created", "participant.created", "thread.created"],
    );
    assertEquals(
      await participants.query.byExternalId(NAMESPACE, {
        externalId: "user:ada",
      }).then((rows) => rows.map((row) => row.id)),
      ["participant-human"],
    );
    assertEquals(
      await threads.query.byExternalId(NAMESPACE, {
        externalId: "ext-thread-a",
      }).then((rows) => rows.map((row) => row.id)),
      ["thread-a"],
    );

    const participantSource = await session.query<{
      source_type: string | null;
      source_id: string | null;
    }>(
      `SELECT source_type, source_id FROM ${tables.nodes}
       WHERE id = $1 AND type = 'participant'`,
      ["participant-human"],
    );
    assertEquals(participantSource.rows[0], {
      source_type: "participant_external_id",
      source_id: "user:ada",
    });
    const threadSource = await session.query<{
      source_type: string | null;
      source_id: string | null;
    }>(
      `SELECT source_type, source_id FROM ${tables.nodes}
       WHERE id = $1 AND type = 'thread'`,
      ["thread-a"],
    );
    assertEquals(threadSource.rows[0], {
      source_type: "thread_external_id",
      source_id: "ext-thread-a",
    });

    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.edges}
         WHERE namespace = $1 AND type = 'participates_in'
           AND target_node_id = $2`,
        [NAMESPACE, "thread-a"],
      ),
      2,
    );
    const participation = await session.query<{
      source_node_id: string;
      target_node_id: string;
    }>(
      `SELECT source_node_id, target_node_id FROM ${tables.edges}
       WHERE namespace = $1 AND type = 'participates_in'
       ORDER BY source_node_id`,
      [NAMESPACE],
    );
    assertEquals(
      participation.rows.map((row) => [row.source_node_id, row.target_node_id]),
      [
        ["participant-agent", "thread-a"],
        ["participant-human", "thread-a"],
      ],
    );

    const hydratedThread = await threads.query(NAMESPACE, {
      where: { id: "thread-a" },
      include: ["participants"],
    });
    assertEquals(
      (hydratedThread[0].participants as readonly CollectionRecord[])
        .map((row) => row.id)
        .sort(),
      ["participant-agent", "participant-human"],
    );

    await assertRejects(
      () =>
        participants.create({
          id: "participant-dup",
          externalId: "user:ada",
          participantType: "human",
        }, { namespace: NAMESPACE }),
      Error,
    );
    assertEquals(await participants.get("participant-dup", NAMESPACE), null);

    const otherNs = await participants.create({
      id: "participant-b",
      externalId: "user:ada",
      participantType: "human",
      name: "Ada B",
    }, { namespace: "tenant-b" });
    assertEquals(otherNs.record.namespace, "tenant-b");
    assertEquals(
      (await participants.list(NAMESPACE)).map((row) => row.id).sort(),
      ["participant-agent", "participant-human"],
    );

    assertEquals(await runtime.verify(participantCollection, NAMESPACE), {
      ok: true,
    });

    const original = await messages.create({
      id: "message-1",
      threadId: "thread-a",
      senderId: "participant-human",
      content: [BODY],
    }, {
      namespace: NAMESPACE,
      visibility: { kind: "public" },
    });
    await Promise.all(original.dispatch.handles.map((handle) => handle.done));
    assertEquals(original.event.eventType, "message.created");
    assertEquals(original.event.threadId, undefined);
    assertEquals(original.event.routing, {});
    assertEquals(original.event.visibility, { kind: "public" });
    assertEquals(
      (await session.query<{
        source_type: string | null;
        source_id: string | null;
      }>(
        `SELECT source_type, source_id FROM ${tables.nodes}
         WHERE id = $1 AND type = 'message'`,
        ["message-1"],
      )).rows[0],
      { source_type: null, source_id: null },
    );

    const threadAfterMessage = await threads.get("thread-a", NAMESPACE);
    assertEquals(threadAfterMessage?.lastEventId, undefined);

    const withSender = await messages.query(NAMESPACE, {
      where: { id: "message-1" },
      include: ["sender", "thread"],
    });
    assertEquals(
      (withSender[0].sender as CollectionRecord).id,
      "participant-human",
    );
    assertEquals((withSender[0].thread as CollectionRecord).id, "thread-a");

    const revision = await messages.create({
      id: "message-1-rev",
      threadId: "thread-a",
      senderId: "participant-human",
      content: [{ ...BODY, assetId: "asset-revised" }],
      revision: messageRevisionFrom(
        original.record as {
          id: string;
        },
        NOW,
      ),
    }, { namespace: NAMESPACE });
    await Promise.all(revision.dispatch.handles.map((handle) => handle.done));
    assertEquals(revision.event.eventType, "message.created");
    assertEquals(
      (await store.listEvents({ namespace: NAMESPACE, limit: 100 }))
        .some((event) => event.type === "message.revised"),
      false,
    );

    const revisionRows = await messages.query.revisions(NAMESPACE, {
      rootMessageId: "message-1",
    });
    assertEquals(revisionRows.map((row) => row.id), ["message-1-rev"]);

    await threads.update("thread-a", {
      set: {
        activeMessageBranch: {
          rootMessageId: "message-1",
          headMessageId: "message-1-rev",
          previousRevisionMessageId: "message-1",
          revisionIndex: 1,
        },
      },
    }, { namespace: NAMESPACE });
    const history = await messages.query.byThreadId(NAMESPACE, {
      threadId: "thread-a",
    });
    const active = projectActiveMessageBranch(
      history,
      {
        rootMessageId: "message-1",
        headMessageId: "message-1-rev",
        previousRevisionMessageId: "message-1",
        revisionIndex: 1,
      },
    );
    assertEquals(active.map((row) => row.id), ["message-1-rev"]);

    assertEquals(await runtime.verify(messageCollection, NAMESPACE), {
      ok: true,
    });

    await session.query(
      `UPDATE ${tables.nodes}
       SET data = jsonb_set(data, '{senderId}', '"tampered"')
       WHERE id = $1 AND type = 'message'`,
      ["message-1"],
    );
    const tampered = await runtime.verify(messageCollection, NAMESPACE);
    assertEquals(tampered.ok, false);
    await runtime.rebuild(NAMESPACE);
    assertEquals(await runtime.verify(messageCollection, NAMESPACE), {
      ok: true,
    });
    assertEquals(await runtime.verify(threadCollection, NAMESPACE), {
      ok: true,
    });
    assertEquals(await runtime.verify(participantCollection, NAMESPACE), {
      ok: true,
    });
    assertEquals(
      (await messages.get("message-1", NAMESPACE))?.senderId,
      "participant-human",
    );
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.edges}
         WHERE namespace = $1 AND type = 'participates_in'`,
        [NAMESPACE],
      ),
      2,
    );
    assertEquals(
      await count(
        session,
        `SELECT count(*)::int AS n FROM ${tables.edges}
         WHERE namespace = $1 AND type = 'has_message'`,
        [NAMESPACE],
      ),
      2,
    );
  } finally {
    await closeFixture(fixture);
  }
}

Deno.test("core collections on PGlite", async () => {
  await runCoreSuite(":memory:", "copilotz_core_collections");
});

Deno.test({
  name: "core collections on PostgreSQL",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await runCoreSuite(
      POSTGRES_URL!,
      `v3_core_${crypto.randomUUID().replaceAll("-", "")}`,
    );
  },
});
