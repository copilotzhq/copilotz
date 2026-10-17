import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  type CoordinatedMutationResult,
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  type EventCoordinator,
  type SqlExecutor,
  type SqlSession,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { createDatabaseAssetRepository } from "../content/index.ts";
import { collectionAssetAdopterFor } from "../content/database-repository.ts";
import { defineCollection } from "./definition.ts";
import {
  type CollectionCommitContext,
  createCollectionKernel,
} from "./kernel.ts";
import { readViewKey, readViews } from "./read-view.ts";

const NOW = "2026-10-16T22:00:00.000Z";
const namespace = "tenant-a";
const record = defineCollection({
  name: "record",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string" } },
    required: ["id", "title"],
    additionalProperties: true,
  },
});
const document = defineCollection({
  name: "document",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, body: { type: "array" } },
    required: ["id", "body"],
    additionalProperties: true,
  },
  content: { fields: ["body"] },
});

type Kernel = ReturnType<typeof createCollectionKernel>;
type Gate = {
  pending: CoordinatedMutationResult<unknown>[];
  callbacks: (() => void | Promise<void>)[];
};

async function fixture() {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "collection_owner_boundary";
  for (const sql of createCoreSchemaStatements(schema)) {
    await session.query(sql);
  }
  let insideOwner = false;
  const guarded: SqlSession = {
    query(sql, params) {
      equal(insideOwner, false, "A kernel query escaped the owner executor");
      return session.query(sql, params);
    },
    transaction(operation) {
      equal(insideOwner, false, "A kernel opened a nested SQL transaction");
      return session.transaction(operation);
    },
    readSnapshot() {
      throw new Error("The owner-bound kernel must reject snapshots first");
    },
  };
  const store = createEventStore({ session: guarded, schema });
  const registry = createPluginRegistry();
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "collection-owner-boundary",
    createContext: createTestProcessorContext,
  });
  const published: string[] = [];
  const flushes: string[] = [];
  let materializations = 0;
  const baseCoordinator = createEventCoordinator({
    store,
    registry,
    executor,
    publish(event) {
      equal(insideOwner, false, "An event published before outer commit");
      published.push(event.type);
    },
  });
  const coordinator: EventCoordinator = {
    ...baseCoordinator,
    async flushCommitted(result) {
      equal(insideOwner, false, "A result flushed before outer commit");
      flushes.push(result.event.id);
      return await baseCoordinator.flushCommitted(result);
    },
  };
  const legacy = createCollectionKernel({
    coordinator,
    session: guarded,
    eventStore: store,
    now: () => new Date(NOW),
  });
  const records = legacy.bind(record);
  const owner = async (
    work: (
      kernel: Kernel,
      transaction: SqlExecutor,
      gate: Gate,
    ) => Promise<void>,
    content = false,
  ): Promise<Gate> => {
    const gate: Gate = { pending: [], callbacks: [] };
    try {
      await session.transaction(async (transaction) => {
        insideOwner = true;
        const context: CollectionCommitContext = {
          transaction,
          pending: gate.pending,
          afterCommit: (callback) => {
            // Match the owner's default per-command publication budget.
            ok(gate.callbacks.length < 16, "Owner callback budget exceeded");
            gate.callbacks.push(callback);
          },
        };
        try {
          // Asset preparation also needs a transaction-bound dependency; the
          // kernel's context does not rebind arbitrary injected capabilities.
          const boundSession: SqlSession = {
            query: (sql, params) => transaction.query(sql, params),
            transaction: () => {
              throw new Error("Nested asset transaction");
            },
          };
          const adopter = content
            ? collectionAssetAdopterFor(createDatabaseAssetRepository({
              coordinator,
              session: boundSession,
              eventStore: store,
              databaseSchema: schema,
              now: () => new Date(NOW),
            }))
            : undefined;
          const kernel = createCollectionKernel({
            coordinator,
            session: guarded,
            eventStore: store,
            now: () => new Date(NOW),
            commitContext: context,
            ...(adopter
              ? {
                assets: {
                  ...adopter,
                  // Exercise the fallback path, which ordinarily opens its own transaction.
                  adoptable: () => false,
                  publishMaterializations(plans) {
                    equal(
                      insideOwner,
                      false,
                      "Materializations published before outer commit",
                    );
                    materializations += plans.length;
                    adopter.publishMaterializations(plans);
                  },
                },
              }
              : {}),
          });
          kernel.bind(record);
          kernel.bind(document);
          await work(kernel, transaction, gate);
        } finally {
          insideOwner = false;
        }
      });
      return gate;
    } catch (error) {
      // The owner discards command-local callbacks and results on rollback.
      gate.callbacks.length = 0;
      gate.pending.length = 0;
      throw error;
    }
  };
  return {
    session,
    store,
    records,
    owner,
    published,
    flushes,
    materializations: () => materializations,
    async release(gate: Gate) {
      for (const callback of gate.callbacks) await callback();
    },
    async close() {
      await executor.shutdown();
      await db.close();
    },
  };
}

async function count(executor: SqlExecutor, table: string): Promise<number> {
  const result = await executor.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return result.rows[0].n;
}

test("single Collection writes and reads join the owner transaction and wait for its callback gate", async () => {
  const f = await fixture();
  try {
    await readViews.run(async () => {
      equal(await f.records.get("one", namespace), null);
      const memo = readViews.memo()!;
      const key = readViewKey(f.store.tables.nodes, namespace, "record", "one");
      const gate = await f.owner(async (kernel, transaction, gate) => {
        const records = kernel.get("record")!;
        const written = await records.create({ id: "one", title: "first" }, {
          namespace,
          identity: { deduplicationId: "single-one" },
        });
        equal(written.record.createdAt, NOW);
        equal((await records.get("one", namespace))?.title, "first");
        equal((await records.list(namespace)).length, 1);
        equal(await count(transaction, f.store.tables.events), 1);
        equal(await count(transaction, f.store.tables.event_bodies), 1);
        equal(gate.pending.length, 1);
        deepStrictEqual(written.dispatch, { handles: [], failures: [] });
        equal(
          memo.recall(key)?.value,
          null,
          "Global cache must remain unchanged before commit",
        );
        deepStrictEqual(f.published, []);
        deepStrictEqual(f.flushes, []);
        await rejects(
          () => kernel.readSnapshot({ namespace }, () => undefined),
          /commit context/,
        );
      });
      equal(
        memo.recall(key)?.value,
        null,
        "Commit alone must not run callbacks",
      );
      deepStrictEqual(f.published, []);
      await f.release(gate);
      equal(memo.recall(key), undefined);
      equal((await f.records.get("one", namespace))?.title, "first");
      deepStrictEqual(f.published, ["record.created"]);
      equal(f.flushes.length, 1);
    });
  } finally {
    await f.close();
  }
});

test("owner rollback removes a single write and all staged publication", async () => {
  const f = await fixture();
  try {
    await rejects(() =>
      f.owner(async (kernel, transaction, gate) => {
        await kernel.get("record")!.create({
          id: "rolled-back",
          title: "discard",
        }, { namespace });
        equal(await count(transaction, f.store.tables.nodes), 1);
        equal(gate.pending.length, 1);
        ok(gate.callbacks.length > 0);
        throw new Error("owner rollback");
      }), /owner rollback/);
    equal(await f.records.get("rolled-back", namespace), null);
    equal(await count(f.session, f.store.tables.events), 0);
    equal(await count(f.session, f.store.tables.event_bodies), 0);
    deepStrictEqual(f.published, []);
    deepStrictEqual(f.flushes, []);
  } finally {
    await f.close();
  }
});

test("planned single and multi-write transactions and graph relations share the owner executor", async () => {
  const f = await fixture();
  try {
    const gate = await f.owner(async (kernel, transaction, gate) => {
      const single = await kernel.transaction({
        namespace,
        operationKey: "planned-single",
        async execute({ collections }) {
          await collections.record.create({ id: "left", title: "left" });
        },
      });
      equal(single.writes.length, 1);
      const multiple = await kernel.transaction({
        namespace,
        operationKey: "planned-multiple",
        async execute({ collections, relations }) {
          await collections.record.update({
            id: "left",
            set: { title: "updated" },
          });
          await collections.record.create({ id: "right", title: "right" });
          await relations.upsert({
            id: "link",
            type: "linked",
            source: { type: "record", id: "left" },
            target: { type: "record", id: "right" },
          });
        },
      });
      equal(multiple.writes.length, 2);
      equal(
        (await kernel.get("record")!.get("left", namespace))?.title,
        "updated",
      );
      equal(await count(transaction, f.store.tables.edges), 1);
      equal(await count(transaction, f.store.tables.events), 4);
      equal(gate.pending.length, 4);
      deepStrictEqual(f.published, []);
      deepStrictEqual(multiple.dispatch, { handles: [], failures: [] });
    });
    equal(await count(f.session, f.store.tables.events), 4);
    deepStrictEqual(f.flushes, []);
    await f.release(gate);
    equal(f.flushes.length, 4);
    deepStrictEqual(f.published, [
      "record.created",
      "record.updated",
      "record.created",
      "relation.upserted",
    ]);
  } finally {
    await f.close();
  }
});

test("a large owner plan shares one post-commit invalidation and publication callback", async () => {
  const f = await fixture();
  try {
    await readViews.run(async () => {
      equal(await f.records.get("planned-19", namespace), null);
      const memo = readViews.memo()!;
      const key = readViewKey(
        f.store.tables.nodes,
        namespace,
        "record",
        "planned-19",
      );
      const gate = await f.owner(async (kernel, transaction, gate) => {
        const result = await kernel.transaction({
          namespace,
          operationKey: "large-owner-plan",
          async execute({ collections }) {
            for (let index = 0; index < 20; index++) {
              await collections.record.create({
                id: `planned-${index}`,
                title: `title-${index}`,
              });
            }
          },
        });
        equal(result.writes.length, 20);
        equal(gate.pending.length, 20);
        equal(gate.callbacks.length, 1);
        equal(await count(transaction, f.store.tables.events), 20);
        equal(memo.recall(key)?.value, null);
        deepStrictEqual(f.published, []);
        deepStrictEqual(f.flushes, []);
      });
      equal(memo.recall(key)?.value, null);
      await f.release(gate);
      equal(memo.recall(key), undefined);
      equal((await f.records.get("planned-19", namespace))?.title, "title-19");
      equal(f.published.length, 20);
      equal(f.flushes.length, 20);
    });
  } finally {
    await f.close();
  }
});

test("owner rollback removes every planned node, relation, and event", async () => {
  const f = await fixture();
  try {
    await rejects(() =>
      f.owner(async (kernel, transaction) => {
        await kernel.transaction({
          namespace,
          operationKey: "rollback-multiple",
          async execute({ collections, relations }) {
            await collections.record.create({ id: "left", title: "left" });
            await collections.record.create({ id: "right", title: "right" });
            await relations.upsert({
              id: "link",
              type: "linked",
              source: { type: "record", id: "left" },
              target: { type: "record", id: "right" },
            });
          },
        });
        equal(await count(transaction, f.store.tables.events), 3);
        throw new Error("rollback planned");
      }), /rollback planned/);
    for (
      const table of [
        f.store.tables.nodes,
        f.store.tables.edges,
        f.store.tables.events,
        f.store.tables.event_bodies,
      ]
    ) equal(await count(f.session, table), 0);
    deepStrictEqual(f.published, []);
    deepStrictEqual(f.flushes, []);
  } finally {
    await f.close();
  }
});

test("content adoption fallback joins the owner transaction and defers materialization", async () => {
  const f = await fixture();
  try {
    const gate = await f.owner(async (kernel, transaction, gate) => {
      const written = await kernel.get("document")!.create({
        id: "doc",
        body: "owner content",
      }, { namespace, identity: { deduplicationId: "document-create" } });
      ok(Array.isArray(written.record.body));
      equal(await count(transaction, f.store.tables.nodes), 2);
      equal(await count(transaction, f.store.tables.events), 1);
      equal(gate.pending.length, 1);
      equal(f.materializations(), 0);
      deepStrictEqual(f.published, []);
    }, true);
    equal(f.materializations(), 0);
    await f.release(gate);
    equal(f.materializations(), 1);
    deepStrictEqual(f.published, ["document.created"]);
    await rejects(() =>
      f.owner(async (kernel) => {
        await kernel.get("document")!.create({
          id: "discard-doc",
          body: "discard content",
        }, { namespace });
        throw new Error("rollback content");
      }, true), /rollback content/);
    equal(await count(f.session, f.store.tables.nodes), 2);
    equal(await count(f.session, f.store.tables.events), 1);
    equal(f.materializations(), 1);
  } finally {
    await f.close();
  }
});

test("replay lookups read uncommitted Collection and relation events on the owner executor", async () => {
  const f = await fixture();
  try {
    const gate = await f.owner(async (kernel, transaction) => {
      const execute: Parameters<Kernel["transaction"]>[0]["execute"] = async (
        { collections, relations },
      ) => {
        await collections.record.create({ id: "left", title: "left" });
        await collections.record.create({ id: "right", title: "right" });
        await relations.upsert({
          id: "link",
          type: "linked",
          source: { type: "record", id: "left" },
          target: { type: "record", id: "right" },
        });
      };
      const input = { namespace, operationKey: "same-command-replay", execute };
      await kernel.transaction(input);
      const replay = await kernel.transaction(input);
      equal(replay.writes.length, 2);
      ok(replay.writes.every((write) => !write.noop && write.deduplicated));
      equal(await count(transaction, f.store.tables.events), 3);
      deepStrictEqual(f.published, []);
    });
    equal(gate.pending.length, 6);
    await f.release(gate);
    equal(f.flushes.length, 6);
    deepStrictEqual(f.published, [
      "record.created",
      "record.created",
      "relation.upserted",
    ]);
  } finally {
    await f.close();
  }
});
