import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotz } from "../copilotz.ts";
import { defineCollection } from "../../collections/index.ts";
import { defineAction } from "../../actions/index.ts";
import { createTestDatabase } from "../../testing/ominipg.ts";

Deno.test("inline host admission commits observable replayable collection results in one transaction", async () => {
  const database = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `inline_${crypto.randomUUID().replaceAll("-", "")}`;
  let transactions = 0;
  let executions = 0;
  const counted = {
    ...database,
    transaction: ((run) => {
      transactions++;
      return database.transaction(run);
    }) as typeof database.transaction,
  };
  const options = {
    database: counted,
    databaseSchema: schema,
    namespace: "inline",
    collections: {
      entry: defineCollection({
        name: "inline_entry",
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      }),
    },
    actions: {
      echo: defineAction({
        id: "inline.echo",
        execute: (value: unknown) => {
          executions++;
          return value;
        },
      }),
    },
  };
  let app = await createCopilotz(options);
  try {
    transactions = 0;
    const created = await app.collections.entry.create({
      id: "one",
      text: "first",
    }, { idempotencyKey: "create" });
    assertEquals(transactions, 1);
    const [operation] = await app.listOperations();
    assertEquals(operation.state, "completed");
    assertEquals(
      (await database.query(
        `SELECT count(*)::int AS n FROM "${schema}".event_deliveries`,
      )).rows[0].n,
      0,
    );
    const unchanged = await app.collections.entry.update({
      id: "one",
      set: { text: "first" },
    }, { idempotencyKey: "noop" });
    assertEquals(unchanged, created);
    await app.collections.entry.update({ id: "one", set: { text: "later" } });
    await app.close();
    app = await createCopilotz(options);
    assertEquals(
      await app.collections.entry.update(
        { id: "one", set: { text: "first" } },
        { idempotencyKey: "noop" },
      ),
      created,
    );
    assertEquals(
      await app.collections.entry.create({ id: "one", text: "first" }, {
        idempotencyKey: "create",
      }),
      created,
    );
    transactions = 0;
    assertEquals(
      await app.actions.echo({ ok: true }, { idempotencyKey: "echo" }),
      { ok: true },
    );
    assertEquals(transactions, 2);
    assertEquals(executions, 1);
    await app.close();
    app = await createCopilotz(options);
    assertEquals(
      await app.actions.echo({ ok: true }, { idempotencyKey: "echo" }),
      { ok: true },
    );
    assertEquals(executions, 1);
    await assertRejects(() =>
      app.actions.echo({ ok: false }, { idempotencyKey: "echo" })
    );
    assertEquals(executions, 1);
    const events = await database.query<{ type: string }>(
      `SELECT type FROM "${schema}".events`,
    );
    assert(
      !events.rows.some((row) =>
        row.type.startsWith("copilotz.server.internal.invoke")
      ),
    );
  } finally {
    await app.close();
    await database.query(`DROP SCHEMA "${schema}" CASCADE`);
    await database.close();
  }
});

Deno.test("inline host replay preserves a retained durable ingress mutation identity", async () => {
  const { createCopilotzApplication } = await import("../application.ts");
  const { admitCollectionMutationRequest } = await import("./admit.ts");
  const { hostIngressProof } = await import("./authority.ts");
  const {
    SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
    SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA,
  } = await import("./contracts.ts");
  const app = await createCopilotzApplication({
    namespace: "legacy",
    collections: {
      entry: defineCollection({
        name: "legacy_entry",
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      }),
    },
  });
  try {
    const handle = await admitCollectionMutationRequest(
      app,
      {
        namespace: "legacy",
        type: SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
        correlationId: "host:old",
        deduplicationId: "host:old",
        payload: {
          schema: SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA,
          requestId: "host:old",
          collectionAlias: "entry",
          operation: "create",
          input: { id: "one", text: "old" },
        },
      },
      undefined,
      hostIngressProof(),
    );
    const drain = (async () => {
      for await (const _output of handle.outputs) { /* result-only caller */ }
    })();
    await handle.done;
    await drain;
    await handle.detach();
    const old = await app.host.collections.entry.get({ id: "one" });
    await app.host.collections.entry.update({
      id: "one",
      set: { text: "new" },
    });
    assertEquals(
      await app.host.collections.entry.create({ id: "one", text: "old" }, {
        idempotencyKey: "old",
      }),
      old,
    );
    assertEquals(
      (await app.host.collections.entry.get({ id: "one" }))?.text,
      "new",
    );
  } finally {
    await app.close();
  }
});
