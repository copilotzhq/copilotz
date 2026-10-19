import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { upgradeActionLifecycle } from "../actions/upgrade.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
} from "../engine/commands.ts";
import { createEventStore } from "./store.ts";
import { createCoreTableNames, provisionCopilotzSchema } from "./schema.ts";
import {
  attachOwnerPush,
  type OwnerPushFrame,
  stageOwnerChange,
} from "./push.ts";

async function fixture(prefix = "push_test") {
  const schema = `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim() || ":memory:",
  });
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const store = createEventStore({ session: db, schema });
  const run = createSchemaCommandRunner(db, schema);
  return {
    db,
    owner,
    store,
    run,
    schema,
    tables: createCoreTableNames(schema),
    async close() {
      owner.stop();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}
const draft = (key: string, namespace = "alpha") => ({
  type: "test.change",
  namespace,
  payload: { key },
  deduplicationId: key,
});
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

Deno.test("owner sequence is gap-free across rollback, incompatible and compatible duplicates, and namespaces", async () => {
  const f = await fixture();
  try {
    assertEquals((await f.store.append(draft("one"))).event.seq, "1");
    await assertRejects(
      () =>
        f.run("test.rollback", {}, async (_input, { transaction }) => {
          await f.store.commitMutation({
            draft: draft("rolled"),
            consumers: [],
            transaction,
          });
          throw new Error("rollback");
        }),
      Error,
      "rollback",
    );
    assertEquals((await f.store.append(draft("one"))).event.seq, "1");
    await assertRejects(() =>
      f.store.append({ ...draft("one"), payload: { different: true } })
    );
    const two = await f.store.append(draft("two", "beta"));
    assertEquals(two.event.seq, "2");
    assert(BigInt(two.event.position) > 2n);
    assertEquals(
      (await f.db.query(`SELECT seq FROM ${f.tables.events} ORDER BY seq`)).rows
        .map((row) => String(row.seq)),
      ["1", "2"],
    );
    assertEquals(
      String(
        (await f.db.query(`SELECT last_seq FROM ${f.tables.owner_epochs}`))
          .rows[0].last_seq,
      ),
      "2",
    );
  } finally {
    await f.close();
  }
});

Deno.test("owner push is postcommit and atomic attach captures concurrent commit without replaying queued publications", async () => {
  const f = await fixture();
  const frames: OwnerPushFrame[] = [];
  const initial = await attachOwnerPush(
    f.db,
    f.schema,
    (frame) => frames.push(frame),
  );
  try {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const committing = f.run(
      "test.held",
      {},
      async (_input, { transaction }) => {
        await f.store.commitMutation({
          draft: draft("held"),
          consumers: [],
          transaction,
        });
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    assertEquals(frames, []);
    let attached = false;
    const after: OwnerPushFrame[] = [];
    const pending = attachOwnerPush(
      f.db,
      f.schema,
      (frame) => after.push(frame),
    ).then((value) => {
      attached = true;
      return value;
    });
    await turn();
    assertEquals(attached, false);
    release.resolve();
    await committing;
    const second = await pending;
    try {
      await turn();
      assertEquals(second.cursor, "1");
      assertEquals(after, []);
      assertEquals(frames.filter((frame) => frame.kind === "change").length, 1);
      await f.store.append(draft("next"));
      await turn();
      assertEquals(
        after.filter((frame) => frame.kind === "change").map((frame) =>
          frame.headSeq
        ),
        ["2"],
      );
    } finally {
      second.close();
    }
  } finally {
    initial.close();
    await f.close();
  }
});

Deno.test("owner heartbeat detects a lost final lifecycle or payload push without later traffic and isolates namespaces", async () => {
  const f = await fixture();
  const frames: OwnerPushFrame[] = [];
  // The transport drops every change, while heartbeats still arrive.
  const subscription = await attachOwnerPush(f.db, f.schema, (frame) => {
    if (frame.kind !== "change") frames.push(frame);
  }, { namespace: "alpha" });
  try {
    await f.store.append(draft("final"));
    await turn();
    subscription.heartbeat();
    assertEquals(frames.at(-1), {
      kind: "heartbeat",
      headSeq: "1",
      positions: [],
    });
    await f.run("test.payload", {}, (_input, { transaction }) => {
      stageOwnerChange(transaction, f.schema, {
        namespace: "alpha",
        operationId: "op",
        selectionKeys: [],
        kind: "stream-offset",
        streamId: "lane",
        committedOffset: 17,
        seq: "1",
      });
      stageOwnerChange(transaction, f.schema, {
        namespace: "beta",
        operationId: "private",
        selectionKeys: [],
        kind: "stream-offset",
        streamId: "other",
        committedOffset: 99,
        seq: "1",
      });
    });
    await turn();
    subscription.heartbeat();
    assertEquals(frames.at(-1), {
      kind: "heartbeat",
      headSeq: "1",
      positions: [{
        namespace: "alpha",
        operationId: "op",
        streamId: "lane",
        committedOffset: 17,
      }],
    });
    assert(frames.some((frame) => frame.kind === "checkpoint"));
    assertEquals(
      String(
        (await f.db.query(`SELECT last_seq FROM ${f.tables.owner_epochs}`))
          .rows[0].last_seq,
      ),
      "1",
    );
  } finally {
    subscription.close();
    await f.close();
  }
});

Deno.test("failed push resets only its observer and owner loss resets survivors", async () => {
  const f = await fixture();
  const reset: OwnerPushFrame[] = [];
  const healthy: OwnerPushFrame[] = [];
  const first = await attachOwnerPush(f.db, f.schema, (frame) => {
    if (frame.kind === "change") throw new Error("lost");
    reset.push(frame);
  });
  const second = await attachOwnerPush(
    f.db,
    f.schema,
    (frame) => healthy.push(frame),
  );
  try {
    await f.store.append(draft("sent"));
    await turn();
    assertEquals(reset, [{
      kind: "reset",
      headSeq: "1",
      reason: "push_failed",
    }]);
    assertEquals(healthy.filter((frame) => frame.kind === "change").length, 1);
    f.owner.stop();
    assertEquals(healthy.at(-1), {
      kind: "reset",
      headSeq: "1",
      reason: "owner_lost",
    });
  } finally {
    first.close();
    second.close();
    await f.close();
  }
});

Deno.test("sequence upgrade backfills retained row identities and resumes the committed head", async () => {
  const f = await fixture();
  try {
    const one = await f.store.append(draft("one"));
    const two = await f.store.append(draft("two", "beta"));
    await provisionOperationCatalog(f.db, f.schema);
    f.owner.stop();
    await f.db.query(`ALTER TABLE ${f.tables.events} DROP COLUMN seq`);
    await f.db.query(
      `UPDATE ${f.tables.copilotz_schema_metadata} SET version=9`,
    );
    await upgradeActionLifecycle(f.db, f.schema);
    const upgradedOwner = await openDatabaseOwner(f.db, f.schema);
    const upgradedStore = createEventStore({ session: f.db, schema: f.schema });
    try {
      assertEquals((await f.store.getEvent(one.event.id))?.seq, "1");
      assertEquals((await f.store.getEvent(two.event.id))?.seq, "2");
      assertEquals((await upgradedStore.append(draft("three"))).event.seq, "3");
      await assertRejects(() =>
        f.db.query(`UPDATE ${f.tables.events} SET payload='{}'::jsonb`)
      );
    } finally {
      upgradedOwner.stop();
    }
  } finally {
    await f.close();
  }
});

Deno.test("refused admission, unjoined transactions and stale epochs cannot consume owner sequence", async () => {
  const f = await fixture();
  try {
    await assertRejects(
      () =>
        f.run(
          "test.denied",
          {},
          (_input, { transaction }) =>
            f.store.commitMutation({
              transaction,
              draft: draft("denied"),
              consumers: [],
              statement: () => ({
                ctes: [],
                gate: "FALSE",
                effects: () => [],
                report: "'{}'::jsonb",
                resolve() {
                  throw new Error("admission refused");
                },
              }),
            }),
        ),
      Error,
      "admission refused",
    );
    await assertRejects(
      () =>
        f.db.transaction((transaction) =>
          f.store.commitMutation({
            transaction,
            draft: draft("unjoined"),
            consumers: [],
          })
        ),
      Error,
      "database owner",
    );
    assertEquals((await f.store.append(draft("accepted"))).event.seq, "1");
    await f.db.query(`UPDATE ${f.tables.owner_epochs} SET epoch=epoch+1`);
    await assertRejects(
      () => f.store.append(draft("stale")),
      Error,
      "no longer current",
    );
    assertEquals(
      String(
        (await f.db.query(`SELECT last_seq FROM ${f.tables.owner_epochs}`))
          .rows[0].last_seq,
      ),
      "1",
    );
    assertEquals(
      (await f.db.query(`SELECT id FROM ${f.tables.events}`)).rows.length,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test("owner push shares one immutable capture across listeners", async () => {
  const f = await fixture("push_immutable");
  const received: OwnerPushFrame[] = [];
  const first = await attachOwnerPush(f.db, f.schema, (frame) => {
    if (frame.kind !== "change") return;
    received.push(frame);
    try {
      (frame.change.event!.payload as { key: string }).key = "corrupted";
    } catch { /* immutable internal delivery */ }
  });
  const second = await attachOwnerPush(f.db, f.schema, (frame) => {
    if (frame.kind === "change") received.push(frame);
  });
  try {
    await f.store.append(draft("original"));
    await turn();
    assertEquals(received.length, 2);
    const [a, b] = received;
    assert(a.kind === "change" && b.kind === "change");
    assert(a.change === b.change);
    assertEquals(b.change.event!.payload, { key: "original" });
  } finally {
    first.close();
    second.close();
    await f.close();
  }
});
