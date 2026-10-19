import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  collectionAssetAdopterFor,
  createDatabaseAssetRepository,
} from "../content/database-repository.ts";
import {
  type CommandContext,
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createContentPreparer } from "../content/preparer.ts";
import { attachOwnerPush, type OwnerPushSubscription } from "../events/push.ts";
import type { SqlExecutor } from "../events/session.ts";
import { assertEventCommitted } from "../events/store.ts";
import { bounded, until } from "../testing/effect-commit-proxy.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { defineCollection } from "./definition.ts";

import { createCollectionRuntime } from "./kernel.ts";
import { readViewKey, readViews } from "./read-view.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
const namespace = "space";
const job = defineCollection({
  name: "joined_job",
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      dueAt: { type: "string" },
      content: {},
    },
    required: ["id", "name"],
  },
  content: { fields: ["content"] },
  alarm: {
    deadline: (record) => record.dueAt as string ?? null,
    command: (record) => ({
      name: "touch",
      key: `wake:${record.id}`,
      input: {},
    }),
  },
  commands: { touch: { mutate: () => ({ set: { name: "touched" } }) } },
});

async function fixture(
  options: { failPublication?: string; url?: string } = {},
) {
  const db = await createTestDatabase({
    url: options.url ?? url!,
    pgPoolMax: 4,
  });
  const schema = `joined_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const store = createEventStore({ session: db, schema });
  const publications: string[] = [];
  const publicationError = new Error("publication unavailable");
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({ ...input, consumers: [] }),
        dispatch: { handles: [], failures: [] },
      };
    },
    flushCommitted(result) {
      assertEventCommitted(result.event);
      if (!result.deduplicated) {
        publications.push(`event:${result.event.subject?.id}`);
      }
      if (result.event.subject?.id === options.failPublication) {
        throw publicationError;
      }
      return Promise.resolve({ handles: [], failures: [] });
    },
    append() {
      throw new Error("unused");
    },
    recover() {
      throw new Error("unused");
    },
  };
  const assets = createDatabaseAssetRepository({
    session: db,
    eventStore: store,
    databaseSchema: schema,
    coordinator,
  });
  const adopter = collectionAssetAdopterFor(assets);
  const runtime = createCollectionRuntime({
    session: db,
    eventStore: store,
    coordinator,
    now: () => new Date("2026-10-19T00:00:00.000Z"),
    assets: {
      ...adopter,
      publishMaterializations(plans) {
        publications.push("assets");
        adopter.publishMaterializations(plans);
      },
    },
  });
  runtime.bind(job);
  const jobs = runtime.withScope({ namespace }).joined_job;
  const run = createSchemaCommandRunner(db, schema);
  const update = async (command: CommandContext) => {
    return await runtime.transaction({
      namespace,
      operationKey: "change",
      async execute({ collections }) {
        await collections.joined_job.update({
          id: "first",
          set: { name: "after" },
        });
        await collections.joined_job.update({
          id: "second",
          set: { name: "after" },
        });
      },
    }, command);
  };
  return {
    db,
    assets,
    publicationError,
    schema,
    owner,
    store,
    publications,
    runtime,
    jobs,
    run,
    update,
    async seed() {
      for (const id of ["first", "second"]) {
        await jobs.create({ id, name: "before" });
      }
      publications.length = 0;
    },
    async close() {
      releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test({
  name:
    "PostgreSQL joined commit invalidates a committed read refilled before outer commit",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const written = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let committing: Promise<unknown> | undefined;
    try {
      await f.seed();
      committing = f.run("fixture.commit", {}, async (_input, command) => {
        await f.update(command);
        written.resolve();
        await bounded(release.promise, "release outer commit");
      });
      await readViews.run(async () => {
        await bounded(written.promise, "joined writes");
        assertEquals((await f.jobs.get({ id: "first" }))?.name, "before");
        assertEquals(f.publications, []);
        release.resolve();
        await committing;
        assertEquals((await f.jobs.get({ id: "first" }))?.name, "after");
      });
    } finally {
      release.resolve();
      await committing?.catch(() => undefined);
      await f.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL joined rollback retains the committed memo and publishes nothing",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      await f.seed();
      await readViews.run(async () => {
        const before = await f.jobs.get({ id: "first" });
        await assertRejects(
          () =>
            f.run("fixture.rollback", {}, async (_input, command) => {
              await f.update(command);
              throw new Error("refuse outer command");
            }),
          Error,
          "refuse outer command",
        );
        assertEquals(f.publications, []);
        assertEquals(
          readViews.memo()?.recall(
            readViewKey(f.store.tables.nodes, namespace, job.name, "first"),
          )?.value,
          before,
          "rollback must not invalidate the committed hop cache",
        );
        assertEquals(await f.jobs.get({ id: "first" }), before);
      });
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL joined publication preserves individual callback admission and order",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let reservations = 0;
    try {
      await f.seed();
      await f.run("fixture.publication", {}, async (_input, command) => {
        await f.update({
          ...command,
          afterCommit(callback) {
            reservations++;
            command.afterCommit(callback);
          },
        });
        assertEquals(f.publications, []);
      });
      assertEquals(
        reservations,
        3,
        "assets and each event retain owner-budget admission",
      );
      await until(
        () => f.publications.length === 3 ? true : undefined,
        "ordered publication",
      );
      assertEquals(f.publications, ["assets", "event:first", "event:second"]);
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL large joined plans share the owner publication budget and roll back on overflow",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      const create = (count: number, key: string) =>
        f.run("fixture.capacity", {}, async (_input, command) => {
          await f.runtime.transaction({
            namespace,
            operationKey: key,
            async execute({ collections }) {
              for (let i = 0; i < count; i++) {
                await collections.joined_job.create({
                  id: `${key}-${i}`,
                  name: key,
                });
              }
            },
          }, command);
        });
      // Each event reserves its push and coordinator publication; assets also
      // retain a reservation. The one owner limit applies to all three kinds.
      const error = await assertRejects(() => create(512, "overflow"));
      assertEquals(
        (error as { code?: string }).code,
        "owner_publication_queue_full",
      );
      assertEquals(await f.jobs.list({}), []);
      assertEquals(f.publications, []);
      assertEquals(
        (await f.db.query(`SELECT id FROM "${f.schema}".events`)).rows,
        [],
      );
      await create(511, "accepted");
      await until(
        () => f.publications.length === 512 ? true : undefined,
        "large plan publication",
      );
      assertEquals((await f.jobs.list({ limit: 1_000 })).length, 511);
      assertEquals(f.publications, [
        "assets",
        ...Array.from({ length: 511 }, (_, i) => `event:accepted-${i}`),
      ]);
      assertEquals(
        (await f.db.query<{ seq: string }>(
          `SELECT seq::text FROM "${f.schema}".events ORDER BY seq::bigint`,
        )).rows.map((row) => row.seq),
        Array.from({ length: 511 }, (_, i) => String(i + 1)),
        "refused plan consumes no durable sequence",
      );
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL joined publication failures remain visible without skipping later callbacks",
  ignore: !url,
  async fn() {
    const f = await fixture({ failPublication: "first" });
    const errors: unknown[] = [];
    try {
      await f.seed();
      await f.run("fixture.failure", {}, async (_input, command) => {
        await f.update({
          ...command,
          afterCommit(callback) {
            command.afterCommit(async () => {
              try {
                await callback();
              } catch (error) {
                errors.push(error);
                throw error;
              }
            });
          },
        });
        command.afterCommit(() => {
          f.publications.push("terminal");
        });
      });
      await until(
        () => f.publications.at(-1) === "terminal" ? true : undefined,
        "failure-isolated publication",
      );
      assertEquals(f.publications, [
        "assets",
        "event:first",
        "event:second",
        "terminal",
      ]);
      assertEquals(errors.length, 1);
      assertStrictEquals(errors[0], f.publicationError);
      assertEquals((await f.jobs.get({ id: "first" }))?.name, "after");
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL nested owner helpers preserve joined publication order and exact committed receipt graph and catalog",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let subscription: OwnerPushSubscription | undefined;
    const tables = [
      "nodes",
      "edges",
      "events",
      "event_bodies",
      "event_deliveries",
      "content_logical_bodies",
      "content_copies",
      "pending_content",
      "content_adoptions",
      "owner_deadlines",
    ];
    const snapshot = async (executor: SqlExecutor) =>
      Object.fromEntries(
        await Promise.all(tables.map(async (table) => [
          table,
          (await executor.query<{ row: unknown }>(
            `SELECT to_jsonb(t) AS row FROM "${f.schema}"."${table}" AS t ORDER BY to_jsonb(t)::text`,
          )).rows.map(({ row }) => row),
        ])),
      );
    try {
      const content = await f.assets.materialize({
        namespace,
        content: await createContentPreparer({
          createId: () => "shared-content",
        }).prepare({
          type: "text",
          text: "a captured body ".repeat(200),
        }, { namespace }),
      });
      subscription = await attachOwnerPush(f.db, f.schema, (frame) => {
        if (
          frame.kind === "change" &&
          frame.change.event?.subject?.type === job.name
        ) {
          f.publications.push(`push:${frame.change.event.subject.id}`);
        }
      });
      f.publications.length = 0;
      const before = await snapshot(f.db);
      const binding = {
        principal: "member",
        receipt: {
          identity: { domain: "logical", key: "accepted-plan" },
          intent: { count: 96 },
        },
        signal: new AbortController().signal,
      } as const;
      let planned: Awaited<ReturnType<typeof snapshot>> | undefined;
      const expectedPublications: string[] = [];
      const result = await f.run(
        "fixture.nested",
        {},
        async (_input, command) => {
          for (let batch = 0; batch < 3; batch++) {
            await createSchemaCommandRunner(command.transaction, f.schema)(
              "fixture.nested-helper",
              {},
              async (_input, nested) => {
                await f.runtime.transaction({
                  namespace,
                  operationKey: `batch:${batch}`,
                  async execute({ collections }) {
                    for (let i = 0; i < 32; i++) {
                      const id = `${batch}:${i}`;
                      await collections.joined_job.create({
                        id,
                        name: id,
                        content,
                        dueAt: "2099-01-01T00:00:00.000Z",
                      });
                    }
                  },
                }, nested);
              },
            );
            expectedPublications.push(
              ...Array.from({ length: 32 }, (_, i) => `push:${batch}:${i}`),
              "assets",
              ...Array.from({ length: 32 }, (_, i) => `event:${batch}:${i}`),
              `barrier:${batch}`,
            );
            command.afterCommit(() => {
              f.publications.push(`barrier:${batch}`);
            });
          }
          assertEquals(f.publications, []);
          assertEquals(
            await snapshot(f.db),
            before,
            "other connections see no staged graph, content, deadlines, or events",
          );
          assertEquals(
            (await f.db.query(`SELECT key FROM "${f.schema}".owner_receipts`))
              .rows,
            [],
          );
          planned = await snapshot(command.transaction);
          return { accepted: 96 };
        },
        binding,
      );
      assertEquals(result, { accepted: 96 });
      await until(
        () => f.publications.at(-1) === "barrier:2" ? true : undefined,
        "nested ordered publication",
      );
      assertEquals(f.publications, expectedPublications);
      assertEquals(
        await snapshot(f.db),
        planned,
        "outer commit preserves every staged graph, catalog, alarm and event row exactly",
      );
      const records = await f.jobs.list({});
      assertEquals(records.length, 96);
      for (const record of records) {
        assertEquals(record, {
          id: record.id,
          name: record.id,
          namespace,
          content,
          dueAt: "2099-01-01T00:00:00.000Z",
          createdAt: "2026-10-19T00:00:00.000Z",
          updatedAt: "2026-10-19T00:00:00.000Z",
        });
      }
      const receipt = (await f.db.query(
        `SELECT owner,domain,key,principal,kind,intent,result,readers FROM "${f.schema}".owner_receipts`,
      )).rows;
      assertEquals(receipt, [{
        owner: "schema",
        domain: "logical",
        key: "accepted-plan",
        principal: "member",
        kind: "fixture.nested",
        intent: { count: 96 },
        result,
        readers: ["member"],
      }]);
      assert((planned!.content_logical_bodies as unknown[]).length > 0);
      assertEquals(
        (planned!.owner_deadlines as { source: string }[]).filter((row) =>
          row.source === "collection:joined_job"
        ).length,
        96,
      );
      assertEquals(
        await f.run("fixture.nested", {}, () => {
          throw new Error("durable replay must not execute the plan again");
        }, binding),
        result,
      );
      assertEquals(
        await snapshot(f.db),
        planned,
        "replay leaves receipts' referenced state exactly unchanged",
      );
      assertEquals(
        f.publications,
        expectedPublications,
        "replay has no new publications",
      );
    } finally {
      subscription?.close();
      await f.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL a single joined write publishes once across replay and never on rollback",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const write = async (
      command: CommandContext,
      operationKey: string,
      name: string,
    ) => {
      await f.runtime.transaction({
        namespace,
        operationKey,
        async execute({ collections }) {
          await collections.joined_job.update({ id: "first", set: { name } });
        },
      }, command);
    };
    try {
      await f.seed();
      await readViews.run(async () => {
        assertEquals((await f.jobs.get({ id: "first" }))?.name, "before");
        await f.run("fixture.single", {}, async (_input, command) => {
          await write(command, "single", "after");
          command.afterCommit(() => {
            f.publications.push("terminal");
          });
        });
        assertEquals((await f.jobs.get({ id: "first" }))?.name, "after");
        await until(
          () => f.publications.at(-1) === "terminal" ? true : undefined,
          "single-write publication",
        );
        assertEquals(f.publications, ["assets", "event:first", "terminal"]);
        await f.run("fixture.single", {}, async (_input, command) => {
          await write(command, "single", "after");
          command.afterCommit(() => {
            f.publications.push("replayed");
          });
        });
        await until(
          () => f.publications.at(-1) === "replayed" ? true : undefined,
          "single-write replay",
        );
        assertEquals(
          f.publications.filter((entry) => entry.startsWith("event:")),
          ["event:first"],
        );
        const beforeRollback = f.publications.slice();
        await assertRejects(
          () =>
            f.run("fixture.single-rollback", {}, async (_input, command) => {
              await write(command, "single-rollback", "rolled back");
              throw new Error("refuse single write");
            }),
          Error,
          "refuse single write",
        );
        assertEquals(f.publications, beforeRollback);
        assertEquals((await f.jobs.get({ id: "first" }))?.name, "after");
      });
    } finally {
      await f.close();
    }
  },
});

for (const backend of [":memory:", url]) {
  if (!backend) continue;
  Deno.test(`explicit Collection command rollback and escaped-handle refusal (${backend === ":memory:" ? "PGlite" : "Postgres"})`, async () => {
    const f = await fixture({ url: backend });
    let retained!: () => Promise<unknown>;
    let expired!: CommandContext;
    try {
      await f.seed();
      await assertRejects(
        () =>
          f.run("fixture.closed", {}, async (_input, command) => {
            expired = command;
            await f.runtime.transaction({
              namespace,
              operationKey: "closed",
              async execute({ collections }) {
                retained = () =>
                  collections.joined_job.create({ id: "late", name: "late" });
                await collections.joined_job.update({
                  id: "first",
                  set: { name: "rolled back" },
                });
              },
            }, command);
            assertThrows(retained, Error, "closed");
            assertEquals(f.publications, []);
            throw new Error("rollback");
          }),
        Error,
        "rollback",
      );
      assertEquals((await f.jobs.get({ id: "first" }))?.name, "before");
      assertEquals(await f.jobs.get({ id: "late" }), null);
      assertEquals(f.publications, []);
      await assertRejects(() =>
        f.runtime.transaction({
          namespace,
          operationKey: "expired",
          execute: () => Promise.resolve(undefined),
        }, expired)
      );
    } finally {
      await f.close();
    }
  });
}
