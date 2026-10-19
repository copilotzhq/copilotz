import { createSchemaCommandRunner } from "../engine/commands.ts";
import { assert, assertEquals } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createEventStore } from "../events/store.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "./catalog.ts";
import { createStreamOutputDescriptor } from "./observation.ts";

Deno.test("catalog stream lifecycle, availability and selection retirement join gap-free owner history", async () => {
  const schema = `catalog_push_${crypto.randomUUID().replaceAll("-", "")}`;
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim() || ":memory:",
  });
  let remove: (() => void) | undefined;
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    const catalog = createOperationCatalog(db, schema);
    const core = createCoreTableNames(schema);
    const events = createEventStore({
      session: db,
      schema,
      indexOperationEventSql: (input, param) =>
        catalog.indexEventSql(input, param),
    });
    const root = await events.append({
      namespace: "scope",
      type: "test.root",
      payload: {},
      metadata: { observationKeys: ["selection"] },
    });
    const operationId = root.event.id;
    const changes: string[] = [];
    remove = await catalog.onChange((_id, detail) => {
      if (detail.kind !== "checkpoint" && detail.kind !== "heartbeat") {
        changes.push(detail.kind!);
      }
    }, { namespace: "scope" });
    const descriptor = createStreamOutputDescriptor({
      id: "stream",
      semanticId: "stream",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    }, { namespace: "scope" });
    const input = {
      namespace: "scope",
      operationId,
      semanticStreamId: "stream",
      bodyId: "body",
      descriptor,
    };
    await catalog.openStream(input);
    await createSchemaCommandRunner(db, schema)(
      "test.acceptedPrefix",
      {},
      async (_input, { transaction }) => {
        // Projection-only fixture: progress changes the replay position, not lifecycle history.
        await transaction.query(
          `UPDATE "${schema}".copilotz_operation_streams SET committed_offset=4 WHERE stream_id='stream'`,
        );
      },
    );
    await catalog.openStream(input);
    assertEquals(
      (await db.query(`SELECT seq FROM ${core.events} ORDER BY seq`)).rows.map(
        (row) => String(row.seq),
      ),
      ["1", "2"],
    );
    const nextDescriptor = createStreamOutputDescriptor({
      id: "replacement",
      semanticId: "stream",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    }, { namespace: "scope" });
    await catalog.openStream({
      ...input,
      bodyId: "replacement-body",
      descriptor: nextDescriptor,
    });
    const supersededFacts =
      (await events.listEvents({ namespace: "scope", limit: 100 })).filter((
        event,
      ) => event.type === "operation.catalog.changed");
    assertEquals(
      supersededFacts.map((event) => {
        const value = event.payload as {
          streamId: string;
          state: { state: string };
        };
        return [value.streamId, value.state.state];
      }),
      [["stream", "open"], ["stream", "terminating"], ["replacement", "open"]],
    );
    await catalog.markStreamUnavailable({
      namespace: "scope",
      operationId,
      streamId: "replacement",
      outcome: "failed",
      availabilityReason: "missing",
    });
    await catalog.markStreamUnavailable({
      namespace: "scope",
      operationId,
      streamId: "stream",
      outcome: "cancelled",
      availabilityReason: "missing",
    });
    const before = await events.listEvents({ namespace: "scope", limit: 100 });
    const facts = before.filter((event) =>
      event.type === "operation.catalog.changed"
    ).map((event) =>
      event.payload as {
        kind: string;
        state: { state: string; availability: string };
      }
    );
    assertEquals(
      facts.map((fact) => [fact.state.state, fact.state.availability]),
      [
        ["open", "retained"],
        ["terminating", "retained"],
        ["open", "retained"],
        ["terminal", "purged"],
        ["terminal", "purged"],
      ],
    );
    await catalog.reconcile({ namespace: "scope", operationId });
    const oldHead = (await catalog.getSelectionHeads({
      namespace: "scope",
      selectionKeys: ["selection"],
    }))[0].changeOrdinal;
    await catalog.pruneTerminalMetadata({
      now: new Date("2035-01-01T00:00:00Z"),
      retentionMs: 0,
      limit: 100,
    });
    const rows = await events.listEvents({ namespace: "scope", limit: 100 });
    assertEquals(
      rows.map((event) => event.seq),
      rows.map((_event, index) => String(index + 1)),
    );
    assert(
      rows.some((event) =>
        (event.payload as { kind?: string }).kind === "retirement"
      ),
    );
    assert(
      BigInt(
        (await catalog.getSelectionHeads({
          namespace: "scope",
          selectionKeys: ["selection"],
        }))[0].changeOrdinal,
      ) > BigInt(oldHead),
    );
    assert(changes.includes("retirement"));
    assertEquals(await catalog.get("scope", operationId), null);
  } finally {
    remove?.();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
