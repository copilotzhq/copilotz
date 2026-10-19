import { provisionCoreHistoryIndexes } from "../../plugins/core/collections/message/storage.ts";
import { provisionVectorStorage } from "../vectors/index.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotz } from "../../create-copilotz.ts";
import { createCopilotzGateway } from "./gateway.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import { defineProcessor } from "../plugins/processor.ts";
import type { HostCommandContext } from "./host-command-types.ts";

function database() {
  const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
  return createTestDatabase(url ? { url, pgPoolMax: 4 } : {});
}
const schema = () => `host_${crypto.randomUUID().replaceAll("-", "")}`;

Deno.test("host commands atomically mutate replay authorize and separate actual schema scopes", async () => {
  const db = await database();
  const first = schema(), second = schema();
  await provisionCopilotzSchema(db, second);
  await provisionOperationCatalog(db, second);
  const preparedOwner = await openDatabaseOwner(db, second);
  releaseDatabaseOwner(preparedOwner);
  releaseDatabaseOwner(preparedOwner);
  let allowed = true, executions = 0, authorizations = 0;
  const definition = (databaseSchema: string) => ({
    databaseSchema,
    namespace: "space",
    principal: "host-service",
    authorize() {
      authorizations++;
      if (!allowed) throw new Error("denied");
    },
    async execute(
      input: { id: string; fail?: boolean },
      context: HostCommandContext,
    ) {
      executions++;
      await context.query(
        `INSERT INTO "${context.scope.databaseSchema}".nodes(id,namespace,type,name) VALUES($1,$2,'host_record',$1)`,
        [input.id, context.scope.namespace],
      );
      if (input.fail) throw new Error("rollback");
      return { id: input.id };
    },
  });
  const app = await createCopilotz({
    database: db,
    databaseSchema: first,
    hostCommands: { first: definition(first), second: definition(second) },
  });
  try {
    assertEquals(
      await app.hostCommands.invoke("first", { id: "one" }, {
        idempotencyKey: "same",
      }),
      { id: "one" },
    );
    assertEquals(
      await app.hostCommands.invoke("first", { id: "one" }, {
        idempotencyKey: "same",
      }),
      { id: "one" },
    );
    await app.hostCommands.invoke("second", { id: "one" }, {
      idempotencyKey: "same",
    });
    assertEquals(executions, 2);
    assertEquals(authorizations, 3);
    allowed = false;
    await assertRejects(
      () =>
        app.hostCommands.invoke("first", { id: "one" }, {
          idempotencyKey: "same",
        }),
      Error,
      "denied",
    );
    allowed = true;
    await assertRejects(
      () =>
        app.hostCommands.invoke("first", { id: "changed" }, {
          idempotencyKey: "same",
        }),
      Error,
      "intent",
    );
    await assertRejects(
      () =>
        app.hostCommands.invoke("first", { id: "failed", fail: true }, {
          idempotencyKey: "failure",
        }),
      Error,
      "rollback",
    );
    assertEquals(
      (await db.query(`SELECT id FROM "${first}".nodes ORDER BY id`)).rows,
      [{ id: "one" }],
    );
    assertEquals(
      (await db.query(
        `SELECT count(*)::int AS n FROM "${first}".owner_receipts`,
      )).rows[0].n,
      1,
    );
    assertEquals(
      (await db.query(
        `SELECT count(*)::int AS n FROM "${second}".owner_receipts`,
      )).rows[0].n,
      1,
    );
  } finally {
    await app.close();
    await db.close();
  }
});

Deno.test("requested idle schema recovers overdue work before factory readiness without scanning other schemas", async () => {
  const db = await database();
  const primary = schema(), requested = schema(), unopened = schema();
  const handled = Promise.withResolvers<void>();
  const processor = defineProcessor({
    id: "host.startup",
    on: [{ eventType: "overdue.work" }],
    handle() {
      handled.resolve();
    },
  });
  for (const scoped of [requested, unopened]) {
    await provisionCopilotzSchema(db, scoped);
    await provisionOperationCatalog(db, scoped);
    const store = createEventStore({ session: db, schema: scoped });
    await store.append(
      { type: "overdue.work", namespace: "idle", payload: {} },
      ["processor:host.startup"],
    );
    const owner = await openDatabaseOwner(db, scoped);
    // The store's lazy owner and this explicit attachment are both test-owned.
    releaseDatabaseOwner(owner);
    releaseDatabaseOwner(owner);
  }
  const placement: string[] = [];
  const app = await createCopilotz({
    database: db,
    databaseSchema: primary,
    databaseScopes: [requested, requested],
    processors: { startup: processor },
    onDeliveryDiagnostic(event) {
      if (event.phase === "placement_requested") {
        placement.push(event.databaseSchema ?? "");
      }
    },
  });
  try {
    assert(placement.includes(requested));
    assert(!placement.includes(unopened));
    const ownerRows = await db.query<{ epoch: number }>(
      `SELECT epoch FROM "${requested}".owner_epochs WHERE owner='schema'`,
    );
    assertEquals(Number(ownerRows.rows[0].epoch), 2);
    assertEquals(
      Number(
        (await db.query<{ epoch: number }>(
          `SELECT epoch FROM "${unopened}".owner_epochs WHERE owner='schema'`,
        )).rows[0].epoch,
      ),
      1,
    );
    await handled.promise;
  } finally {
    await app.close();
    await db.close();
  }
});

Deno.test("partial explicit scope startup releases every opened owner and preserves retained data", async () => {
  const db = await database();
  const primary = schema(), valid = schema(), missing = schema();
  await provisionCopilotzSchema(db, valid);
  await provisionOperationCatalog(db, valid);
  const preparedOwner = await openDatabaseOwner(db, valid);
  releaseDatabaseOwner(preparedOwner);
  releaseDatabaseOwner(preparedOwner);
  await db.query(
    `INSERT INTO "${valid}".nodes(id,namespace,type,name) VALUES('retained','space','record','retained')`,
  );
  try {
    await assertRejects(() =>
      createCopilotzGateway({
        database: db,
        databaseSchema: primary,
        databaseScopes: [valid, missing],
      })
    );
    assertEquals((await db.query(`SELECT id FROM "${valid}".nodes`)).rows, [{
      id: "retained",
    }]);
    const previousEpochs = new Map<string, number>();
    for (const scoped of [primary, valid]) {
      previousEpochs.set(
        scoped,
        Number(
          (await db.query<{ epoch: number }>(
            `SELECT epoch FROM "${scoped}".owner_epochs WHERE owner='schema'`,
          )).rows[0].epoch,
        ),
      );
    }
    const app = await createCopilotzGateway({
      database: db,
      databaseSchema: primary,
      databaseScopes: [valid],
    });
    try {
      for (const scoped of [primary, valid]) {
        assertEquals(
          Number(
            (await db.query<{ epoch: number }>(
              `SELECT epoch FROM "${scoped}".owner_epochs WHERE owner='schema'`,
            )).rows[0].epoch,
          ),
          previousEpochs.get(scoped)! + 1,
        );
      }
    } finally {
      await app.close();
    }
  } finally {
    await db.close();
  }
});

Deno.test("invalid startup scopes fail before a database connector opens", async () => {
  let opens = 0;
  await assertRejects(
    () =>
      createCopilotz({
        databaseScopes: ["bad;schema"],
        database: {
          connect() {
            opens++;
            throw new Error("must not open");
          },
        },
      }),
    TypeError,
    "schema",
  );
  assertEquals(opens, 0);
});

Deno.test("public provisioning helpers borrow one host command without leaking owner attachments", async () => {
  const db = await database();
  const scoped = schema();
  let retained: HostCommandContext | undefined;
  let runner: ReturnType<typeof createSchemaCommandRunner> | undefined;
  const app = await createCopilotz({
    database: db,
    databaseSchema: scoped,
    hostCommands: {
      setup: {
        namespace: "space",
        principal: "setup-service",
        authorize() {},
        async execute(_input: unknown, context: HostCommandContext) {
          retained = context;
          runner = createSchemaCommandRunner(context, scoped);
          await provisionCoreHistoryIndexes(context, scoped);
          await provisionVectorStorage(context, scoped);
          return { ready: true };
        },
      },
    },
  });
  try {
    assertEquals(
      await app.hostCommands.invoke("setup", null, { idempotencyKey: "setup" }),
      { ready: true },
    );
    await assertRejects(
      () => provisionCoreHistoryIndexes(retained!, scoped),
      Error,
      "closed",
    );
    await assertRejects(
      () => provisionVectorStorage(retained!, scoped),
      Error,
      "closed",
    );
    await assertRejects(
      async () => {
        await runner!(
          "late",
          {},
          (_input, context) => context.transaction.query("SELECT 1"),
        );
      },
      Error,
      "closed",
    );
    assertEquals(
      Number(
        (await db.query<{ epoch: number }>(
          `SELECT epoch FROM "${scoped}".owner_epochs WHERE owner='schema'`,
        )).rows[0].epoch,
      ),
      1,
    );
    assertEquals(
      (await db.query(
        `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname=$1 AND indexname='core_message_thread_created_idx'`,
        [scoped],
      )).rows[0].n,
      1,
    );
    assertEquals(
      (await db.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name='copilotz_vectors'`,
        [scoped],
      )).rows[0].n,
      1,
    );
  } finally {
    await app.close();
  }
  try {
    const reopened = await createCopilotz({
      database: db,
      databaseSchema: scoped,
    });
    try {
      assertEquals(
        Number(
          (await db.query<{ epoch: number }>(
            `SELECT epoch FROM "${scoped}".owner_epochs WHERE owner='schema'`,
          )).rows[0].epoch,
        ),
        2,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await db.close();
  }
});

Deno.test("public host retry after unknown PostgreSQL commit reacquires and replays one receipt", async () => {
  const db = await database();
  const scoped = schema();
  let unknown = false, executions = 0;
  let retained: HostCommandContext | undefined;
  const injected = {
    ...db,
    async transaction<T>(
      run: Parameters<typeof db.transaction<T>>[0],
    ): Promise<T> {
      const value = await db.transaction(run);
      if (unknown) {
        unknown = false;
        throw new Error("connection lost after COMMIT");
      }
      return value;
    },
  };
  const hostCommands = {
    write: {
      namespace: "space",
      principal: "host-service",
      authorize() {},
      async execute(input: { id: string }, context: HostCommandContext) {
        retained = context;
        executions++;
        await context.query(
          `INSERT INTO "${scoped}".nodes(id,namespace,type,name) VALUES($1,'space','host_record',$1)`,
          [input.id],
        );
        return { id: input.id };
      },
    },
  };
  const input = { id: "committed-once" }, key = { idempotencyKey: "uncertain" };
  const first = await createCopilotz({
    database: injected,
    databaseSchema: scoped,
    hostCommands,
  });
  try {
    unknown = true;
    await assertRejects(
      () => first.hostCommands.invoke("write", input, key),
      Error,
      "unknown",
    );
    await assertRejects(() => retained!.query("SELECT 1"));
  } finally {
    await first.close();
  }
  try {
    const next = await createCopilotz({
      database: db,
      databaseSchema: scoped,
      hostCommands,
    });
    try {
      assertEquals(await next.hostCommands.invoke("write", input, key), input);
      await assertRejects(
        () => next.hostCommands.invoke("write", { id: "changed" }, key),
        Error,
        "intent",
      );
      assertEquals(executions, 1);
      assertEquals((await db.query(`SELECT id FROM "${scoped}".nodes`)).rows, [
        input,
      ]);
    } finally {
      await next.close();
    }
  } finally {
    await db.close();
  }
});
