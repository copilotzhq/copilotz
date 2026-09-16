import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createEventCoordinator,
  createEventStore,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createCollectionKernel } from "../collections/kernel.ts";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  provisionVectorStorage,
  validateVector,
  type VectorProfile,
  vectorTable,
  type VectorWrite,
} from "./index.ts";

const profile: VectorProfile = {
  model: "test",
  revision: "1",
  dimensions: 2,
  metric: "cosine",
};
Deno.test("vector validation rejects dimension, finite-value and zero-norm errors", () => {
  for (const values of [[1], [0, 0], [Infinity, 1], [NaN, 1]]) {
    assertThrows(() => validateVector(profile, values), TypeError);
  }
  assertEquals(validateVector(profile, [1, 0]), "[1,0]");
});
for (
  const url of [
    ":memory:",
    ...(Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")
      ? [Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")!]
      : []),
  ]
) {
  Deno.test(`vectors: atomic writes, authorization, profile isolation, staleness, replay and delete (${url === ":memory:" ? "PGlite" : "PostgreSQL"})`, async () => {
    const db = await createTestDatabase({ url, pgliteExtensions: ["vector"] });
    const schema = "vectors_" + crypto.randomUUID().replaceAll("-", "");
    try {
      await provisionCopilotzSchema(db, schema);
      await provisionVectorStorage(db, schema);
      const store = createEventStore({ session: db, schema });
      const registry = createPluginRegistry({});
      const executor = createDeliveryExecutor({
        store,
        registry,
        createContext: createTestProcessorContext,
        workerId: "vectors",
      });
      const coordinator = createEventCoordinator({ store, registry, executor });
      const kernel = createCollectionKernel({
        session: db,
        eventStore: store,
        coordinator,
      });
      const documents = kernel.bind(
        defineCollection({
          name: "document",
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              summary: { type: "string" },
              access: { type: "string" },
            },
            required: ["summary", "access"],
          },
        }),
      );
      const write = (id: string, values: readonly number[]): VectorWrite => ({
        ownerType: "document",
        ownerId: id,
        field: "summary",
        sourceField: "summary",
        source: id,
        profile,
        values,
      });
      const commit = () =>
        kernel.transaction({
          namespace: "tenant-a",
          operationKey: "create-docs",
          async execute(tx) {
            for (
              const [id, access, values] of [["secret", "private", [1, 0]], [
                "visible",
                "public",
                [0.8, 0.2],
              ]] as const
            ) {
              await tx.collections.document.create({ id, summary: id, access });
              await tx.vectors.upsert(write(id, values));
            }
          },
        });
      await commit();
      await commit();
      const query = {
        ownerType: "document",
        field: "summary",
        profile,
        values: [1, 0],
        filter: { field: "access", eq: "public" } as const,
        limit: 1,
      };
      const matches = await kernel.vectors("tenant-a").search(query);
      assertEquals(matches.map((x) => x.record.id), ["visible"]);
      assertEquals("embedding" in matches[0].record, false);
      assertEquals(await kernel.vectors("tenant-b").search(query), []);
      assertEquals(
        await kernel.vectors("tenant-a").search({
          ...query,
          profile: { ...profile, revision: "2" },
        }),
        [],
      );
      await assertRejects(
        () =>
          kernel.transaction({
            namespace: "tenant-a",
            operationKey: "rollback",
            async execute(tx) {
              await tx.collections.document.create({
                id: "rollback",
                summary: "rollback",
                access: "public",
              });
              await tx.vectors.upsert({
                ...write("rollback", [1, 0]),
                source: "wrong",
              });
            },
          }),
        Error,
        "source revision",
      );
      assertEquals(await documents.get("rollback", "tenant-a"), null);
      // Unawaited vector writes remain registered in the same transaction plan.
      await kernel.transaction({
        namespace: "tenant-a",
        operationKey: "unawaited",
        async execute(tx) {
          await tx.collections.document.create({
            id: "queued",
            summary: "queued",
            access: "private",
          });
          void tx.vectors.upsert(write("queued", [1, 0]));
        },
      });
      const count = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${vectorTable(schema)}`,
      );
      assertEquals(count.rows[0].count, "3");
      await kernel.rebuild("tenant-a");
      assertEquals(
        (await kernel.vectors("tenant-a").search(query)).map((x) =>
          x.record.id
        ),
        ["visible"],
      );
      await documents.update("visible", { set: { summary: "changed" } }, {
        namespace: "tenant-a",
      });
      assertEquals(await kernel.vectors("tenant-a").search(query), []);
      await documents.delete("secret", { namespace: "tenant-a" });
      const deleted = await db.query(
        `SELECT owner_id FROM ${vectorTable(schema)} WHERE owner_id='secret'`,
      );
      assertEquals(deleted.rows, []);
      await executor.shutdown();
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.close();
    }
  });
}

Deno.test("vector SQL ranks beyond 1000 candidates and transfers only authorized results", async () => {
  const db = await createTestDatabase({
    url: ":memory:",
    pgliteExtensions: ["vector"],
  });
  const schema = "vector_rank";
  try {
    await provisionCopilotzSchema(db, schema);
    await provisionVectorStorage(db, schema);
    await db.query(`INSERT INTO "${schema}".nodes (id,namespace,type,name,data)
    SELECT 'rank-'||i, 'tenant', 'document', 'item-'||i, jsonb_build_object('summary','item-'||i,'access',CASE WHEN i=1202 THEN 'private' ELSE 'public' END)
    FROM generate_series(1,1202) i`);
    await db.query(
      `INSERT INTO "${schema}".copilotz_vectors (namespace,owner_type,owner_id,field,profile,dimensions,source_field,source_revision,value)
    SELECT namespace,type,id,'summary',$1,2,'summary',md5(data->>'summary'), CASE WHEN id IN ('rank-1201','rank-1202') THEN '[1,0]'::vector ELSE '[0,1]'::vector END FROM "${schema}".nodes`,
      [JSON.stringify(["test", "1", 2, "cosine"])],
    );
    let statement = "";
    let parameters: unknown[] = [];
    const executor = {
      query<T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) {
        statement = sql;
        parameters = params ?? [];
        return db.query<T>(sql, params);
      },
    };
    const { searchVectors } = await import("./index.ts");
    const started = performance.now();
    const matches = await searchVectors(executor, schema, "tenant", {
      ownerType: "document",
      field: "summary",
      profile,
      values: [1, 0],
      filter: { field: "access", eq: "public" },
      limit: 1,
    });
    assertEquals(matches.map((x) => x.record.id), ["rank-1201"]);
    const queryMs = Math.round((performance.now() - started) * 100) / 100;
    const plan = await db.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`,
      parameters,
    );
    const encoded = JSON.stringify(plan.rows);
    assertEquals(encoded.includes("Limit"), true);
    console.log(JSON.stringify({
      candidateRows: 1202,
      authorizedRows: 1201,
      returnedRows: matches.length,
      resultBytes: new TextEncoder().encode(JSON.stringify(matches)).length,
      queryMs,
    }));
  } finally {
    await db.close();
  }
});
