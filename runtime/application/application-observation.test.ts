import { assert, assertEquals } from "@std/assert";
import { createCopilotzApplication } from "./application.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOperationCatalog,
  createStreamOutputDescriptor,
  encodeOperationReplayCursor,
  type StreamOutput,
} from "../streams/index.ts";
import type { SqlExecutor, SqlNotification } from "../events/index.ts";

Deno.test("attachment pages consumed lanes once and coalesces byte notifications", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "observation_incremental";
  const namespace = "tenant";
  const operationId = "operation";
  const notifications = new Set<(notice: SqlNotification) => void>();
  const listings: Array<{ at: number; after?: string; rows: number }> = [];
  const query: SqlExecutor["query"] = async (sql, params) => {
    const at = performance.now();
    const result = await db.query(sql, params);
    if (sql.includes("ORDER BY stream_ordinal LIMIT")) {
      listings.push({
        at,
        after: params?.length === 4 ? String(params[2]) : undefined,
        rows: result.rows.length,
      });
    }
    return result as never;
  };
  const application = await createCopilotzApplication({
    database: {
      query,
      transaction: db.transaction,
      close: db.close,
      listen(_channel, handler) {
        notifications.add(handler);
        return Promise.resolve({
          close() {
            notifications.delete(handler);
            return Promise.resolve();
          },
        });
      },
    },
    databaseSchema: schema,
    namespace,
    plugins: [],
  });
  try {
    const catalog = createOperationCatalog(db, schema);
    await db.transaction((transaction) =>
      catalog.indexEvent(transaction, {
        namespace,
        operationId,
        eventId: operationId,
        position: "1",
        correlationId: "correlation",
        createdAt: new Date().toISOString(),
      })
    );
    const descriptor = createStreamOutputDescriptor({
      id: "placeholder",
      semanticId: "placeholder",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    }, { namespace });
    await db.query(
      `INSERT INTO "${schema}"."copilotz_operation_streams" (
         namespace, operation_id, stream_ordinal, stream_id, semantic_stream_id,
         body_id, descriptor, state, outcome, availability, capture,
         asset_retention, committed_offset, terminal_at, created_at, updated_at
       ) SELECT $1, $2, lane, 'lane-' || lane, 'lane-' || lane, 'body-' || lane,
          jsonb_set($3::jsonb, '{streamId}', to_jsonb('lane-' || lane)),
          CASE WHEN lane = 1002 THEN 'open' ELSE 'terminal' END,
          CASE WHEN lane = 1002 THEN NULL ELSE 'completed' END,
          'retained', CASE WHEN lane = 1002 THEN NULL ELSE 'complete' END,
          'observation', 0, CASE WHEN lane = 1002 THEN NULL ELSE NOW() END,
          NOW(), NOW()
       FROM generate_series(1, 1002) AS lane`,
      [namespace, operationId, JSON.stringify(descriptor)],
    );
    listings.length = 0;
    const attachment = await application.attach({
      operationId,
      cursor: encodeOperationReplayCursor({
        operationStreamPositions: {
          [operationId]: { highWatermark: 1001, offsets: {} },
        },
      }),
    });
    const reader = attachment.outputs.getReader();
    const first = await reader.read();
    assertEquals(first.value?.type, "stream.output");
    assertEquals((first.value as StreamOutput).streamOrdinal, "1002");
    const started = performance.now();
    for (let index = 0; index < 100; index++) {
      for (const notify of notifications) {
        notify({ channel: "copilotz_operations", payload: operationId });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const elapsed = performance.now() - started;
    await attachment.detach("test_complete");
    await attachment.done;
    assertEquals(
      listings.slice(0, 2).map((entry) => [entry.after, entry.rows]),
      [
        [undefined, 1000],
        ["1000", 2],
      ],
    );
    assertEquals(
      listings.slice(2).every((entry) => entry.after === "1002"),
      true,
    );
    assertEquals(listings.reduce((sum, entry) => sum + entry.rows, 0), 1002);
    const iterations = [listings[0], ...listings.slice(2)];
    for (let index = 1; index < iterations.length; index++) {
      assert(
        iterations[index].at - iterations[index - 1].at >= 230,
        JSON.stringify(iterations),
      );
    }
    assert(iterations.length <= Math.ceil(elapsed / 250) + 1);
    console.log(
      JSON.stringify({
        notifications: 100,
        iterations: iterations.length,
        streamListingQueries: listings.length,
        streamListingRows: 1002,
      }),
    );
  } finally {
    await application.shutdown();
    await db.close();
  }
});

Deno.test("attachment byte readers wake while the outer loop is coalescing", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const { definePlugin, defineProcessor } = await import("../plugins/index.ts");
  let writer!: import("../streams/types.ts").ContentStreamWriter;
  let streamRuntime!: import("../streams/types.ts").ContentStreamRuntime;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => opened = resolve);
  let release!: () => void;
  const finish = new Promise<void>((resolve) => release = resolve);
  let listings = 0;
  const query: SqlExecutor["query"] = (sql, params) => {
    if (sql.includes("ORDER BY stream_ordinal LIMIT")) listings++;
    return db.query(sql, params);
  };
  const application = await createCopilotzApplication({
    database: { query, transaction: db.transaction, close: db.close },
    databaseSchema: "observation_bytes",
    namespace: "tenant",
    plugins: [definePlugin({
      id: "observation-bytes",
      version: "1",
      processors: {
        stream: defineProcessor<import("../plugins/index.ts").ProcessorContext>(
          {
            id: "observation-bytes.stream",
            on: [{ eventType: "test.stream" }],
            async handle(_event, context) {
              streamRuntime = context.streams;
              writer = await context.streams.open({
                mediaType: "text/plain",
                role: "assistant",
              });
              opened();
              await finish;
              await writer.close({ assetId: "bytes-asset" });
            },
          },
        ),
      },
    })],
  });
  try {
    const sent = await application.send({ type: "test.stream" });
    await ready;
    const attachment = await application.attach({
      operationId: sent.operationId,
    });
    const outputs = attachment.outputs.getReader();
    const first = await outputs.read();
    assertEquals(first.value?.type, "stream.output");
    const payload = (first.value as StreamOutput).payload.getReader();
    const bytes = payload.read();
    // Let the byte reader reach its own operation watch before appending.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writer.append({
      bytes: new TextEncoder().encode("immediate"),
      appendId: "one",
    });
    assertEquals(new TextDecoder().decode((await bytes).value), "immediate");
    assertEquals(
      listings,
      1,
      "byte progress should arrive before the next outer catalog pass",
    );
    // Concurrent allocation must expose both new ordinals exactly once after
    // the initial topology cursor, even while offset hints keep arriving.
    const concurrent = await Promise.all(
      [1, 2].map((index) =>
        streamRuntime.open({
          id: `concurrent-${index}`,
          mediaType: "text/plain",
          role: "assistant",
        })
      ),
    );
    const lanes: string[] = [];
    while (lanes.length < 2) {
      const next = await outputs.read();
      if (next.value?.type === "stream.output") {
        lanes.push((next.value as StreamOutput).streamOrdinal!);
      }
    }
    assertEquals(lanes.sort(), ["2", "3"]);
    for (const stream of concurrent) await stream.abort();
    await payload.cancel("test_complete");
    await attachment.detach("test_complete");
    release();
    await sent.done;
  } finally {
    release();
    await application.shutdown();
    await db.close();
  }
});

Deno.test("attachment final pass includes a stream committed during the terminal status read", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "observation_terminal_race";
  let inject = false;
  let injected = false;
  let streamListings = 0;
  const descriptor = createStreamOutputDescriptor({
    id: "late-stream",
    semanticId: "late-stream",
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    metadata: {},
  }, { namespace: "tenant" });
  const query: SqlExecutor["query"] = async (sql, params) => {
    const result = await db.query(sql, params);
    if (sql.includes("ORDER BY stream_ordinal LIMIT")) {
      streamListings++;
    }
    // The first event-index read marks this pass advanced. Commit the final
    // stream and terminal status after topology was read, before statusFor.
    if (
      inject && !injected && sql.includes("SELECT event_id, event_position")
    ) {
      injected = true;
      await db.query(
        `INSERT INTO "${schema}"."copilotz_operation_streams" (
        namespace, operation_id, stream_ordinal, stream_id, semantic_stream_id,
        body_id, descriptor, state, outcome, availability, capture,
        asset_retention, committed_offset, terminal_at, created_at, updated_at
      ) VALUES ('tenant','operation',1,'late-stream','late-stream','late-body',$1::jsonb,
        'terminal','completed','missing','complete','observation',0,NOW(),NOW(),NOW())`,
        [JSON.stringify(descriptor)],
      );
      await db.query(`UPDATE "${schema}"."copilotz_operations"
        SET state = 'completed', completed_at = NOW() WHERE operation_id = 'operation'`);
    }
    return result as never;
  };
  const application = await createCopilotzApplication({
    database: { query, transaction: db.transaction, close: db.close },
    databaseSchema: schema,
    namespace: "tenant",
    plugins: [],
  });
  try {
    const catalog = createOperationCatalog(db, schema);
    await db.transaction((transaction) =>
      catalog.indexEvent(transaction, {
        namespace: "tenant",
        operationId: "operation",
        eventId: "operation",
        position: "1",
        correlationId: "correlation",
        createdAt: new Date().toISOString(),
      })
    );
    // Keep initial statusFor active; the race is injected only after attach's
    // topology read. A durable terminal transition remains authoritative.
    await db.query(`INSERT INTO "${schema}"."events" (
      id,schema_version,type,namespace,payload,metadata,correlation_id
    ) VALUES ('operation',5,'test.root','tenant','{}','{}','correlation')`);
    await db.query(`INSERT INTO "${schema}"."event_deliveries" (
      id,event_id,consumer_id,status,attempts,available_at,created_at,updated_at,settlement_scope_id
    ) VALUES ('pending','operation','consumer','pending',0,NOW(),NOW(),NOW(),'operation')`);
    inject = true;
    const attachment = await application.attach({ operationId: "operation" });
    const types: string[] = [];
    for await (const output of attachment.outputs) {
      types.push(output.type);
      if (output.type === "stream.output") {
        assertEquals(
          await new Response((output as StreamOutput).payload).text(),
          "",
        );
      }
    }
    await attachment.done;
    assertEquals(types, ["test.root", "stream.output", "operation.completed"]);
    assertEquals(streamListings, 3);
  } finally {
    await application.shutdown();
    await db.close();
  }
});
