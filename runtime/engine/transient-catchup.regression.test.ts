import { assertEquals, assertExists } from "@std/assert";

import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import { createCoreTableNames, type SqlSession } from "../events/index.ts";
import { createPluginRegistry, defineProcessor } from "../plugins/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzEngine } from "./index.ts";
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

const NAMESPACE = "tenant-transient-regression";

async function coreRegistry() {
  return await createPluginRegistry({ plugins: [coreCollectionsPlugin] });
}

Deno.test("transient catch-up reads every event page beyond 1,000 events", async () => {
  const schema = "copilotz_transient_catchup_pages";
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: db,
    registry: await coreRegistry(),
    defaultDatabaseSchema: schema,
  });
  const seen: string[] = [];
  const observer = defineProcessor({
    id: "test.transient-catchup-pages",
    on: [{ eventType: "thread.created" }],
    handle(event) {
      if (event.durable) seen.push(event.id);
    },
  });
  try {
    const tables = createCoreTableNames(schema);
    await db.query(
      `INSERT INTO ${tables.events} (
         id, schema_version, type, namespace, payload, routing, visibility,
         metadata, correlation_id
       )
       SELECT
         'catchup-' || value::text,
         3,
         'thread.created',
         $1,
         '{}'::jsonb,
         '{}'::jsonb,
         '{"kind":"public"}'::jsonb,
         '{}'::jsonb,
         'correlation-' || value::text
       FROM generate_series(1, 1001) AS value`,
      [NAMESPACE],
    );

    const unbind = await engine.bindTransient(observer, {
      namespace: NAMESPACE,
      afterPosition: "0",
    });
    try {
      assertEquals(seen.length, 1_001);
    } finally {
      unbind();
    }
  } finally {
    await engine.shutdown();
    await db.close();
  }
});

Deno.test("transient catch-up delivers a concurrently committed event once", async () => {
  const schema = "copilotz_transient_catchup_fence";
  const db = await createTestDatabase({ url: ":memory:" });
  const tables = createCoreTableNames(schema);
  let catchupQuery = false;
  let releaseQuery!: () => void;
  let reportQueryStarted!: () => void;
  const queryStarted = new Promise<void>((resolve) => {
    reportQueryStarted = resolve;
  });
  const queryReleased = new Promise<void>((resolve) => {
    releaseQuery = resolve;
  });
  const session: SqlSession = {
    async query<TRow extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      if (catchupQuery && sql.includes(`SELECT * FROM ${tables.events}`)) {
        catchupQuery = false;
        reportQueryStarted();
        await queryReleased;
      }
      return await db.query<TRow>(sql, params);
    },
    transaction(operation) {
      return db.transaction(operation);
    },
  };
  const engine = await createCopilotzEngine({
    session,
    registry: await coreRegistry(),
    defaultDatabaseSchema: schema,
  });
  const seen: string[] = [];
  const observer = defineProcessor({
    id: "test.transient-catchup-fence",
    on: [{ eventType: "thread.created" }],
    handle(event) {
      if (event.durable) seen.push(event.id);
    },
  });
  let unbind: (() => void) | undefined;
  try {
    catchupQuery = true;
    const binding = engine.bindTransient(observer, {
      namespace: NAMESPACE,
      afterPosition: "0",
    });
    await queryStarted;

    await createTestDomainContext(engine, NAMESPACE).features.thread.create({
      id: "thread-racing-catchup",
      participants: [{
        id: "user-a",
        externalId: "user-a",
        participantType: "human",
      }],
    });
    const createdEvent = (await engine.events.list({
      namespace: NAMESPACE,
      limit: 100,
    })).find((event) => event.subject?.id === "thread-racing-catchup");
    assertExists(createdEvent);
    releaseQuery();
    unbind = await binding;

    assertEquals(seen, [createdEvent.id]);
  } finally {
    releaseQuery();
    unbind?.();
    await engine.shutdown();
    await db.close();
  }
});
