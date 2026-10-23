import {
  createCopilotz,
  defineAction,
  defineProcessor,
} from "@copilotz/copilotz";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotzApplication } from "../application/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import {
  createOwnerCommands,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "./commands.ts";

const selected = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");

Deno.test("final owner release waits for SQL, queued groups and descendant publications", async () => {
  const db = await createTestDatabase(selected ? { url: selected } : {});
  const schema = `drain_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const publish = Promise.withResolvers<void>();
  const completed: number[] = [];
  const write = owner.register("drain.write", {
    authorize() {},
    async execute(input: number, context) {
      if (input === 0) {
        entered.resolve();
        await finish.promise;
      }
      await context.transaction.query("SELECT 1");
      context.afterCommit(async () => {
        if (input === 0) {
          published.resolve();
          await publish.promise;
          await write({ principal: "test", epoch: owner.epoch! }, { input: 3 });
        }
        completed.push(input);
      });
    },
  });
  const caller = { principal: "test", epoch: owner.epoch! };
  const first = write(caller, { input: 0 });
  await entered.promise;
  const queued = [write(caller, { input: 1 }), write(caller, { input: 2 })];
  const closing = releaseDatabaseOwner(owner);
  // All assertions also run inside the held work: premature authority revocation
  // cannot pass just because the test's continuation ran before shutdown.
  finish.resolve();
  try {
    await first;
    await published.promise;
    assertEquals(owner.signal.aborted, false);
    publish.resolve();
    await Promise.all(queued);
    await closing;
    assertEquals(completed.sort(), [0, 1, 2, 3]);
    assert(owner.signal.aborted);
    await assertRejects(() => write(caller, { input: 4 }));
  } finally {
    finish.resolve();
    publish.resolve();
    await Promise.allSettled([first, ...queued, closing]);
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("two native runtimes drain publications before closing distinct databases", async () => {
  const schema = `sequential_${crypto.randomUUID().replaceAll("-", "")}`;
  const holders: string[] = [];
  const databases: object[] = [];
  for (let lifecycle = 0; lifecycle < 2; lifecycle++) {
    const db = await createTestDatabase(selected ? { url: selected } : {});
    databases.push(db);
    let databaseClosed = false;
    const app = await createCopilotzApplication({
      database: db,
      databaseSchema: schema,
      namespace: "test",
    });
    const owner = await openDatabaseOwner(db, schema);
    holders.push(owner.holderId);
    // This diagnostic attachment must not keep the application's owner alive.
    await releaseDatabaseOwner(owner);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let publicationFinished = false;
    let closing: Promise<void> | undefined;
    const command = owner.register("lifecycle.publication", {
      authorize() {},
      execute(_input: null, context) {
        context.afterCommit(async () => {
          entered.resolve();
          await finish.promise;
          assertEquals(databaseClosed, false);
          assertEquals(owner.signal.aborted, false);
          await db.query("SELECT 1");
          publicationFinished = true;
        });
      },
    });
    try {
      await command({ principal: "test", epoch: owner.epoch! }, {
        input: null,
      });
      await entered.promise;
      closing = app.close().then(async () => {
        assert(
          publicationFinished,
          "close returned before publication completion",
        );
        assert(owner.signal.aborted, "final owner attachment leaked");
        databaseClosed = true;
        await db.close();
      });
      finish.resolve();
      await closing;
    } finally {
      finish.resolve();
      await closing?.catch(() => undefined);
      await app.close().catch(() => undefined);
      if (!databaseClosed) await db.close();
    }
  }
  assert(databases[0] !== databases[1]);
  assert(
    holders[0] !== holders[1],
    "successor must acquire a fresh owner holder",
  );
  if (selected) {
    const db = await createTestDatabase({ url: selected });
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("owner close reports publication failure after draining every callback", async () => {
  const db = await createTestDatabase();
  await provisionCopilotzSchema(db, "publication_failure");
  const owner = createOwnerCommands({
    session: db,
    schema: "publication_failure",
    handlers: {},
  });
  await owner.acquire(0);
  let completed = false;
  const command = owner.register("publish", {
    authorize() {},
    execute(_input: null, context) {
      context.afterCommit(() => {
        throw new Error("publication rejected");
      });
      context.afterCommit(() => {
        completed = true;
      });
    },
  });
  try {
    await command({ principal: "test", epoch: owner.epoch! }, { input: null });
    const failure = await assertRejects(() => owner.close(), AggregateError);
    assert(
      String((failure as AggregateError).errors[0]).includes("publication"),
    );
    assert(completed);
    assert(owner.signal.aborted);
  } finally {
    await owner.close().catch(() => undefined);
    await db.close();
  }
});

Deno.test("sequential public gateway and worker lifecycles reuse definitions and worker identity safely", async () => {
  const schema = `gateway_drain_${crypto.randomUUID().replaceAll("-", "")}`;
  const actions = {
    echo: defineAction({
      id: "lifecycle.echo",
      execute: (input: { value: number }) => input.value,
    }),
  };
  const holders: string[] = [];
  for (let lifecycle = 0; lifecycle < 2; lifecycle++) {
    const database = await createTestDatabase(
      selected ? { url: selected } : {},
    );
    const transport = {
      type: "in-process",
      config: { topic: crypto.randomUUID() },
    } as const;
    const gateway = await createCopilotz({
      role: "gateway",
      database,
      databaseSchema: schema,
      namespace: "space",
      transports: [transport],
      target: { workerId: "lifecycle-worker" },
      actions,
    });
    const worker = await createCopilotz({
      role: "worker",
      databaseSchema: schema,
      namespace: "space",
      transport,
      id: "lifecycle-worker",
      actions,
    });
    try {
      await worker.ready;
      assertEquals(
        await gateway.actions.echo({ value: lifecycle }, {
          idempotencyKey: `echo-${lifecycle}`,
        }),
        lifecycle,
      );
      holders.push(
        String(
          (await database.query(
            `SELECT holder FROM "${schema}".owner_epochs WHERE owner='schema'`,
          )).rows[0].holder,
        ),
      );
    } finally {
      await gateway.close();
      await worker.close();
      if (selected && lifecycle === 1) {
        await database.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
      await database.close();
    }
  }
  assert(holders[0] !== holders[1]);
});

Deno.test("runtime close cancels and drains an admitted transient publication", async () => {
  const database = await createTestDatabase();
  const app = await createCopilotzApplication({
    database,
    databaseSchema: "transient_drain",
    namespace: "test",
  });
  const entered = Promise.withResolvers<void>();
  let drained = false;
  await app.bindTransient(defineProcessor({
    id: "transient.held",
    on: [{ eventType: "transient.held" }],
    async handle(_event, context) {
      entered.resolve();
      await new Promise<void>((resolve) =>
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      );
      drained = true;
    },
  }));
  const emitted = assertRejects(
    () =>
      app.engine.events.emit({
        type: "transient.held",
        namespace: "test",
        correlationId: "transient-drain",
        payload: {},
      }),
    AggregateError,
  );
  try {
    await entered.promise;
    await app.close();
    await emitted;
    assert(drained);
  } finally {
    await app.close();
    await database.close();
  }
});
