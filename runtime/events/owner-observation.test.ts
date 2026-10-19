import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
} from "../engine/commands.ts";
import { createCopilotzEngine } from "../engine/engine.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { createContentCatalog } from "../content/catalog.ts";
import { createCoreTableNames, provisionCopilotzSchema } from "./schema.ts";
import { createEventStore } from "./store.ts";
import { createCopilotzEventHub, waitForCopilotzEvent } from "./hub.ts";
import {
  attachOwnerPush,
  notifyOwnerBodyChange,
  type OwnerPushFrame,
  type OwnerPushSubscription,
  stageOwnerBodyChange,
  stageOwnerChange,
  watchOwnerPush,
} from "./push.ts";

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `observation_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  return {
    db,
    schema,
    owner,
    run: createSchemaCommandRunner(db, schema),
    store: createEventStore({ session: db, schema }),
    async close() {
      owner.stop();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test("durable waits require an attached repair source and ephemeral waits do not query", async () => {
  const hub = createCopilotzEventHub();
  try {
    await assertRejects(
      () =>
        waitForCopilotzEvent({ hub, loadDurable: () => Promise.resolve([]) }),
      TypeError,
      "attached repair",
    );
    await assertRejects(
      () =>
        waitForCopilotzEvent({
          hub,
          attachDurable: () =>
            Promise.resolve({ wait: () => Promise.resolve(), close() {} }),
        }),
      TypeError,
      "attached repair",
    );
    const event = {
      durable: false as const,
      namespace: "scope",
      type: "delta",
      payload: {},
      metadata: {},
      correlationId: "correlation",
      createdAt: new Date().toISOString(),
    };
    const result = waitForCopilotzEvent({
      hub,
      filter: { durable: false },
      timeoutMs: 1000,
    });
    await hub.publish(event);
    assertEquals(await result, event);
  } finally {
    hub.close();
  }
});

Deno.test("shared heartbeat repairs a final durable commit whose publication never arrives", async () => {
  const f = await fixture(), hub = createCopilotzEventHub();
  const release = Promise.withResolvers<void>(),
    loaded = Promise.withResolvers<void>();
  let loads = 0;
  const waiting = waitForCopilotzEvent({
    hub,
    timeoutMs: 3000,
    attachDurable: () =>
      watchOwnerPush(f.db, f.schema, {
        namespace: "scope",
        relevant: (change) => !!change.event,
      }),
    loadDurable: async () => {
      loads++;
      const result = await f.store.listEvents({ namespace: "scope" });
      loaded.resolve();
      return result;
    },
  });
  try {
    await loaded.promise;
    await f.run("test.blockPublication", {}, (_input, context) => {
      context.afterCommit(() => release.promise);
    });
    const event =
      (await f.store.append({ namespace: "scope", type: "final", payload: {} }))
        .event;
    assertEquals(await waiting, event);
    assertEquals(loads, 2);
  } finally {
    release.resolve();
    await waiting.catch(() => {});
    hub.close();
    await f.close();
  }
});

Deno.test("durable attachment captures a racing commit before initial replay and ignores idle heartbeats", async () => {
  const f = await fixture(), hub = createCopilotzEventHub();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const committing = f.run("test.held", {}, async (_input, context) => {
    await f.store.commitMutation({
      transaction: context.transaction,
      draft: { namespace: "scope", type: "raced", payload: {} },
      consumers: [],
    });
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let loads = 0;
  const waiting = waitForCopilotzEvent({
    hub,
    timeoutMs: 3000,
    attachDurable: () => watchOwnerPush(f.db, f.schema),
    loadDurable: () => {
      loads++;
      return f.store.listEvents({ namespace: "scope" });
    },
  });
  try {
    await turn();
    assertEquals(loads, 0);
    release.resolve();
    await committing;
    assertEquals((await waiting).type, "raced");
    assertEquals(loads, 1);
    const abort = new AbortController();
    const ready = Promise.withResolvers<void>();
    const idle = Array.from(
      { length: 12 },
      () =>
        waitForCopilotzEvent({
          hub,
          signal: abort.signal,
          attachDurable: () => watchOwnerPush(f.db, f.schema),
          loadDurable: () => {
            loads++;
            if (loads === 13) ready.resolve();
            return Promise.resolve([]);
          },
        }).catch((error) => error),
    );
    await ready.promise;
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assertEquals(loads, 13);
    abort.abort(new Error("finished"));
    for (const result of await Promise.all(idle)) {
      assertEquals((result as Error).message, "finished");
    }
  } finally {
    release.resolve();
    await waiting.catch(() => {});
    hub.close();
    await f.close();
  }
});

Deno.test("body revisions survive dropped final hints without advancing semantic sequence", async () => {
  const f = await fixture();
  const frames: OwnerPushFrame[] = [];
  const subscription = await attachOwnerPush(f.db, f.schema, (frame) => {
    if (frame.kind !== "checkpoint") frames.push(frame);
  }, { bodyId: "body" });
  try {
    notifyOwnerBodyChange(f.owner.signal, "body");
    assertEquals(frames, []);
    subscription.heartbeat();
    assertEquals(frames.at(-1), {
      kind: "heartbeat",
      headSeq: "0",
      positions: [],
      bodyRevision: 1,
    });
    await f.run(
      "test.bodyChange",
      {},
      (_input, { transaction }) =>
        stageOwnerBodyChange(transaction, f.schema, "body"),
    );
    await turn();
    subscription.heartbeat();
    assertEquals(subscription.snapshot().bodyRevision, 2);
    assertEquals(
      String(
        (await f.db.query(
          `SELECT last_seq FROM ${createCoreTableNames(f.schema).owner_epochs}`,
        )).rows[0].last_seq,
      ),
      "0",
    );
    await assertRejects(() =>
      f.run("test.rollback", {}, (_input, { transaction }) => {
        stageOwnerBodyChange(transaction, f.schema, "body");
        throw new Error("rollback");
      })
    );
    assertEquals(subscription.snapshot().bodyRevision, 2);
  } finally {
    subscription.close();
    await f.close();
  }
});

Deno.test("body watches share one owner across session objects and isolate identical IDs across schemas", async () => {
  const f = await fixture();
  const alias = { query: f.db.query, transaction: f.db.transaction };
  const shared = await openDatabaseOwner(alias, f.schema);
  assertEquals(shared, f.owner);
  const otherSchema = `${f.schema}_other`;
  await provisionCopilotzSchema(f.db, otherSchema);
  const otherOwner = await openDatabaseOwner(f.db, otherSchema);
  const first = await createContentCatalog(alias, f.schema).watch("same");
  const second = await createContentCatalog(f.db, otherSchema).watch("same");
  let isolated = true;
  const unrelated = second.wait().then(() => {
    isolated = false;
  });
  try {
    const matching = first.wait();
    notifyOwnerBodyChange(f.owner.signal, "same");
    await matching;
    await turn();
    assert(isolated);
    otherOwner.stop();
    await assertRejects(() => unrelated, Error, "owner was lost");
    first.close();
    second.close();
    f.owner.stop();
    const next = await openDatabaseOwner(f.db, f.schema);
    const frames: OwnerPushFrame[] = [];
    const nextSubscription = await attachOwnerPush(
      f.db,
      f.schema,
      (frame) => frames.push(frame),
      { bodyId: "same" },
    );
    try {
      notifyOwnerBodyChange(f.owner.signal, "same");
      assertEquals(frames, []);
      assertEquals(nextSubscription.snapshot().bodyRevision, 0);
    } finally {
      nextSubscription.close();
      next.stop();
    }
  } finally {
    first.close();
    second.close();
    otherOwner.stop();
    await f.db.query(`DROP SCHEMA "${otherSchema}" CASCADE`);
    await f.close();
  }
});

Deno.test("body observation slots are bounded and released after close or callback failure", async () => {
  const f = await fixture();
  const subscriptions: OwnerPushSubscription[] = [];
  try {
    // Joined attachments exercise the outer commit boundary without 4096 transactions.
    await f.run(
      "test.fillWatchCapacity",
      {},
      async (_input, { transaction }) => {
        for (let index = 0; index < 4096; index++) {
          subscriptions.push(
            await attachOwnerPush(transaction, f.schema, () => {}, {
              bodyId: `body-${index}`,
            }),
          );
        }
      },
    );
    await assertRejects(
      () => attachOwnerPush(f.db, f.schema, () => {}, { bodyId: "excess" }),
      Error,
      "capacity",
    );
    subscriptions.pop()!.close();
    const failed = await attachOwnerPush(f.db, f.schema, (frame) => {
      if (frame.kind === "checkpoint") throw new Error("closed transport");
    }, { bodyId: "failed" });
    notifyOwnerBodyChange(f.owner.signal, "failed");
    const replacement = await attachOwnerPush(f.db, f.schema, () => {}, {
      bodyId: "replacement",
    });
    replacement.close();
    failed.close();
  } finally {
    for (const subscription of subscriptions) subscription.close();
    await f.close();
  }
});

Deno.test("position overflow resets and reattaches a coalesced body watch", async () => {
  const f = await fixture();
  const watch = await watchOwnerPush(f.db, f.schema, { bodyId: "body" });
  try {
    const changed = watch.wait();
    for (let start = 0; start <= 4096; start += 256) {
      await f.run("test.overflow", {}, (_input, { transaction }) => {
        for (let index = start; index < Math.min(start + 256, 4097); index++) {
          stageOwnerChange(transaction, f.schema, {
            namespace: "scope",
            operationId: "operation",
            selectionKeys: [],
            kind: "stream-offset",
            seq: "0",
            streamId: `stream-${index}`,
            committedOffset: 1,
          });
        }
      });
      await turn();
    }
    await changed;
    const next = watch.wait();
    notifyOwnerBodyChange(f.owner.signal, "body");
    await next;
  } finally {
    watch.close();
    await f.close();
  }
});

Deno.test("engine durable repair scans bounded pages once and discovers a lost final match beyond unrelated history", async () => {
  const f = await fixture();
  const tables = createCoreTableNames(f.schema);
  for (let start = 0; start < 1001; start += 200) {
    await f.run("test.history", {}, async (_input, { transaction }) => {
      for (let index = start; index < Math.min(start + 200, 1001); index++) {
        await f.store.commitMutation({
          transaction,
          consumers: [],
          draft: {
            namespace: "scope",
            type: "unrelated",
            payload: {},
            deduplicationId: `history-${index}`,
          },
        });
      }
    });
    await turn();
  }
  let loads = 0;
  const loaded = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const engine = await createCopilotzEngine({
    session: {
      ...f.db,
      async query<
        TRow extends Record<string, unknown> = Record<string, unknown>,
      >(sql: string, params?: unknown[]) {
        const result = await f.db.query<TRow>(sql, params);
        if (
          sql.includes(`SELECT * FROM ${tables.events}`) &&
          sql.includes("ORDER BY position")
        ) {
          if (++loads === 2) loaded.resolve();
        }
        return result;
      },
    },
    defaultDatabaseSchema: f.schema,
    registry: createPluginRegistry({}),
  });
  const waiting = engine.events.waitFor({
    namespace: "scope",
    types: ["target"],
    afterPosition: "0",
    afterSeq: "0",
    timeoutMs: 5000,
  });
  try {
    await loaded.promise;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assertEquals(loads, 2);
    await f.run(
      "test.holdLastPublication",
      {},
      (_input, context) => context.afterCommit(() => release.promise),
    );
    const target = (await f.store.append({
      namespace: "scope",
      type: "target",
      payload: {},
    })).event;
    assertEquals(await waiting, target);
    assertEquals(loads, 3);
  } finally {
    release.resolve();
    await waiting.catch(() => {});
    await engine.shutdown();
    await f.close();
  }
});

Deno.test("an unsequenced payload head cannot hide an unconsumed semantic event", async () => {
  const f = await fixture();
  const watch = await watchOwnerPush(f.db, f.schema, { relevant: () => false });
  try {
    const repaired = watch.wait();
    await f.run(
      "test.unseenHead",
      {},
      (_input, { transaction }) =>
        stageOwnerChange(transaction, f.schema, {
          namespace: "scope",
          operationId: "operation",
          selectionKeys: [],
          kind: "stream-offset",
          seq: "1",
          streamId: "stream",
          committedOffset: 1,
        }),
    );
    await repaired;
  } finally {
    watch.close();
    await f.close();
  }
});
