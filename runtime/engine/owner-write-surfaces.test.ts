import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { secret } from "../actions/index.ts";
import { assert, assertEquals, assertExists } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzEngine } from "./engine.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { defineCollection, provisionNodeIndex } from "../collections/index.ts";
import { createEventStore, type SqlSession } from "../events/index.ts";
import { createDatabaseBodyStore } from "../content/database-body-store.ts";
import { provisionVectorStorage } from "../vectors/index.ts";
import { createStreamOutputDescriptor } from "../streams/observation.ts";

Deno.test("public storage mutations use the schema owner fence", async (test) => {
  const db = await createTestDatabase({ pgliteExtensions: ["vector"] });
  const schema = "owner_write_surfaces";
  let enforcing = false;
  const transactions: string[][] = [];
  const session: SqlSession = {
    query(sql, params) {
      if (enforcing) {
        assert(
          !/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql),
          "storage mutation bypassed the owner transaction",
        );
      }
      return db.query(sql, params);
    },
    transaction(run) {
      const statements: string[] = [];
      if (enforcing) transactions.push(statements);
      return db.transaction((transaction) =>
        run({
          query(sql, params) {
            if (enforcing && !statements.length) {
              assert(
                sql.includes("owner_epochs") &&
                  sql.includes("SET holder=holder"),
                "first statement must lock and check the epoch",
              );
            }
            statements.push(sql);
            return transaction.query(sql, params);
          },
        })
      );
    },
  };
  const record = defineCollection({
    name: "record",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
      },
      required: ["id", "text"],
    } as const,
  });
  const engine = await createCopilotzEngine({
    session,
    secretAdapter: await testSecretAdapter(),
    defaultDatabaseSchema: schema,
    registry: createPluginRegistry({ collections: { record } }),
  });
  const scope = await engine.databaseScope(schema);
  const store = createEventStore({ session, schema, retryBaseMs: 0 });
  const bodies = createDatabaseBodyStore({ session, schema });
  enforcing = true;
  async function surface(name: string, execute: () => Promise<unknown>) {
    await test.step(name, async () => {
      const before = transactions.length;
      await execute();
      assert(
        transactions.length > before,
        `${name} must issue an owner command`,
      );
    });
  }
  try {
    await surface("provisioning", async () => {
      await provisionVectorStorage(session, schema);
      await provisionNodeIndex(session, schema, {
        name: "records_by_name",
        fields: ["namespace", "type", { data: "text" }],
      });
    });
    await surface("collection, relation and vector plans", async () => {
      await scope.collections.transaction({
        namespace: "space",
        operationKey: "graph",
        async execute(tx) {
          await tx.collections.record.create({ id: "a", text: "a" });
          await tx.collections.record.create({ id: "b", text: "b" });
          await tx.relations.upsert({
            id: "edge",
            type: "links",
            source: { type: "record", id: "a" },
            target: { type: "record", id: "b" },
          });
          await tx.vectors.upsert({
            ownerType: "record",
            ownerId: "a",
            field: "text",
            sourceField: "text",
            source: "a",
            profile: {
              model: "test",
              revision: "1",
              dimensions: 2,
              metric: "cosine",
            },
            values: [1, 0],
          });
        },
      });
      await scope.collections.withScope({ namespace: "space" }).record.delete({
        id: "b",
      });
    });
    await surface("event append and delivery lifecycle", async () => {
      const root = await store.append(
        { type: "test.write", namespace: "space", payload: {} },
        ["one", "two", "three", "four"],
        { maxAttempts: 2 },
      );
      const [a, b, c, d] = root.deliveries;
      assertExists(await store.claimDelivery({ id: a.id, owner: "attempt" }));
      assert(await store.heartbeatDelivery({ id: a.id, owner: "attempt" }));
      assertEquals(
        (await store.failDelivery({
          id: a.id,
          owner: "attempt",
          error: new Error("retry"),
          backoffMs: 0,
        }))?.status,
        "retry_wait",
      );
      await store.claimDelivery({ id: a.id, owner: "retry" });
      assertEquals(
        (await store.succeedDelivery(a.id, "retry"))?.status,
        "succeeded",
      );
      await store.claimNext({ owner: "other", consumerIds: [b.consumerId] });
      await store.cancelDelivery(b.id, "other");
      await store.claimDelivery({ id: c.id, owner: "failed" });
      await store.failDelivery({
        id: c.id,
        owner: "failed",
        error: new Error("terminal"),
        retryable: false,
      });
      await store.cancelDelivery(d.id);
      const expiring = await store.append(
        { type: "test.expiry", namespace: "space", payload: {} },
        ["expired"],
        { maxAttempts: 1 },
      );
      await store.claimDelivery({
        id: expiring.deliveries[0].id,
        owner: "expired",
        leaseMs: 0,
      });
      assertEquals((await store.recoverExpiredDeliveries()).length, 1);
      await store.cancelScope("space", root.event.id);
      await store.compactDeliveries({
        retentionMs: 0,
        now: new Date(Date.now() + 1000),
      });
    });
    await surface("database body bytes and asset adoption", async () => {
      const writer = await bodies.reserve({
        bodyId: "stream-body",
        mediaType: "text/plain",
      });
      await bodies.append({
        writer,
        expectedOffset: 0,
        appendId: "part",
        bytes: new TextEncoder().encode("body"),
      });
      await bodies.renew({ writer });
      await bodies.seal({ writer, expectedByteLength: 4 });
      await scope.content.assets.publish({
        namespace: "space",
        id: "asset",
        idempotencyKey: "asset",
        mediaType: "text/plain",
        body: new TextEncoder().encode("asset"),
      });
      const prepared = await scope.content.preparer.prepare("materialized", {
        namespace: "space",
        idempotencyKey: "materialized",
      });
      await scope.content.assets.materialize({
        namespace: "space",
        content: prepared,
      });
    });
    await surface("protected values and immutable event bodies", async () => {
      const result = await engine.events.appendProtected({
        type: "test.protected",
        deduplicationId: "protected",
        namespace: "space",
        payload: { token: "private" },
      }, {
        type: "object",
        properties: { token: secret({ type: "string" }) },
        required: ["token"],
      }, "protected-owner");
      assertEquals(
        (await engine.events.resolve("space", result.event.id))?.data,
        { token: { "$copilotz-secret": true } },
      );
      assert(
        !JSON.stringify(
          (await engine.events.get("space", result.event.id))?.payload,
        ).includes("private"),
      );
    });
    await surface("operation catalog and stream settlement", async () => {
      const catalog = scope.operations;
      const root = await engine.events.append({
        type: "test.catalog",
        namespace: "space",
        payload: {},
      });
      const operationId = root.event.id;
      const descriptor = createStreamOutputDescriptor({
        id: "stream",
        semanticId: "stream",
        mediaType: "text/plain",
        kind: "text",
        role: "assistant",
        metadata: {},
      }, { namespace: "space" });
      await catalog.openStream({
        namespace: "space",
        operationId,
        semanticStreamId: "stream",
        bodyId: "stream-body",
        descriptor,
      });
      await catalog.commitStreamOffset({
        namespace: "space",
        operationId,
        streamId: "stream",
        committedOffset: 4,
      });
      const body = await bodies.head({ bodyId: "stream-body" });
      assertExists(body);
      assert(body.state === "ready");
      await catalog.sealStream({
        namespace: "space",
        operationId,
        streamId: "stream",
        body,
      });
      await catalog.retainStream({
        namespace: "space",
        operationId,
        streamId: "stream",
        retention: "observation",
      });
      await catalog.reconcile();
    });
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
