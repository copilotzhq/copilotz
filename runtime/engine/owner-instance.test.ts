import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  attachedDatabaseOwner,
  bindSchemaOwner,
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "./commands.ts";
import { createSqlSession, provisionCopilotzSchema } from "../events/index.ts";
import {
  bindSqlTransactionAlias,
  runSqlTransaction,
} from "../events/session.ts";
import { createOminipgSqlSession } from "../persistence/ominipg.ts";
import { toFileUrl } from "@std/path";
import { createCopilotz, defineAction } from "@copilotz/copilotz";
import { defineCollection } from "@copilotz/copilotz/collections";
import { listen } from "@copilotz/copilotz/adapters/deno";
import {
  createCopilotzPersistence,
  openManagedOminipgDatabase,
  provisionVectorStorage,
} from "@copilotz/copilotz/persistence";

const postgres = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const directoryEntry = defineCollection({
  name: "directoryEntry",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, schema: { type: "string" } },
    required: ["id", "schema"],
  },
});
const collections = { directoryEntry };
const actions = {
  echo: defineAction({
    id: "instance.echo",
    execute: (input: { value: number }) => input.value,
  }),
};

for (const backend of ["PGlite", "PostgreSQL"] as const) {
  Deno.test({
    name:
      `${backend}: sequential native runtimes bind to new database instances after complete host teardown`,
    ignore: backend === "PostgreSQL" && !postgres,
    async fn(t) {
      const directory = await Deno.makeTempDir({
        prefix: "plat-owner-instance-",
      });
      let url = backend === "PostgreSQL"
        ? postgres!
        : toFileUrl(`${directory}/database`).href;
      const schema = "public";
      const privateSchema = "tenant_fixture";
      let admin:
        | Awaited<ReturnType<typeof openManagedOminipgDatabase>>
        | undefined;
      let temporaryDatabase: string | undefined;
      const instances: object[] = [];
      const holders: string[] = [];
      const epochs: number[] = [];
      const closedStates: string[] = [];
      try {
        if (backend === "PostgreSQL") {
          const location = new URL(postgres!);
          const prefix = location.pathname.slice(1).replaceAll(
            /[^a-zA-Z0-9_]/g,
            "_",
          ).slice(0, 16);
          const name = `${prefix}_instance_${
            crypto.randomUUID().replaceAll("-", "")
          }`;
          admin = await openManagedOminipgDatabase({
            url: postgres!,
            pgPoolMax: 1,
          });
          await admin.session.query(`CREATE DATABASE "${name}"`);
          temporaryDatabase = name;
          location.pathname = `/${name}`;
          url = location.href;
        }
        for (let lifecycle = 0; lifecycle < 2; lifecycle++) {
          assert(
            await t.step(
              lifecycle === 0 ? "A fully closes" : "B opens a new instance",
              async () => {
                const managed = await openManagedOminipgDatabase({
                  url,
                  pgliteExtensions: ["vector"],
                });
                const database = managed.database;
                instances.push(database);
                const persistence = await createCopilotzPersistence({
                  database,
                });
                try {
                  // Host provisioning uses a public helper on the raw database while
                  // its native gateway owns an adapter of that same database instance.
                  if (lifecycle === 0) {
                    const provisioning = await createCopilotz({
                      role: "gateway",
                      database,
                      databaseSchema: schema,
                      collections,
                    });
                    try {
                      await provisionVectorStorage(database, schema);
                    } finally {
                      await provisioning.close();
                    }
                  }
                  const privateOwner = await createCopilotz({
                    role: "gateway",
                    database,
                    databaseSchema: privateSchema,
                    collections,
                  });
                  try {
                    await provisionVectorStorage(database, privateSchema);
                  } finally {
                    await privateOwner.close();
                  }
                  const transport = {
                    type: "in-process",
                    config: { topic: crypto.randomUUID() },
                  } as const;
                  const gateway = await createCopilotz({
                    role: "gateway",
                    persistence,
                    databaseSchema: schema,
                    namespace: "directory",
                    collections,
                    actions,
                    transports: [transport],
                    target: { workerId: "instance-worker" },
                  });
                  const worker = await createCopilotz({
                    role: "worker",
                    transport,
                    id: "instance-worker",
                    actions,
                  });
                  const owner = await bindSchemaOwner(database, schema)();
                  const listener = listen(gateway, {
                    hostname: "127.0.0.1",
                    port: 0,
                  });
                  try {
                    await worker.ready;
                    await gateway.maintenance({
                      databaseSchema: privateSchema,
                      namespace: "private",
                      limit: 1,
                    });
                    await gateway.collections.directoryEntry.create({
                      id: "route",
                      schema: privateSchema,
                    });
                    assertEquals(
                      await gateway.actions.echo({ value: lifecycle }),
                      lifecycle,
                    );
                    const row =
                      (await database.query<{ holder: string; epoch: number }>(
                        `SELECT holder,epoch FROM "${schema}".owner_epochs WHERE owner='schema'`,
                      )).rows[0];
                    holders.push(row.holder);
                    epochs.push(Number(row.epoch));
                  } finally {
                    await listener.shutdown();
                    await gateway.collections.directoryEntry.delete({
                      id: "route",
                    });
                    await gateway.close();
                    await worker.close();
                    await persistence.close();
                    closedStates.push(owner.state);
                    await database.query(
                      `DROP SCHEMA "${privateSchema}" CASCADE`,
                    );
                  }
                } finally {
                  await persistence.close();
                  await managed.close();
                }
              },
            ),
          );
        }
        assertEquals(closedStates, ["stopped", "stopped"]);
        assert(instances[0] !== instances[1]);
        assert(holders[0] !== holders[1]);
        assert(epochs[1] > epochs[0]);
      } finally {
        try {
          if (temporaryDatabase) {
            await admin!.session.query(`DROP DATABASE "${temporaryDatabase}"`);
          }
        } finally {
          await admin?.close();
        }
        await Deno.remove(directory, { recursive: true });
      }
    },
  });
}

Deno.test("one instance shares concurrent adapters and helpers without leaking attachments", async () => {
  const managed = await openManagedOminipgDatabase();
  const database = managed.database;
  const schema = "instance_adapters";
  const first = createSqlSession(database);
  const second = createOminipgSqlSession(database);
  const nested = createSqlSession(first);
  await provisionCopilotzSchema(first, schema);
  const owners = await Promise.all([
    openDatabaseOwner(first, schema),
    openDatabaseOwner(second, schema),
    openDatabaseOwner(nested, schema),
  ]);
  const owner = owners[0];
  const oldRun = createSchemaCommandRunner(database, schema);
  try {
    assert(owners.every((value) => value === owner));
    assertEquals(owner.epoch, 1);
    assertStrictEquals(await bindSchemaOwner(database, schema)(), owner);
    await oldRun("fixture.raw", {}, async (_input, command) => {
      await command.transaction.query("SELECT 1");
    });
    await releaseDatabaseOwner(owners[0]);
    await releaseDatabaseOwner(owners[1]);
    assertEquals(owner.signal.aborted, false);
    await releaseDatabaseOwner(owners[2]);
    assertEquals(
      owner.state,
      "stopped",
      "only the three explicit attachments must require release",
    );
    const successor = await openDatabaseOwner(second, schema);
    try {
      assertEquals(successor.epoch, 2);
      await assertRejects(() => oldRun("fixture.stale", {}, () => undefined));
      assertEquals(successor.signal.aborted, false);
    } finally {
      await releaseDatabaseOwner(successor);
    }
  } finally {
    await Promise.all(owners.map(releaseDatabaseOwner));
    await managed.close();
  }
});

Deno.test("helper bootstrap does not retain an unmatched runtime attachment", async () => {
  const managed = await openManagedOminipgDatabase();
  const schema = "instance_bootstrap";
  const run = createSchemaCommandRunner(managed.database, schema);
  try {
    await run("fixture.bootstrap", {}, async (_input, command) => {
      await command.transaction.query("SELECT 1");
    });
    const borrowed = await bindSchemaOwner(managed.session, schema)();
    const attached = await openDatabaseOwner(managed.session, schema);
    assertStrictEquals(attached, borrowed);
    await releaseDatabaseOwner(attached);
    assertEquals(borrowed.state, "stopped");
    await assertRejects(() => run("fixture.closed", {}, () => undefined));
  } finally {
    await managed.close();
  }
});

Deno.test("durable holder and epoch equality cannot join owners across database instances", async () => {
  const first = await openManagedOminipgDatabase();
  const second = await openManagedOminipgDatabase();
  const schema = "instance_coordinates";
  await provisionCopilotzSchema(first.session, schema);
  await provisionCopilotzSchema(second.session, schema);
  const original = await openDatabaseOwner(first.session, schema);
  try {
    // A restored schema may contain the same durable row. It is still a different
    // connection instance, and directory joins must not resolve the source owner.
    await second.session.query(
      `UPDATE "${schema}".owner_epochs SET epoch=$1,holder=$2 WHERE owner='schema'`,
      [original.epoch, original.holderId],
    );
    await assertRejects(
      () =>
        runSqlTransaction(
          second.session,
          (transaction) => attachedDatabaseOwner(transaction, schema),
        ),
      Error,
      "not attached",
    );
    const separate = await openDatabaseOwner(second.session, schema);
    try {
      assert(separate !== original);
      assert(separate.holderId !== original.holderId);
      assertEquals(separate.epoch, original.epoch! + 1);
      await releaseDatabaseOwner(original);
      await first.close();
      const run = createSchemaCommandRunner(second.session, schema);
      assertEquals(
        await run("fixture.second", {}, async (_input, context) => {
          await context.transaction.query("SELECT 1");
          return "second";
        }),
        "second",
      );
    } finally {
      await releaseDatabaseOwner(separate);
    }
  } finally {
    await releaseDatabaseOwner(original);
    await first.close();
    await second.close();
  }
});

Deno.test({
  name:
    "PostgreSQL: another connection acquires its own holder and fences the previous instance",
  ignore: !postgres,
  async fn() {
    const first = await openManagedOminipgDatabase({ url: postgres! });
    const second = await openManagedOminipgDatabase({ url: postgres! });
    const schema = `instance_fence_${crypto.randomUUID().replaceAll("-", "")}`;
    await provisionCopilotzSchema(first.session, schema);
    const oldOwner = await openDatabaseOwner(first.session, schema);
    const oldRun = createSchemaCommandRunner(first.session, schema);
    const current = await openDatabaseOwner(second.session, schema);
    try {
      assert(current !== oldOwner);
      assertEquals(current.epoch, oldOwner.epoch! + 1);
      await assertRejects(
        () => oldRun("fixture.fenced", {}, () => undefined),
        Error,
        "no longer current",
      );
      await releaseDatabaseOwner(oldOwner);
      await first.close();
      const run = createSchemaCommandRunner(second.session, schema);
      await run("fixture.current", {}, async (_input, context) => {
        await context.transaction.query("SELECT 1");
      });
    } finally {
      await releaseDatabaseOwner(oldOwner);
      await releaseDatabaseOwner(current);
      await second.session.query(`DROP SCHEMA "${schema}" CASCADE`);
      await first.close();
      await second.close();
    }
  },
});

Deno.test("joined SQL aliases retain their database instance for directory ownership", async () => {
  const managed = await openManagedOminipgDatabase({
    url: postgres ?? ":memory:",
  });
  const schema = `instance_alias_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(managed.session, schema);
  const owner = await openDatabaseOwner(managed.session, schema);
  try {
    await runSqlTransaction(managed.session, async (transaction) => {
      const alias = { query: transaction.query };
      bindSqlTransactionAlias(alias, transaction);
      assertStrictEquals(await attachedDatabaseOwner(alias, schema), owner);
    });
  } finally {
    await releaseDatabaseOwner(owner);
    await managed.session.query(`DROP SCHEMA "${schema}" CASCADE`);
    await managed.close();
  }
});
