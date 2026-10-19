import { recordTestContentTerminal } from "../testing/content-catalog.ts";
import { type OwnerChange, stageOwnerChange } from "../events/push.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createStreamOutputDescriptor } from "./observation.ts";
import {
  createOperationCatalog,
  type OperationChangeDetail,
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

async function pushFixture() {
  const session = await createTestDatabase({ url: ":memory:" });
  await provisionCopilotzSchema(session, SCHEMA);
  await provisionOperationCatalog(session, SCHEMA);
  const catalog = createOperationCatalog(session, SCHEMA);
  const send = async (
    operationId: string,
    kind: OwnerChange["kind"] = "operation",
    namespace = "scope",
  ) => {
    await createSchemaCommandRunner(session, SCHEMA)(
      "test.push",
      {},
      (_input, { transaction }) => {
        stageOwnerChange(transaction, SCHEMA, {
          namespace,
          operationId,
          selectionKeys: [],
          kind,
          seq: "0",
        });
      },
    );
  };
  return { session, catalog, send };
}

Deno.test("operation catalog opens streams with exact metadata and wakes cross-catalog observers", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(database, SCHEMA);
    const notified = database;
    await provisionOperationCatalog(notified, SCHEMA);
    await validateOperationCatalog(notified, SCHEMA);
    const writer = createOperationCatalog(notified, SCHEMA);
    const observer = createOperationCatalog(notified, SCHEMA);
    const operationId = "operation-a";
    const hints: OperationChangeDetail[] = [];
    const unsubscribe = await observer.onChange(
      (_id, detail) => hints.push(detail),
      {
        namespace: "tenant-a",
      },
    );
    const watch = await observer.watch(operationId);
    const change = watch.wait({ timeoutMs: 2_000 });
    await createSchemaCommandRunner(notified, SCHEMA)(
      "test.index",
      {},
      (_input, { transaction }) =>
        writer.indexEvent(transaction, {
          namespace: "tenant-a",
          operationId,
          eventId: operationId,
          position: "1",
          correlationId: "correlation-a",
          createdAt: "2026-08-31T12:00:00.000Z",
          metadata: { operationMetadata: { threadId: "thread-a" } },
        }),
    );
    assertEquals(await change, true);
    assertEquals(hints.at(-1)?.kind, "event");
    assertEquals(hints.at(-1)?.namespace, "tenant-a");

    const descriptor = createStreamOutputDescriptor({
      id: "stream-a",
      semanticId: "stream-a",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: { lane: "answer" },
    }, { namespace: "tenant-a" });
    const replayIdentity = await writer.openStream({
      namespace: "tenant-a",
      operationId,
      semanticStreamId: descriptor.streamId,
      bodyId: "body-a",
      descriptor,
    });
    assertExists(replayIdentity);
    assertEquals(hints.at(-1)?.kind, "stream");
    assertEquals(hints.at(-1)?.streamId, descriptor.streamId);
    await recordTestContentTerminal(notified, SCHEMA, "tenant-a", {
      bodyId: "body-a",
      byteLength: 5,
      digest: `sha256:${"a".repeat(64)}`,
      mediaType: "text/plain",
    });
    await writer.commitStreamOffset({
      namespace: "tenant-a",
      operationId,
      streamId: descriptor.streamId,
      committedOffset: 5,
    });
    assertEquals(hints.at(-1)?.kind, "stream-offset");
    assertEquals(hints.at(-1)?.streamId, descriptor.streamId);
    assertEquals(hints.at(-1)?.committedOffset, 5);
    await writer.commitStreamOffset({
      namespace: "tenant-a",
      operationId,
      streamId: descriptor.streamId,
      committedOffset: 2,
    });
    assertEquals(hints.at(-1)?.committedOffset, 5);
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
        versionToken: "test-version",
      },
    });
    assertEquals(hints.at(-1)?.kind, "stream");
    assertEquals(hints.at(-1)?.streamId, descriptor.streamId);
    await writer.retainStream({
      namespace: "tenant-a",
      operationId,
      streamId: descriptor.streamId,
      retention: "observation",
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
    assertEquals(streams[0].retention, "observation");
    assertEquals(streams[0].assetId, undefined);
    assertExists(await observer.get("tenant-a", operationId));
    assertEquals(
      await observer.listExpiredObservationStreams({
        now: new Date("2030-09-01T12:00:00.000Z"),
        operationRetentionMs: 0,
      }),
      [],
    );
    await writer.reconcile({ namespace: "tenant-a", operationId });
    assertEquals(hints.at(-1)?.kind, "operation");
    assertEquals(hints.at(-1)?.streamId, undefined);
    unsubscribe();
    assertEquals(
      await writer.openStream({
        namespace: "tenant-a",
        operationId,
        semanticStreamId: "stream-after-terminal",
        bodyId: "body-after-terminal",
        descriptor: createStreamOutputDescriptor({
          id: "stream-after-terminal",
          semanticId: "stream-after-terminal",
          mediaType: "text/plain",
          kind: "text",
          role: "assistant",
          metadata: {},
        }, { namespace: "tenant-a" }),
      }),
      undefined,
    );
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
    await createSchemaCommandRunner(notified, SCHEMA)(
      "test.index",
      {},
      (_input, { transaction }) =>
        writer.indexEvent(transaction, {
          namespace: "tenant-a",
          operationId: "operation-b",
          eventId: "operation-b",
          position: "2",
          correlationId: "correlation-b",
          createdAt: "2026-08-31T12:00:01.000Z",
        }),
    );
    const secondIdentity = await writer.openStream({
      namespace: "tenant-a",
      operationId: "operation-b",
      semanticStreamId: "stream-b",
      bodyId: "body-b",
      descriptor: createStreamOutputDescriptor({
        id: "stream-b",
        semanticId: "stream-b",
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
    await createSchemaCommandRunner(database, SCHEMA)(
      "test.index",
      {},
      (_input, { transaction }) =>
        catalog.indexEvent(transaction, {
          namespace: "tenant-a",
          operationId: "operation-incarnation",
          eventId: "operation-incarnation",
          position: "1",
          correlationId: "correlation-a",
          createdAt: "2026-08-31T12:00:00.000Z",
        }),
    );
    const descriptor = (streamId: string) =>
      createStreamOutputDescriptor({
        id: streamId,
        semanticId: streamId,
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
    await recordTestContentTerminal(database, SCHEMA, "tenant-a", {
      bodyId: "body-old",
      byteLength: 11,
      digest: `sha256:${"d".repeat(64)}`,
      mediaType: "text/plain",
    }, "cancelled");
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
    assertEquals(
      await catalog.commitStreamOffset({
        namespace: "tenant-a",
        operationId: "operation-incarnation",
        streamId: "physical-old",
        committedOffset: 12,
      }),
      false,
    );

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
          state: "terminating",
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
      await catalog.terminateStream({
        namespace: "tenant-a",
        operationId: "operation-incarnation",
        streamId: "physical-old",
        body: {
          bodyId: "body-old",
          state: "incomplete",
          byteLength: 11,
          mediaType: "text/plain",
          digest: `sha256:${"d".repeat(64)}`,
          maintenanceVersion: 2,
          versionToken: "test-version",
        },
        outcome: "cancelled",
        reason: "superseded",
      }),
      true,
    );
    const fenced = await catalog.getStream(
      "tenant-a",
      "operation-incarnation",
      "physical-old",
    );
    assertEquals(fenced?.state, "terminal");
    assertEquals(fenced?.outcome, "cancelled");
    assertEquals(fenced?.reason, "superseded");
    // A raced physical byte is tentative until the owner accepts its checkpoint.
    assertEquals(fenced?.committedOffset, 11);
    assertEquals(
      await catalog.hasOpenStreams(
        "tenant-a",
        "operation-incarnation",
      ),
      true,
    );
    assertEquals(
      (await catalog.reconcile({
        namespace: "tenant-a",
        operationId: "operation-incarnation",
      })) > 0,
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

Deno.test("operation stream terminalization is crash-resumable and retains generic failure state", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(database, SCHEMA);
    await provisionOperationCatalog(database, SCHEMA);
    const catalog = createOperationCatalog(database, SCHEMA);
    const operationId = "operation-retained-failure";
    await createSchemaCommandRunner(database, SCHEMA)(
      "test.index",
      {},
      (_input, { transaction }) =>
        catalog.indexEvent(transaction, {
          namespace: "tenant-a",
          operationId,
          eventId: operationId,
          position: "1",
          correlationId: "correlation-a",
          createdAt: "2026-08-31T12:00:00.000Z",
        }),
    );
    const descriptor = createStreamOutputDescriptor({
      id: "failed-stream",
      semanticId: "failed-stream",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    }, { namespace: "tenant-a" });
    await catalog.openStream({
      namespace: "tenant-a",
      operationId,
      semanticStreamId: descriptor.streamId,
      bodyId: "failed-body",
      descriptor,
    });
    await recordTestContentTerminal(database, SCHEMA, "tenant-a", {
      bodyId: "failed-body",
      byteLength: 7,
      digest: `sha256:${"c".repeat(64)}`,
      mediaType: "text/plain",
    }, "failed");
    await catalog.commitStreamOffset({
      namespace: "tenant-a",
      operationId,
      streamId: descriptor.streamId,
      committedOffset: 7,
    });
    assertEquals(
      await catalog.beginStreamTerminalization({
        namespace: "tenant-a",
        operationId,
        streamId: descriptor.streamId,
        outcome: "failed",
      }),
      true,
    );
    assertEquals(
      (await catalog.getStream(
        "tenant-a",
        operationId,
        descriptor.streamId,
      ))?.state,
      "terminating",
    );
    assertEquals(
      (await catalog.reconcile({ namespace: "tenant-a", operationId })) > 0,
      false,
    );

    const terminal = catalog.waitForStreamTerminal(
      "tenant-a",
      descriptor.streamId,
    );
    assertEquals(
      await catalog.terminateStream({
        namespace: "tenant-a",
        operationId,
        streamId: descriptor.streamId,
        body: {
          bodyId: "failed-body",
          state: "incomplete",
          byteLength: 7,
          mediaType: "text/plain",
          digest: `sha256:${"c".repeat(64)}`,
          maintenanceVersion: 2,
          versionToken: "test-version",
        },
        outcome: "failed",
      }),
      true,
    );
    assertEquals(await terminal, {
      outcome: "failed",
      availability: "retained",
      offset: 7,
      terminalAt: (await catalog.getStream(
        "tenant-a",
        operationId,
        descriptor.streamId,
      ))!.terminalAt!,
    });
    await assertRejects(
      () =>
        catalog.openStream({
          namespace: "tenant-a",
          operationId,
          semanticStreamId: descriptor.streamId,
          bodyId: "failed-body",
          descriptor,
        }),
      Error,
      "cannot reopen after terminalization began",
    );
    assertEquals(
      (await catalog.reconcile({ namespace: "tenant-a", operationId })) > 0,
      true,
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
    await createSchemaCommandRunner(database, SCHEMA)(
      "test.index",
      {},
      (_input, { transaction }) =>
        catalog.indexEvent(transaction, {
          namespace: "tenant-a",
          operationId: "detached:event-a:consumer-a",
          eventId: "event-child-a",
          position: "2",
          correlationId: "correlation-a",
          createdAt: "2026-08-31T12:00:00.000Z",
        }),
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
      semanticId: "detached-stream",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    }, { namespace: "tenant-a" });
    assertEquals(
      await catalog.openStream({
        namespace: "tenant-a",
        operationId: "detached:event-a:consumer-a",
        semanticStreamId: descriptor.streamId,
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

Deno.test("operation catalog coalesces committed push bursts into one catalog read", async () => {
  const f = await pushFixture();
  const watch = await f.catalog.watch("operation-burst");
  try {
    await f.send("operation-burst");
    await f.send("operation-burst");
    await f.send("operation-burst");
    assertEquals(await watch.wait({ timeoutMs: 100 }), true);
    assertEquals(await watch.wait({ timeoutMs: 100 }), false);
  } finally {
    watch.close();
    await f.session.close();
  }
});

Deno.test("operation catalog failed observers reset without harming removable peers", async () => {
  const f = await pushFixture();
  const received: string[] = [];
  const second: string[] = [];
  let resets = 0;
  const remove = await f.catalog.onChange((id, detail) => {
    if (detail.kind === "reset") {
      resets++;
      return;
    }
    if (!id) return;
    received.push(id);
    if (id === "operation-failure") throw new Error("consumer failure");
  });
  const removeSecond = await f.catalog.onChange((id) => {
    if (id) second.push(id);
  });
  try {
    await f.send("operation-change");
    await f.send("operation-failure");
    assertEquals(received, ["operation-change", "operation-failure"]);
    assertEquals(second, ["operation-change", "operation-failure"]);
    assertEquals(resets, 1);
    remove();
    removeSecond();
    remove();
    await f.send("after-remove");
    assertEquals(received, ["operation-change", "operation-failure"]);
  } finally {
    remove();
    removeSecond();
    await f.session.close();
  }
});

Deno.test("postcommit observer failure does not roll back a stream catalog mutation", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(database, SCHEMA);
    await provisionOperationCatalog(database, SCHEMA);
    const session = database;
    const writer = createOperationCatalog(session, SCHEMA);
    const reader = createOperationCatalog(database, SCHEMA);
    const remove = await reader.onChange((_id, detail) => {
      if (detail.kind === "stream") throw new Error("push failure");
    });
    await createSchemaCommandRunner(database, SCHEMA)(
      "test.index",
      {},
      (_input, { transaction }) =>
        reader.indexEvent(transaction, {
          namespace: "tenant-a",
          operationId: "operation-notify-failure",
          eventId: "operation-notify-failure",
          position: "1",
          correlationId: "correlation-notify-failure",
          createdAt: "2026-08-31T12:00:00.000Z",
        }),
    );
    const descriptor = createStreamOutputDescriptor({
      id: "stream-notify-failure",
      semanticId: "stream-notify-failure",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    }, { namespace: "tenant-a" });
    await writer.openStream({
      namespace: "tenant-a",
      operationId: "operation-notify-failure",
      semanticStreamId: descriptor.streamId,
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
    remove();
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
      assertExists(
        await store.succeedDelivery(
          racedDelivery.id,
          "reconcile-race-owner",
        ),
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
      await createSchemaCommandRunner(database, SCHEMA)(
        "test.index",
        {},
        (_input, { transaction }) =>
          catalog.indexEvent(transaction, {
            namespace: "tenant-a",
            operationId,
            eventId: operationId,
            position: operationId.endsWith("a") ? "10" : "11",
            correlationId: `${operationId}:correlation`,
            createdAt: "2026-08-31T12:00:00.000Z",
          }),
      );
      const descriptor = createStreamOutputDescriptor({
        id: `${operationId}:stream`,
        semanticId: `${operationId}:stream`,
        mediaType: "text/plain",
        kind: "text",
        role: "assistant",
        metadata: {},
      }, { namespace: "tenant-a" });
      await catalog.openStream({
        namespace: "tenant-a",
        operationId,
        semanticStreamId: descriptor.streamId,
        bodyId: `${operationId}:body`,
        descriptor,
      });
      if (retention === "aborted") {
        await catalog.markStreamUnavailable({
          namespace: "tenant-a",
          operationId,
          streamId: descriptor.streamId,
          outcome: "failed",
          reason: "abandoned",
          availabilityReason: "deleted",
        });
      } else {
        await recordTestContentTerminal(database, SCHEMA, "tenant-a", {
          bodyId: `${operationId}:body`,
          byteLength: 1,
          digest: `sha256:${"b".repeat(64)}`,
          mediaType: "text/plain",
        });
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
            versionToken: "test-version",
          },
        });
        await catalog.retainStream({
          namespace: "tenant-a",
          operationId,
          streamId: descriptor.streamId,
          ...(retention === "canonical"
            ? { retention, assetId: `${operationId}:asset` }
            : {
              retention,
            }),
        });
      }
      (await catalog.reconcile({ namespace: "tenant-a", operationId })) > 0;
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

Deno.test("operation catalog waits are bounded without database notifications", async () => {
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

Deno.test("settlement watches filter bytes and events while committed lifecycle changes wake them", async () => {
  const f = await pushFixture();
  const watch = await f.catalog.watch("operation", {
    namespace: "scope",
    kind: "operation",
  });
  try {
    await f.send("operation", "event");
    await f.send("operation", "stream");
    await f.send("operation", "stream-offset");
    await f.send("operation", "operation", "other");
    assertEquals(await watch.wait({ signal: AbortSignal.abort() }), false);
    await f.send("operation");
    assertEquals(await watch.wait({ signal: AbortSignal.abort() }), true);
  } finally {
    watch.close();
    await f.session.close();
  }
});
