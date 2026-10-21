import { upgradeActionLifecycle } from "../runtime/actions/upgrade.ts";
import { testAuthorityManifest } from "../runtime/testing/upgrade.ts";
import type { SqlSession } from "../runtime/events/session.ts";
import { prepareRetainedDataUpgrade } from "../runtime/actions/upgrade.ts";
import {
  defineAction,
  type RuntimeActionCallers,
  secret,
} from "../runtime/actions/index.ts";
import type { ProcessorContext } from "../runtime/plugins/index.ts";
import { createActionLifecycleLoader } from "../runtime/actions/persistence.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { testSecretAdapter } from "../runtime/testing/secret-adapter.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
  validateCopilotzSchema,
} from "../runtime/events/schema.ts";
import { createEventStore } from "../runtime/events/store.ts";
import { encodeEventBody } from "../runtime/events/body-store.ts";
import { provisionOperationCatalog } from "../runtime/streams/catalog.ts";
import { createContentCatalog } from "../runtime/content/catalog.ts";
import { createDatabaseBodyStore } from "../runtime/content/database-body-store.ts";
import { createBodyStorageRuntime } from "../runtime/content/storage.ts";
import { createS3BodyStore } from "../runtime/content/s3-body-store.ts";
import {
  createS3Fixture,
  s3TestConfig,
} from "../runtime/testing/s3-body-store.fixture.ts";
import { digestContent } from "../runtime/content/digest.ts";
import {
  additionalAuthenticatedData,
  createProtectedValueRuntime,
  protectedValueRef,
} from "../runtime/actions/protected-value.ts";
import { migrateOwnerKeys } from "./migrate-owner-keys.ts";
import { bodyStoreReader, oldS3BodyReader } from "./owner-transfer-storage.ts";
import { exportOwnerBundle, importOwnerBundle } from "./owner-bundle.ts";
import { createCopilotzApplication } from "../runtime/application/application.ts";
import { definePlugin, defineProcessor } from "../runtime/plugins/index.ts";

const pgUrl = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
const unique = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
for (const objectStore of [false, true]) {
  Deno.test(`offline owner migration reencrypts history and ${objectStore ? "old S3" : "database"} bodies atomically`, async () => {
    const db = await createTestDatabase({ url: pgUrl || ":memory:" }),
      schema = unique("key_migration"),
      tables = createCoreTableNames(schema);
    const source = await testSecretAdapter(),
      master = await testSecretAdapter();
    const coordinates = {
      namespace: "space",
      ownerId: objectStore ? "test.action:run" : "record",
      slot: objectStore ? "input" : "data",
    };
    const fixture = createS3Fixture(),
      storage = objectStore
        ? createS3BodyStore(s3TestConfig, { fetch: fixture.fetch })
        : createDatabaseBodyStore({ session: db, schema });
    try {
      await provisionCopilotzSchema(db, schema);
      await provisionOperationCatalog(db, schema);
      const ciphertext = await source.seal({
        plaintext: new TextEncoder().encode(
          JSON.stringify({ token: "fixture-secret" }),
        ),
        additionalAuthenticatedData: additionalAuthenticatedData(
          schema,
          coordinates,
        ),
      });
      const key = `old-location/${crypto.randomUUID()}`,
        digest = await digestContent(ciphertext.ciphertext),
        logical = "protected:fixture";
      const catalog = createContentCatalog(db, schema),
        identity = { bodyId: logical, writerId: "fixture", generation: 1 };
      await catalog.reserve({
        ...identity,
        namespace: "space",
        copy: {
          key,
          backendKind: storage.kind,
          backendId: storage.backendId,
          collectable: storage.conditionalDelete,
        },
      });
      const head = await storage.put({
        bodyId: key,
        bytes: ciphertext.ciphertext,
        mediaType: "application/vnd.copilotz.action-protected-value+json",
        digest,
        ifAbsent: true,
      });
      await catalog.checkpoint({
        ...identity,
        expectedOffset: 0,
        offset: head.byteLength,
      });
      await catalog.sealIntent({
        ...identity,
        length: head.byteLength,
        digest,
      });
      await catalog.sealAccepted({ ...identity, head });
      const ref = protectedValueRef({
        schema: "copilotz.action.protected-value.v1",
        ownerNodeId: "protected-value:fixture",
        bodyId: logical,
        byteLength: head.byteLength,
        digest,
        mediaType: head.mediaType,
        commitment: ciphertext.commitment,
        envelope: ciphertext.envelope,
      });
      const history = objectStore
        ? {
          schema: "copilotz.action.lifecycle.protected.v1",
          data: {
            actionId: "test.action",
            actionRunId: "run",
            status: "invoked",
          },
          protected: { input: ref },
        }
        : {
          schema: "copilotz.event.protected-value.v1",
          ownerId: "record",
          data: { token: { "$copilotz-secret": true } },
          protected: ref,
        };
      const encoded = await encodeEventBody(history);
      await db.query(
        `INSERT INTO ${tables.event_bodies}(namespace,event_body_id,schema_version,body,digest) VALUES('space','history',1,$1::jsonb,$2)`,
        [encoded.body, encoded.digest],
      );
      const event = await createEventStore({ session: db, schema }).append({
        type: "test.history",
        namespace: "space",
        payload: { ref },
      }, []);
      await db.query(
        `INSERT INTO ${tables.nodes}(id,namespace,type,name,data) VALUES('protected-value:fixture','space','protected_value','protected-value',$1::jsonb)`,
        [JSON.stringify({
          state: "ready",
          bodyId: logical,
          mediaType: ref.mediaType,
          byteLength: ref.byteLength,
          digest: ref.digest,
        })],
      );
      await db.query(
        `INSERT INTO ${tables.owner_receipts}(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical','retained','fixture','fixture',$1::jsonb,$1::jsonb)`,
        [JSON.stringify({ ref })],
      );
      if (objectStore) {
        const staging = createDatabaseBodyStore({ session: db, schema }),
          stagingKey = `staging/${crypto.randomUUID()}`;
        const staged = await staging.put({
          bodyId: stagingKey,
          bytes: ciphertext.ciphertext,
          mediaType: ref.mediaType,
          digest,
          ifAbsent: true,
        });
        await db.query(
          `INSERT INTO ${tables.content_copies}(copy_key,backend_kind,backend_id,body_id,version_token,state,collectable) VALUES($1,'database','database:default',$2,$3,'orphan',TRUE)`,
          [stagingKey, logical, staged.versionToken],
        );
      }
      await db.query(`DROP TABLE ${tables.owner_data_keys}`);
      await db.query(
        `UPDATE ${tables.copilotz_schema_metadata} SET version=11`,
      );
      if (objectStore) {
        for (const [key, value] of [...fixture.objects]) {
          fixture.objects.delete(key);
          fixture.objects.set(key.replace("/unscoped/", "/"), value);
        }
      }
      await assertRejects(
        () => prepareRetainedDataUpgrade(db, schema),
        Error,
        "offline owner-key migration",
      );
      const readExternalBody = objectStore
        ? oldS3BodyReader(s3TestConfig, { fetch: fixture.fetch })
        : undefined;
      await assertRejects(() =>
        migrateOwnerKeys({
          session: db,
          schema,
          sourceAdapter: master,
          masterAdapter: master,
          readExternalBody,
        })
      );
      assertEquals(
        Number(
          (await db.query<{ version: number }>(
            `SELECT version FROM ${tables.copilotz_schema_metadata}`,
          )).rows[0].version,
        ),
        11,
      );
      await assertRejects(() => validateCopilotzSchema(db, schema));
      const failing: SqlSession = {
        query: db.query,
        transaction: (run) =>
          db.transaction((tx) =>
            run({
              query(sql, params) {
                if (sql.includes("SET version=12")) {
                  throw new Error("fixture finalization failure");
                }
                return tx.query(sql, params);
              },
            })
          ),
      };
      await assertRejects(
        () =>
          migrateOwnerKeys({
            session: failing,
            schema,
            sourceAdapter: source,
            masterAdapter: master,
            readExternalBody,
          }),
        Error,
        "fixture finalization failure",
      );
      assertEquals(
        (await db.query<{ body: unknown }>(
          `SELECT body FROM ${tables.event_bodies}`,
        )).rows[0].body,
        history,
      );
      assertEquals(
        await migrateOwnerKeys({
          session: db,
          schema,
          sourceAdapter: source,
          masterAdapter: master,
          readExternalBody,
        }),
        { protectedValues: 1, bodies: 1 },
      );
      assertEquals(
        Number(
          (await db.query<{ version: number }>(
            `SELECT version FROM ${tables.copilotz_schema_metadata}`,
          )).rows[0].version,
        ),
        12,
      );
      // Key migration stops at v12; normal activation requires the next step.
      await assertRejects(() => validateCopilotzSchema(db, schema));
      const migrated = await migrateOwnerKeys({
        session: db,
        schema,
        sourceAdapter: source,
        masterAdapter: master,
        readExternalBody,
      });
      assertEquals(migrated, { protectedValues: 1, bodies: 1 });
      await upgradeActionLifecycle(db, schema, {
        authority: await testAuthorityManifest(db, schema),
      });
      await validateCopilotzSchema(db, schema);
      const row = (await db.query<{ body: typeof history; digest: string }>(
        `SELECT body,digest FROM ${tables.event_bodies}`,
      )).rows[0];
      assertEquals(row.digest, (await encodeEventBody(row.body)).digest);
      const moved = protectedValueRef(
        objectStore
          ? (row.body.protected as { input: unknown }).input
          : row.body.protected,
      );
      assertEquals(
        (await db.query<{ intent: unknown; result: unknown }>(
          `SELECT intent,result FROM ${tables.owner_receipts} WHERE key='retained'`,
        )).rows[0],
        { intent: { ref: moved }, result: { ref: moved } },
      );
      assertEquals(
        Number(
          (await db.query<{ count: string | number }>(
            `SELECT count(*) AS count FROM "${schema}".content_bodies WHERE digest=$1`,
            [ref.digest],
          )).rows[0].count,
        ),
        0,
      );
      assert(moved.digest !== ref.digest);
      assertEquals(moved.bodyId, ref.bodyId);
      const runtime = createProtectedValueRuntime({
        databaseSchema: schema,
        session: db,
        storage: createBodyStorageRuntime(),
        adapter: master,
      });
      assertEquals(await runtime.open(coordinates, moved), {
        token: "fixture-secret",
      });
      await assertRejects(() =>
        runtime.open({ ...coordinates, ownerId: "other" }, moved)
      );
      await assertRejects(() => runtime.open(coordinates, ref));
      assertEquals(
        (await db.query<{ payload: { ref: unknown } }>(
          `SELECT payload FROM ${tables.events} WHERE id=$1`,
          [event.event.id],
        )).rows[0].payload.ref,
        moved,
      );
      await assertRejects(
        () => db.query(`UPDATE ${tables.events} SET type='changed'`),
        Error,
        "immutable",
      );
      const current = (await db.query<{ current_copy: string }>(
        `SELECT current_copy FROM ${tables.content_logical_bodies}`,
      )).rows[0].current_copy;
      assert(current.startsWith(`schemas/${schema}/`));
      assertEquals(
        await migrateOwnerKeys({
          session: db,
          schema,
          sourceAdapter: source,
          masterAdapter: master,
        }),
        { protectedValues: 1, bodies: 1 },
      );
      assertEquals(
        (await db.query(`SELECT body,digest FROM ${tables.event_bodies}`))
          .rows[0],
        row,
      );
    } finally {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
}

Deno.test({
  name:
    "owner bundle imports into a fresh PostgreSQL database, activates and reads history and secrets",
  ignore: !pgUrl,
  fn: async () => {
    const db = await createTestDatabase({ url: pgUrl }),
      schema = unique("owner_export"),
      destination = unique("owner_import");
    const targetUrl = new URL(pgUrl!);
    targetUrl.pathname = `/${destination}`;
    const temp = await Deno.makeTempDir({ prefix: "owner-bundle-" }),
      directory = `${temp}/bundle`;
    const source = await testSecretAdapter(),
      master = await testSecretAdapter(),
      fixture = createS3Fixture(),
      objects = createS3BodyStore(s3TestConfig, { fetch: fixture.fetch });
    const namespace = "space";
    const echo = defineAction({
      id: "test.portable.echo",
      inputSchema: {
        type: "object",
        properties: { token: secret({ type: "string" }) },
        required: ["token"],
        additionalProperties: false,
      } as const,
      outputSchema: {
        type: "object",
        properties: { token: secret({ type: "string" }) },
        required: ["token"],
        additionalProperties: false,
      } as const,
      execute(input: { token: string }) {
        return input;
      },
    });
    const plugin = definePlugin({
      id: "test.portable",
      version: "1.0.0",
      actions: { echo },
      processors: {
        history: defineProcessor<ProcessorContext>({
          id: "test.history",
          on: [{ eventType: "test.retained" }, {
            eventType: "test.after-import",
          }],
          async handle(_event, context) {
            await (context.actions as RuntimeActionCallers).echo({
              token: "history-secret",
            });
          },
        }),
      },
    });
    let created = false;
    try {
      const app = await createCopilotzApplication({
        database: db,
        databaseSchema: schema,
        namespace,
        plugins: [plugin],
        adapters: { secrets: { default: source } },
      });
      const run = await app.send({
        type: "test.retained",
        payload: { message: "history survives" },
      });
      for await (const _output of run.outputs) { /* drain accepted outputs */ }
      await run.done;
      await app.shutdown();
      const runtime = createProtectedValueRuntime({
        databaseSchema: schema,
        session: db,
        adapter: source,
        storage: createBodyStorageRuntime({
          storage: { type: "custom", config: { store: objects } },
        }),
      });
      const coordinates = { namespace, ownerId: "record", slot: "data" },
        prepared = await runtime.prepare(coordinates, {
          token: "portable-secret",
        });
      await db.query(
        `INSERT INTO "${schema}".nodes(namespace,id,type,name) VALUES
        ('space','shared','identity_fixture','shared'),('space','related','identity_fixture','related'),
        ('other','shared','identity_fixture','shared'),('other','related','identity_fixture','related')`,
      );
      await db.query(
        `INSERT INTO "${schema}".edges(id,namespace,source_node_id,target_node_id,type) VALUES
        ('space-edge','space','shared','related','fixture'),('other-edge','other','shared','related','fixture')`,
      );
      await db.query(`CREATE DATABASE "${destination}"`);
      created = true;
      await exportOwnerBundle({
        url: pgUrl!,
        schema,
        directory,
        config: {
          sourceAdapter: source,
          destinationAdapter: master,
          readExternalBody: bodyStoreReader(() => objects),
        },
      });
      // The source store is now unavailable; import must be self-contained.
      fixture.objects.clear();
      await assertRejects(() =>
        importOwnerBundle({ url: targetUrl.href, directory, adapter: source })
      );
      await importOwnerBundle({
        url: targetUrl.href,
        directory,
        adapter: master,
      });
      const target = await createTestDatabase({ url: targetUrl.href });
      try {
        const moved = await createCopilotzApplication({
          database: target,
          databaseSchema: schema,
          namespace,
          plugins: [plugin],
          adapters: { secrets: { default: master } },
        });
        try {
          const tables = createCoreTableNames(schema);
          assertEquals(
            (await target.query(
              `SELECT namespace,id FROM ${tables.nodes} WHERE type='identity_fixture' ORDER BY namespace,id`,
            )).rows,
            [
              { namespace: "other", id: "related" },
              { namespace: "other", id: "shared" },
              { namespace: "space", id: "related" },
              { namespace: "space", id: "shared" },
            ],
          );
          await target.query(
            `DELETE FROM ${tables.nodes} WHERE namespace='other' AND id='shared'`,
          );
          assertEquals(
            (await target.query(
              `SELECT id FROM ${tables.edges} WHERE type='fixture' ORDER BY id`,
            )).rows,
            [{ id: "space-edge" }],
          );
          assertEquals(
            (await target.query<{ count: string }>(
              `SELECT count(*) AS count FROM ${tables.events} WHERE type='test.retained'`,
            )).rows[0].count,
            "1",
          );
          const secrets = createProtectedValueRuntime({
            databaseSchema: schema,
            session: target,
            adapter: master,
            storage: createBodyStorageRuntime(),
          });
          assertEquals(await secrets.open(coordinates, prepared.ref), {
            token: "portable-secret",
          });
          const terminal = (await target.query<{ deduplication_id: string }>(
            `SELECT deduplication_id FROM ${tables.events} WHERE type='test.portable.echo.completed'`,
          )).rows[0];
          assert(terminal);
          const load = createActionLifecycleLoader({
            store: createEventStore({ session: target, schema }),
            actions: { echo },
            protectedValues: secrets,
          });
          const loaded = await load(namespace, terminal.deduplication_id);
          assert(loaded?.status === "completed");
          assertEquals(loaded.output, { token: "history-secret" });
          const next = await moved.send({ type: "test.after-import" });
          for await (
            const _output of next.outputs
          ) { /* drain accepted outputs */ }
          await next.done;
          assertEquals(
            (await target.query<{ count: string }>(
              `SELECT count(*) AS count FROM ${tables.events} WHERE type='test.after-import'`,
            )).rows[0].count,
            "1",
          );
          assertEquals(
            (await db.query<{ count: string }>(
              `SELECT count(*) AS count FROM ${tables.events} WHERE type='test.after-import'`,
            )).rows[0].count,
            "0",
          );
        } finally {
          await moved.shutdown();
        }
        await assertRejects(
          () =>
            importOwnerBundle({
              url: targetUrl.href,
              directory,
              adapter: master,
            }),
          Error,
          "empty destination",
        );
      } finally {
        await target.close();
      }
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      if (created) {
        await db.query(`DROP DATABASE "${destination}" WITH (FORCE)`);
      }
      await db.close();
      await Deno.remove(temp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "owner bundle export refuses a pg_dump older than the server before taking locks",
  ignore: !pgUrl,
  fn: async () => {
    const temp = await Deno.makeTempDir({ prefix: "owner-bundle-pgdump-" });
    const path = Deno.env.get("PATH") ?? "";
    await Deno.writeTextFile(
      `${temp}/pg_dump`,
      "#!/bin/sh\necho 'pg_dump (PostgreSQL) 9.6'\n",
      { mode: 0o755 },
    );
    Deno.env.set("PATH", `${temp}:${path}`);
    try {
      const adapter = await testSecretAdapter();
      const error = await assertRejects(() =>
        exportOwnerBundle({
          url: pgUrl!,
          schema: unique("owner_export"),
          directory: `${temp}/bundle`,
          config: { sourceAdapter: adapter, destinationAdapter: adapter },
        })
      );
      assertEquals(
        (error as { code?: string; client?: number }).code,
        "copilotz_owner_bundle_pg_dump_version",
      );
      assertEquals((error as { client?: number }).client, 9);
      await assertRejects(
        () => Deno.stat(`${temp}/bundle`),
        Deno.errors.NotFound,
      );
    } finally {
      Deno.env.set("PATH", path);
      await Deno.remove(temp, { recursive: true });
    }
  },
});
