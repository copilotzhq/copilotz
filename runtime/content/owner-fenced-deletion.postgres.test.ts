import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCollectionKernel } from "../collections/kernel.ts";
import { defineCollection } from "../collections/index.ts";
import {
  createOwnerCommands,
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import {
  createEventCoordinator,
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
  type SqlSession,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  collectionAssetAdopterFor,
  createDatabaseAssetRepository,
} from "./database-repository.ts";
import type { AssetRecord, ContentRef } from "./types.ts";

// These cases require actual PostgreSQL row-lock, commit and snapshot behavior.
const url = Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL")?.trim();
const namespace = "tenant";
const record = defineCollection({
  name: "content_owner",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, body: { type: "array" } },
    required: ["id", "body"],
  } as const,
  content: { fields: ["body"] },
});

async function atBarrier(promise: Promise<void>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Test barrier was not reached.")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function refs(asset: AssetRecord): ContentRef[] {
  return [{
    assetId: asset.id,
    kind: "text",
    role: "body",
    mediaType: asset.mediaType,
  }];
}

async function withFixture(
  test: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const fixture = await createFixture();
  try {
    await test(fixture);
  } finally {
    await fixture.close();
  }
}

async function createFixture() {
  const db = await createTestDatabase({ url: url!, pgPoolMax: 6 });
  const schema = `asset_delete_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const trace: string[][] = [];
  const control: {
    enforce: boolean;
    loseCommit: boolean;
    afterQuery?: (sql: string, params?: unknown[]) => void | Promise<void>;
  } = { enforce: false, loseCommit: false };
  const session: SqlSession = {
    query(sql, params) {
      if (control.enforce) {
        assert(
          !/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql),
          "runtime mutations must enter the schema owner command",
        );
      }
      return db.query(sql, params);
    },
    async transaction(run) {
      const statements: string[] = [];
      if (control.enforce) trace.push(statements);
      const result = await db.transaction((tx) =>
        run({
          async query<Row extends Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ) {
            if (control.enforce && statements.length === 0) {
              assert(
                sql.startsWith(
                  `UPDATE "${schema}"."owner_epochs" SET holder=holder`,
                ),
              );
              assert(
                sql.endsWith(
                  "WHERE owner=$1 AND epoch=$2 AND holder=$3 RETURNING epoch",
                ),
              );
              assertEquals(params?.[0], "schema");
              assertEquals(typeof params?.[1], "number");
              assertEquals(typeof params?.[2], "string");
            }
            statements.push(sql);
            const result = await tx.query<Row>(sql, params);
            await control.afterQuery?.(sql, params);
            return result;
          },
        })
      );
      if (control.loseCommit) {
        control.loseCommit = false;
        throw new Error(
          "test: COMMIT succeeded but its acknowledgement was lost",
        );
      }
      return result;
    },
  };
  const registry = await createPluginRegistry({ collections: { record } });
  const opened: Array<{
    owner: Awaited<ReturnType<typeof openDatabaseOwner>>;
    executor: ReturnType<typeof createDeliveryExecutor>;
  }> = [];
  async function open(session: SqlSession) {
    const owner = await openDatabaseOwner(session, schema);
    const store = createEventStore({ session, schema });
    const executor = createDeliveryExecutor({
      store,
      registry,
      workerId: "asset-delete-proof",
      createContext: createTestProcessorContext,
    });
    opened.push({ owner, executor });
    const published: string[] = [];
    const coordinator = createEventCoordinator({
      store,
      registry,
      executor,
      publish(event) {
        published.push(event.type);
      },
    });
    const assetOptions = {
      coordinator,
      session,
      eventStore: store,
      databaseSchema: schema,
    };
    const assets = createDatabaseAssetRepository(assetOptions);
    const collections = createCollectionKernel({
      coordinator,
      session,
      eventStore: store,
      assets: collectionAssetAdopterFor(assets),
    });
    collections.bind(record);
    return {
      owner,
      store,
      assets,
      assetOptions,
      collections,
      published,
      run: createSchemaCommandRunner(session, schema),
      records: collections.withScope({ namespace }).content_owner,
    };
  }
  const runtime = await open(session);
  control.enforce = true;
  return {
    ...runtime,
    db,
    schema,
    session,
    control,
    trace,
    replace: () => open(db),
    publish(id: string) {
      return runtime.assets.publish({
        namespace,
        id,
        idempotencyKey: id,
        mediaType: "text/plain",
        body: new TextEncoder().encode(id),
      });
    },
    async deletionSnapshot(id: string) {
      return (await db.query(
        `SELECT to_jsonb(e) AS event, to_jsonb(b) AS body
         FROM ${runtime.store.tables.events} e
         JOIN ${runtime.store.tables.event_bodies} b
         ON b.namespace=e.namespace AND b.event_body_id=e.payload->'dataRef'->>'eventBodyId'
         WHERE e.namespace=$1 AND e.type='asset.deleted' AND e.subject_id=$2`,
        [namespace, id],
      )).rows;
    },
    async close() {
      control.afterQuery = undefined;
      control.enforce = false;
      for (const { owner, executor } of opened) {
        await executor.shutdown();
        await releaseDatabaseOwner(owner);
      }
      // Only this fixture's newly created schema is disposable.
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test({
  name:
    "Postgres asset deletion requires command authority and refuses referenced ready assets",
  ignore: !url,
  fn: () =>
    withFixture(async (f) => {
      const asset = await f.publish("referenced");
      const naked = createDatabaseAssetRepository({
        ...f.assetOptions,
        coordinator: {
          ...f.assetOptions.coordinator,
          async commitMutation(input) {
            // Deliberately try to call the production mutator with bare SQL.
            await f.db.transaction((transaction) =>
              input.mutate!({
                transaction,
                tables: f.store.tables,
              })
            );
            throw new Error("bare SQL unexpectedly gained owner authority");
          },
        } satisfies EventCoordinator,
      });
      await assertRejects(
        () => naked.markDeleted(namespace, asset.id),
        Error,
        "current transaction from this database owner",
      );
      await f.records.create({ id: "domain-owner", body: refs(asset) });
      const before = await f.db.query(`SELECT * FROM ${f.store.tables.edges}`);
      await assertRejects(
        () => f.assets.markDeleted(namespace, asset.id),
        Error,
        "still referenced by durable content",
      );
      assertEquals((await f.assets.get(namespace, asset.id))?.state, "ready");
      assertEquals(
        await f.db.query(`SELECT * FROM ${f.store.tables.edges}`),
        before,
      );
      assertEquals(await f.deletionSnapshot(asset.id), []);
      assertEquals(
        new TextDecoder().decode(
          (await f.assets.read(namespace, asset.id)).bytes,
        ),
        asset.id,
      );
    }),
});

Deno.test({
  name:
    "Postgres unowned deletion replays one immutable event after a lost COMMIT acknowledgement",
  ignore: !url,
  fn: () =>
    withFixture(async (f) => {
      const asset = await f.publish("unknown-commit");
      const before = (await f.store.listEvents({ namespace })).length;
      f.control.loseCommit = true;
      await assertRejects(
        () => f.assets.markDeleted(namespace, asset.id),
        Error,
        "commit outcome is unknown",
      );
      assertEquals(f.owner.state, "stopped");
      assertEquals(f.published, ["asset.created"]);
      assertEquals((await f.assets.get(namespace, asset.id))?.state, "deleted");
      const committed = await f.deletionSnapshot(asset.id);
      assertEquals(committed.length, 1);
      const replacement = await f.replace();
      const [first, second] = await Promise.all([
        replacement.assets.markDeleted(namespace, asset.id),
        replacement.assets.markDeleted(namespace, asset.id),
      ]);
      assertEquals(first, second);
      assertEquals(first, await f.assets.get(namespace, asset.id));
      assertEquals(await f.deletionSnapshot(asset.id), committed);
      assertEquals(
        (await replacement.store.listEvents({ namespace })).length,
        before + 1,
      );
      assertEquals(replacement.published, []);
      await assertRejects(
        () =>
          replacement.run(
            "test.immutable-delete",
            {},
            async (_, { transaction }) => {
              await transaction.query(
                `UPDATE ${f.store.tables.events} SET type='rewritten' WHERE type='asset.deleted'`,
              );
            },
          ),
        Error,
        "immutable",
      );
      assertEquals(await f.deletionSnapshot(asset.id), committed);
    }),
});

Deno.test({
  name:
    "Postgres deletion rollback restores the asset and permits a later owning reference",
  ignore: !url,
  fn: () =>
    withFixture(async (f) => {
      const asset = await f.publish("rollback");
      const before = await f.store.listEvents({ namespace });
      let wroteDeletionBody = false;
      f.control.afterQuery = (sql, params) => {
        if (
          sql.startsWith(`INSERT INTO ${f.store.tables.event_bodies}`) &&
          params?.[1] === `asset-event-body:${namespace}:delete:${asset.id}`
        ) {
          wroteDeletionBody = true;
          throw new Error(
            "test: fail after deletion state and event body were written",
          );
        }
      };
      await assertRejects(
        () => f.assets.markDeleted(namespace, asset.id),
        Error,
        "fail after deletion state and event body",
      );
      f.control.afterQuery = undefined;
      assert(wroteDeletionBody);
      assertEquals(f.owner.state, "acquired");
      assertEquals(await f.assets.get(namespace, asset.id), asset);
      assertEquals(await f.store.listEvents({ namespace }), before);
      assertEquals(await f.deletionSnapshot(asset.id), []);
      assertEquals(
        (await f.db.query(
          `SELECT * FROM ${f.store.tables.event_bodies} WHERE event_body_id=$1`,
          [`asset-event-body:${namespace}:delete:${asset.id}`],
        )).rows,
        [],
      );
      await f.records.create({ id: "after-rollback", body: refs(asset) });
      await assertRejects(
        () => f.assets.markDeleted(namespace, asset.id),
        Error,
        "still referenced by durable content",
      );
    }),
});

Deno.test({
  name:
    "Postgres reference/delete races preserve ownership in both command orders",
  ignore: !url,
  fn: () =>
    withFixture(async (f) => {
      const owned = await f.publish("reference-first");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let paused = false;
      f.control.afterQuery = async (sql) => {
        if (
          !paused &&
          sql.startsWith(
            `UPDATE ${f.store.tables.owner_epochs} SET holder=holder`,
          )
        ) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
      };
      const reference = f.records.create({ id: "wins", body: refs(owned) });
      try {
        await atBarrier(entered.promise);
        const refused = assertRejects(
          () => f.assets.markDeleted(namespace, owned.id),
          Error,
          "still referenced by durable content",
        );
        assertEquals((await f.assets.get(namespace, owned.id))?.state, "ready");
        release.resolve();
        await reference;
        await refused;
      } finally {
        release.resolve();
        f.control.afterQuery = undefined;
      }
      const deleted = await f.publish("delete-first");
      const staged = Promise.withResolvers<void>();
      const commit = Promise.withResolvers<void>();
      const delayedReference = f.collections.transaction({
        namespace,
        operationKey: "reference-after-delete",
        async execute({ collections }) {
          await collections.content_owner.create({
            id: "loses",
            body: refs(deleted),
          });
          staged.resolve();
          await commit.promise;
        },
      });
      const rejected = assertRejects(
        () => delayedReference,
        Error,
        "non-ready Asset",
      );
      try {
        await atBarrier(staged.promise);
        await f.assets.markDeleted(namespace, deleted.id);
        commit.resolve();
        await rejected;
      } finally {
        commit.resolve();
      }
      assertEquals(await f.records.get({ id: "loses" }), null);
      assertEquals(
        (await f.db.query<{ source_node_id: string; target_node_id: string }>(
          `SELECT source_node_id,target_node_id FROM ${f.store.tables.edges} WHERE type='has_asset'`,
        )).rows,
        [{ source_node_id: "wins", target_node_id: owned.id }],
      );
      assertEquals((await f.assets.get(namespace, owned.id))?.state, "ready");
      assertEquals(
        (await f.assets.get(namespace, deleted.id))?.state,
        "deleted",
      );
    }),
});

Deno.test({
  name:
    "Postgres takeover blocks on the deletion fence and stale owner cannot mutate another asset",
  ignore: !url,
  fn: () =>
    withFixture(async (f) => {
      const deleting = await f.publish("fenced-delete");
      const retained = await f.publish("stale-must-not-delete");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let held = false;
      f.control.afterQuery = async (sql) => {
        if (
          !held &&
          sql.startsWith(
            `UPDATE ${f.store.tables.owner_epochs} SET holder=holder`,
          )
        ) {
          held = true;
          entered.resolve();
          await release.promise;
        }
      };
      const deletion = f.assets.markDeleted(namespace, deleting.id);
      const successor = createOwnerCommands({
        session: f.db,
        schema: f.schema,
        handlers: {},
      });
      let takeover: Promise<number> | undefined;
      try {
        await atBarrier(entered.promise);
        assertEquals(
          f.trace.at(-1)?.length,
          1,
          "hold immediately after the first fence, before event sequencing or asset reads",
        );
        takeover = successor.acquire(f.owner.epoch!);
        const deadline = Date.now() + 10_000;
        let blocked = false;
        while (!blocked && Date.now() < deadline) {
          const waiting = await f.db.query<{ blocked: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND query LIKE $1 AND cardinality(pg_blocking_pids(pid))>0) AS blocked`,
            [`%${f.store.tables.owner_epochs}%`],
          );
          blocked = waiting.rows[0].blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert(
          blocked,
          "PostgreSQL must show takeover blocked on the held owner epoch fence",
        );
        assertEquals(
          (await f.assets.get(namespace, deleting.id))?.state,
          "ready",
          "uncommitted deletion remains invisible from a different connection",
        );
        release.resolve();
        assertEquals((await deletion).state, "deleted");
        const selected = f.trace.flat().filter((sql) =>
          sql.startsWith(`SELECT * FROM ${f.store.tables.nodes}`) &&
          sql.includes("type = 'asset'")
        );
        assert(selected.length > 0);
        assert(
          selected.every((sql) => !/FOR\s+UPDATE/i.test(sql)),
          "asset selection adds no second row lock",
        );
        assertEquals(await takeover, f.owner.epoch! + 1);
        f.control.afterQuery = undefined;
        const before = f.trace.length;
        await assertRejects(
          () => f.assets.markDeleted(namespace, retained.id),
          Error,
          "no longer current",
        );
        assertEquals(
          f.trace.slice(before).map((tx) => tx.slice(1)),
          [["ROLLBACK AND CHAIN"]],
          "the stale command only confirms rollback after its fence, without asset or edge reads",
        );
        assertEquals(
          (await f.assets.get(namespace, retained.id))?.state,
          "ready",
        );
        assertEquals(await f.deletionSnapshot(retained.id), []);
      } finally {
        release.resolve();
        await deletion.catch(() => undefined);
        await takeover?.catch(() => undefined);
        successor.stop();
        f.control.afterQuery = undefined;
      }
    }),
});

Deno.test({
  name:
    "Postgres logical deletion retains bytes until catalog claim and version-bound retirement",
  ignore: !url,
  fn: () =>
    withFixture(async (f) => {
      const asset = await f.publish("catalog-retirement");
      const body = (await f.assets.catalog.read(asset.bodyId))!;
      const physical = f.assets.storeForCopy(body.copy);
      const head = (await physical.head({ bodyId: body.copy.key }))!;
      assertEquals(
        await f.assets.retireUnownedReadyBody({ store: physical, body: head }),
        { status: "blocked" },
        "live catalog protection prevents physical collection",
      );
      await f.run("test.expire-protection", {}, async (_, { transaction }) => {
        await transaction.query(
          `UPDATE ${f.store.tables.content_logical_bodies} SET protected_until=NOW()-INTERVAL '1 second' WHERE body_id=$1`,
          [asset.bodyId],
        );
      });
      assertEquals(
        await f.assets.retireUnownedReadyBody({ store: physical, body: head }),
        { status: "owned", ownerId: asset.id, ownerType: "asset" },
      );
      await f.assets.markDeleted(namespace, asset.id);
      assert(await physical.head({ bodyId: body.copy.key }));
      assertEquals(
        (await f.db.query(
          `SELECT state FROM ${f.store.tables.content_copies} WHERE copy_key=$1`,
          [body.copy.key],
        )).rows,
        [{ state: "current" }],
      );
      let checkedClaim = false;
      f.control.afterQuery = async (sql) => {
        if (/DELETE FROM .*"content_bodies"/.test(sql)) {
          // This separate connection can see only the already-committed claim.
          const claim = (await f.db.query<
            { state: string; completed: boolean; token: string }
          >(
            `SELECT c.state,r.completed,r.token FROM ${f.store.tables.content_copies} c
           JOIN ${f.store.tables.owner_body_retirements} r ON r.body_id=c.copy_key
           WHERE c.copy_key=$1`,
            [body.copy.key],
          )).rows[0];
          assertEquals(claim, {
            state: "retiring",
            completed: false,
            token: head.versionToken,
          });
          checkedClaim = true;
        }
      };
      assertEquals(
        await f.assets.retireUnownedReadyBody({ store: physical, body: head }),
        { status: "deleted" },
      );
      f.control.afterQuery = undefined;
      assert(
        checkedClaim,
        "physical delete must follow the committed catalog tombstone",
      );
      assertEquals(await physical.head({ bodyId: body.copy.key }), null);
      assertEquals(
        (await f.db.query(
          `SELECT state FROM ${f.store.tables.content_copies} WHERE copy_key=$1`,
          [body.copy.key],
        )).rows,
        [{ state: "retired" }],
      );
      assertEquals(
        (await f.db.query(
          `SELECT completed FROM ${f.store.tables.owner_body_retirements} WHERE body_id=$1`,
          [body.copy.key],
        )).rows,
        [{ completed: true }],
      );
      assertEquals((await f.deletionSnapshot(asset.id)).length, 1);
    }),
});
