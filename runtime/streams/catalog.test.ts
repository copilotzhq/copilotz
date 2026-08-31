import { assertEquals, assertExists } from "@std/assert";
import {
  createEventStore,
  provisionCopilotzSchema,
  type SqlExecutor,
  type SqlSession,
} from "../events/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createStreamOutputDescriptor } from "./observation.ts";
import {
  createOperationCatalog,
  OPERATION_CHANGE_CHANNEL,
  operationStreamBodyId,
  provisionOperationCatalog,
  validateOperationCatalog,
} from "./catalog.ts";

const SCHEMA = "copilotz_operation_catalog_test";

Deno.test("operation stream Body ids honor the trusted schema storage prefix", () => {
  assertEquals(
    operationStreamBodyId({
      bodyPrefix: "bucket-root/schemas/tenant_schema",
      namespace: "tenant/a",
      streamId: "stream/a",
    }),
    "bucket-root/schemas/tenant_schema/content-streams/tenant%252Fa/stream%252Fa",
  );
});

function notificationSession(database: SqlSession): SqlSession {
  const handlers = new Set<
    (notification: { channel: string; payload?: string }) => void
  >();
  const notification = (
    params: unknown[] | undefined,
    queue: Array<readonly [string, string]>,
  ) => {
    queue.push([String(params?.[0] ?? ""), String(params?.[1] ?? "")]);
    return Promise.resolve({ rows: [] });
  };
  const deliver = (queue: readonly (readonly [string, string])[]) => {
    for (const [channel, payload] of queue) {
      for (const handler of handlers) handler({ channel, payload });
    }
  };
  const query: SqlExecutor["query"] = async (sql, params) => {
    if (sql.includes("pg_notify")) {
      const queue: Array<readonly [string, string]> = [];
      const result = await notification(params, queue);
      deliver(queue);
      return result;
    }
    return await database.query(sql, params);
  };
  return {
    query,
    async transaction(operation) {
      const queue: Array<readonly [string, string]> = [];
      const value = await database.transaction((transaction) =>
        operation({
          query: (sql, params) =>
            sql.includes("pg_notify")
              ? notification(params, queue)
              : transaction.query(sql, params),
        })
      );
      deliver(queue);
      return value;
    },
    async listen(_channel, handler) {
      handlers.add(handler);
      return {
        async close() {
          handlers.delete(handler);
        },
      };
    },
  };
}

Deno.test("operation catalog opens streams with exact metadata and wakes cross-catalog observers", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(database, SCHEMA);
    await provisionOperationCatalog(database, SCHEMA);
    await validateOperationCatalog(database, SCHEMA);
    const notified = notificationSession(database);
    const writer = createOperationCatalog(notified, SCHEMA);
    const observer = createOperationCatalog(notified, SCHEMA);
    const operationId = "operation-a";
    const watch = await observer.watch(operationId);
    const change = watch.wait({ timeoutMs: 2_000 });
    await notified.transaction((transaction) =>
      writer.indexEvent(transaction, {
        namespace: "tenant-a",
        operationId,
        eventId: operationId,
        position: "1",
        correlationId: "correlation-a",
        createdAt: "2026-08-31T12:00:00.000Z",
        metadata: { operationMetadata: { threadId: "thread-a" } },
      })
    );
    assertEquals(await change, true);

    const descriptor = createStreamOutputDescriptor({
      id: "stream-a",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: { lane: "answer" },
    }, { namespace: "tenant-a" });
    const replayIdentity = await writer.openStream({
      namespace: "tenant-a",
      operationId,
      bodyId: "body-a",
      descriptor,
    });
    assertExists(replayIdentity);
    await writer.commitStreamOffset({
      namespace: "tenant-a",
      operationId,
      streamId: descriptor.streamId,
      committedOffset: 5,
    });
    await writer.sealStream({
      namespace: "tenant-a",
      operationId,
      streamId: descriptor.streamId,
      body: {
        bodyId: "body-a",
        state: "ready",
        byteLength: 5,
        mediaType: "text/plain",
        digest: `sha256:${"a".repeat(64)}`,
        maintenanceVersion: 1,
      },
      expiresAt: "2026-09-01T12:00:00.000Z",
    });
    await writer.retainStream({
      namespace: "tenant-a",
      operationId,
      streamId: descriptor.streamId,
      retention: "observation",
      expiresAt: "2026-09-01T12:00:00.000Z",
    });

    const streams = await observer.listStreams({
      namespace: "tenant-a",
      operationId,
    });
    assertEquals(streams.length, 1);
    assertEquals(streams[0].replayKey, replayIdentity.replayKey);
    assertEquals(streams[0].streamOrdinal, replayIdentity.streamOrdinal);
    assertEquals(/^[1-9][0-9]*$/.test(replayIdentity.replayKey), true);
    assertEquals(replayIdentity.streamOrdinal, "1");
    assertEquals(streams[0].descriptor, descriptor);
    assertEquals(streams[0].bodyId, "body-a");
    assertEquals(streams[0].committedOffset, 5);
    assertEquals(streams[0].assetRetention, "observation");
    assertEquals(streams[0].assetId, undefined);
    assertExists(await observer.get("tenant-a", operationId));
    assertEquals(
      await observer.listExpiredObservationStreams({
        now: new Date("2030-09-01T12:00:00.000Z"),
        operationRetentionMs: 0,
      }),
      [],
    );
    await writer.mark("tenant-a", operationId, "completed");
    assertEquals(
      await observer.listExpiredObservationStreams({
        now: new Date("2030-09-01T12:00:00.000Z"),
        operationRetentionMs: 10 * 365 * 24 * 60 * 60_000,
      }),
      [],
    );
    assertEquals(
      (await observer.listExpiredObservationStreams({
        now: new Date("2030-09-01T12:00:00.000Z"),
        operationRetentionMs: 0,
      })).map((stream) => stream.streamId),
      [descriptor.streamId],
    );
    await notified.transaction((transaction) =>
      writer.indexEvent(transaction, {
        namespace: "tenant-a",
        operationId: "operation-b",
        eventId: "operation-b",
        position: "2",
        correlationId: "correlation-b",
        createdAt: "2026-08-31T12:00:01.000Z",
      })
    );
    const secondIdentity = await writer.openStream({
      namespace: "tenant-a",
      operationId: "operation-b",
      bodyId: "body-b",
      descriptor: createStreamOutputDescriptor({
        id: "stream-b",
        mediaType: "text/plain",
        kind: "text",
        role: "assistant",
        metadata: {},
      }, { namespace: "tenant-a" }),
    });
    assertExists(secondIdentity);
    assertEquals(secondIdentity.streamOrdinal, "1");
    assertEquals(secondIdentity.replayKey === replayIdentity.replayKey, false);
    watch.close();
  } finally {
    await database.close();
  }
});

Deno.test("a recovered execution supersedes its old physical lane without byte splicing", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(database, SCHEMA);
    await provisionOperationCatalog(database, SCHEMA);
    const catalog = createOperationCatalog(database, SCHEMA);
    await database.transaction((transaction) =>
      catalog.indexEvent(transaction, {
        namespace: "tenant-a",
        operationId: "operation-incarnation",
        eventId: "operation-incarnation",
        position: "1",
        correlationId: "correlation-a",
        createdAt: "2026-08-31T12:00:00.000Z",
      })
    );
    const descriptor = (streamId: string) =>
      createStreamOutputDescriptor({
        id: streamId,
        mediaType: "text/plain",
        kind: "text",
        role: "assistant",
        metadata: { contentStreamSemanticId: "logical-lane" },
      }, { namespace: "tenant-a" });

    await catalog.openStream({
      namespace: "tenant-a",
      operationId: "operation-incarnation",
      semanticStreamId: "logical-lane",
      bodyId: "body-old",
      descriptor: descriptor("physical-old"),
    });
    await catalog.commitStreamOffset({
      namespace: "tenant-a",
      operationId: "operation-incarnation",
      streamId: "physical-old",
      committedOffset: 11,
    });
    await catalog.openStream({
      namespace: "tenant-a",
      operationId: "operation-incarnation",
      semanticStreamId: "logical-lane",
      bodyId: "body-new",
      descriptor: descriptor("physical-new"),
    });

    const streams = await catalog.listStreams({
      namespace: "tenant-a",
      operationId: "operation-incarnation",
    });
    assertEquals(
      streams.map((stream) => ({
        id: stream.streamId,
        semanticId: stream.semanticStreamId,
        state: stream.state,
        offset: stream.committedOffset,
      })),
      [
        {
          id: "physical-old",
          semanticId: "logical-lane",
          state: "aborted",
          offset: 11,
        },
        {
          id: "physical-new",
          semanticId: "logical-lane",
          state: "open",
          offset: 0,
        },
      ],
    );
    assertEquals(
      await catalog.hasOpenStreams(
        "tenant-a",
        "operation-incarnation",
      ),
      true,
    );
    assertEquals(
      await catalog.mark(
        "tenant-a",
        "operation-incarnation",
        "completed",
      ),
      false,
    );
    assertEquals(
      (await catalog.get("tenant-a", "operation-incarnation"))?.state,
      "accepted",
    );
  } finally {
    await database.close();
  }
});

Deno.test("detached settlement scopes cannot create orphan reconnect rows", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(database, SCHEMA);
    await provisionOperationCatalog(database, SCHEMA);
    const catalog = createOperationCatalog(database, SCHEMA);
    await database.transaction((transaction) =>
      catalog.indexEvent(transaction, {
        namespace: "tenant-a",
        operationId: "detached:event-a:consumer-a",
        eventId: "event-child-a",
        position: "2",
        correlationId: "correlation-a",
        createdAt: "2026-08-31T12:00:00.000Z",
      })
    );
    assertEquals(
      await catalog.listEventIds({
        namespace: "tenant-a",
        operationId: "detached:event-a:consumer-a",
      }),
      [],
    );
    const descriptor = createStreamOutputDescriptor({
      id: "detached-stream",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    }, { namespace: "tenant-a" });
    assertEquals(
      await catalog.openStream({
        namespace: "tenant-a",
        operationId: "detached:event-a:consumer-a",
        bodyId: "detached-body",
        descriptor,
      }),
      undefined,
    );
    assertEquals(
      await catalog.listStreams({
        namespace: "tenant-a",
        operationId: "detached:event-a:consumer-a",
      }),
      [],
    );
  } finally {
    await database.close();
  }
});

Deno.test("operation catalog coalesces notification bursts into one catalog rescan", async () => {
  let notify!: (notification: { channel: string; payload?: string }) => void;
  const query: SqlExecutor["query"] = async () => ({ rows: [] });
  const session: SqlSession = {
    query,
    transaction: async <T>(
      operation: (transaction: SqlExecutor) => Promise<T>,
    ) => await operation(session),
    listen: async (
      _channel: string,
      handler: typeof notify,
    ) => {
      notify = handler;
      return { close: () => Promise.resolve() };
    },
  };
  const catalog = createOperationCatalog(session, "public");
  const watch = await catalog.watch("operation-burst");
  notify({ channel: OPERATION_CHANGE_CHANNEL, payload: "operation-burst" });
  notify({ channel: OPERATION_CHANGE_CHANNEL, payload: "operation-burst" });
  notify({ channel: OPERATION_CHANGE_CHANNEL, payload: "operation-burst" });
  assertEquals(await watch.wait({ timeoutMs: 100 }), true);
  assertEquals(await watch.wait({ timeoutMs: 100 }), false);
  watch.close();
});

Deno.test("post-commit notification failure does not fail a stream catalog mutation", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(database, SCHEMA);
    await provisionOperationCatalog(database, SCHEMA);
    const session = {
      query: <T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) => {
        if (sql.includes("pg_notify")) {
          return Promise.reject(new Error("notification unavailable"));
        }
        return database.query<T>(sql, params);
      },
      transaction: database.transaction,
      listen: async () => ({ close: () => Promise.resolve() }),
    };
    const writer = createOperationCatalog(session, SCHEMA);
    const reader = createOperationCatalog(database, SCHEMA);
    await database.transaction((transaction) =>
      reader.indexEvent(transaction, {
        namespace: "tenant-a",
        operationId: "operation-notify-failure",
        eventId: "operation-notify-failure",
        position: "1",
        correlationId: "correlation-notify-failure",
        createdAt: "2026-08-31T12:00:00.000Z",
      })
    );
    const descriptor = createStreamOutputDescriptor({
      id: "stream-notify-failure",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    }, { namespace: "tenant-a" });
    await writer.openStream({
      namespace: "tenant-a",
      operationId: "operation-notify-failure",
      bodyId: "body-notify-failure",
      descriptor,
    });
    assertEquals(
      (await reader.listStreams({
        namespace: "tenant-a",
        operationId: "operation-notify-failure",
      })).length,
      1,
    );
  } finally {
    await database.close();
  }
});

Deno.test("operation reconciliation skips old live work instead of starving later settlement", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(database, SCHEMA);
    await provisionOperationCatalog(database, SCHEMA);
    let drained = 0;
    let duringDrain = () => Promise.resolve();
    const catalog = createOperationCatalog(database, SCHEMA, {
      async beforeTerminal() {
        drained += 1;
        await duringDrain();
      },
    });
    const store = createEventStore({
      session: database,
      schema: SCHEMA,
      indexOperationEvent: (transaction, input) =>
        catalog.indexEvent(transaction, input),
    });
    const active = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        store.append({
          type: "test.operation.active",
          namespace: "tenant-a",
          payload: { index },
        }, ["consumer-never-claimed"])),
    );
    const settled = await store.append({
      type: "test.operation.settled",
      namespace: "tenant-a",
      payload: {},
    }, []);
    const racedDelivery = active[0].deliveries[0];
    assertExists(racedDelivery);
    assertExists(
      await store.claimDelivery({
        id: racedDelivery.id,
        owner: "reconcile-race-owner",
      }),
    );
    duringDrain = async () => {
      assertEquals(
        await store.succeedDelivery(
          racedDelivery.id,
          "reconcile-race-owner",
        ),
        true,
      );
    };

    assertEquals(await catalog.reconcile({ limit: 1 }), 1);
    assertEquals(drained, 1);
    assertEquals(
      (await catalog.get("tenant-a", settled.event.id))?.state,
      "completed",
    );
    for (const operation of active) {
      assertEquals(
        (await catalog.get("tenant-a", operation.event.id))?.state,
        "accepted",
      );
    }
  } finally {
    await database.close();
  }
});

Deno.test("terminal metadata pruning removes replay rows but never observation ownership early", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(database, SCHEMA);
    await provisionOperationCatalog(database, SCHEMA);
    const catalog = createOperationCatalog(database, SCHEMA);
    const createOperation = async (
      operationId: string,
      retention: "canonical" | "observation" | "aborted",
    ) => {
      await database.transaction((transaction) =>
        catalog.indexEvent(transaction, {
          namespace: "tenant-a",
          operationId,
          eventId: operationId,
          position: operationId.endsWith("a") ? "10" : "11",
          correlationId: `${operationId}:correlation`,
          createdAt: "2026-08-31T12:00:00.000Z",
        })
      );
      const descriptor = createStreamOutputDescriptor({
        id: `${operationId}:stream`,
        mediaType: "text/plain",
        kind: "text",
        role: "assistant",
        metadata: {},
      }, { namespace: "tenant-a" });
      await catalog.openStream({
        namespace: "tenant-a",
        operationId,
        bodyId: `${operationId}:body`,
        descriptor,
      });
      if (retention === "aborted") {
        await catalog.abortStream({
          namespace: "tenant-a",
          operationId,
          streamId: descriptor.streamId,
        });
      } else {
        await catalog.sealStream({
          namespace: "tenant-a",
          operationId,
          streamId: descriptor.streamId,
          body: {
            bodyId: `${operationId}:body`,
            state: "ready",
            byteLength: 1,
            mediaType: "text/plain",
            digest: `sha256:${"b".repeat(64)}`,
            maintenanceVersion: 1,
          },
          expiresAt: "2031-01-01T00:00:00.000Z",
        });
        await catalog.retainStream({
          namespace: "tenant-a",
          operationId,
          streamId: descriptor.streamId,
          ...(retention === "canonical"
            ? { retention, assetId: `${operationId}:asset` }
            : {
              retention,
              expiresAt: "2031-01-01T00:00:00.000Z",
            }),
        });
      }
      await catalog.mark("tenant-a", operationId, "completed");
    };
    await createOperation("operation-prune-a", "canonical");
    await createOperation("operation-prune-b", "observation");
    await createOperation("operation-prune-c", "aborted");
    const pruned = await catalog.pruneTerminalMetadata({
      now: new Date("2030-01-01T00:00:00.000Z"),
      retentionMs: 0,
      limit: 10,
    });
    assertEquals(pruned, { streams: 2, events: 2, operations: 2 });
    assertEquals(await catalog.get("tenant-a", "operation-prune-a"), null);
    assertExists(await catalog.get("tenant-a", "operation-prune-b"));
    assertEquals(await catalog.get("tenant-a", "operation-prune-c"), null);
  } finally {
    await database.close();
  }
});

Deno.test("operation catalog watch uses a bounded fallback without notification capability", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(database, SCHEMA);
    await provisionOperationCatalog(database, SCHEMA);
    const catalog = createOperationCatalog({
      query: database.query,
      transaction: database.transaction,
    }, SCHEMA);
    const watch = await catalog.watch("operation-fallback");
    assertEquals(await watch.wait({ timeoutMs: 100 }), false);
    watch.close();
  } finally {
    await database.close();
  }
});
