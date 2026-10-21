import { attachOwnerPush } from "../events/push.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fixture, reader } from "../testing/subscriptions.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { credentialValidity } from "../authorization/authority.ts";

Deno.test("F4 subscription admission and notice reauthorization receive the exact Collection query", async () => {
  const f = await fixture();
  try {
    const query = { where: { visible: true }, limit: 2 };
    const sub = await f.observe(f.authority, "entry", query);
    const r = reader(sub);
    assertEquals((await r.next()).t, "snapshot");
    const expected = {
      kind: "collection" as const,
      resource: "entry",
      operation: "list",
      input: {
        collection: { alias: "entry", name: "entry" },
        method: "list",
        phase: "read",
        args: structuredClone(query),
      },
    };
    assertEquals(f.intents.at(-1), expected);
    query.limit = 99;
    let noticedGate: boolean[] | undefined;
    const watch = await attachOwnerPush(f.session, f.schema, (frame) => {
      if (
        frame.kind === "change" &&
        frame.change.collectionChange?.collection === "member"
      ) {
        noticedGate = [sub.isActive!(), sub.canPublish!()];
      }
    });
    try {
      await f.collections.member.update({ id: "key", set: { revision: 1 } });
      await f.run("barrier", {}, () => undefined);
      assertEquals(
        noticedGate,
        [true, false],
        "a temporary authorization hold gates publication without retiring the generation",
      );
      assertEquals(sub.canPublish!(), true);
    } finally {
      watch.close();
    }
    await f.collections.entry.create({ id: "visible", visible: true });
    assertEquals((await r.next()).t, "batch");
    assertEquals(f.intents.at(-1), expected);
    assertEquals(f.intents.length, 2);
    sub.detach();
  } finally {
    await f.close();
  }
});

Deno.test("F6 §6.1 snapshot rows and S share a boundary; commits during handoff and interruption", async () => {
  const f = await fixture();
  try {
    await f.collections.entry.create({ id: "a" });
    const sub = await f.observe(f.authority, "entry");
    const r = reader(sub);
    await f.collections.entry.create({ id: "b" });
    const first = await r.next();
    assert(first.t === "snapshot");
    assertEquals(first.rows.map((row) => row.id), ["a"]);
    const change = await r.next();
    assert(change.t === "batch");
    assertEquals(change.from, first.sequence);
    assertEquals(change.changes.map((d) => d.id), ["b"]);
    sub.detach();
    const resumed = await f.observe(f.authority, "entry", {}, {
      checkpoint: first.checkpoint,
    });
    const replay = await reader(resumed).next();
    assertEquals(replay, change);
    resumed.detach();
    const interrupted = await f.observe(f.authority, "entry");
    interrupted.detach();
    const fresh = await f.observe(f.authority, "entry");
    const next = await reader(fresh).next();
    assert(next.t === "snapshot");
    assertEquals(next.rows.length, 2);
    fresh.detach();
  } finally {
    await f.close();
  }
});

Deno.test("F6 §6.2 ordered deltas retain prior membership and refill deletion/filter exits", async () => {
  const f = await fixture();
  try {
    for (const id of ["a", "b", "c"]) {
      await f.collections.entry.create({ id, visible: true });
    }
    const sub = await f.observe(f.authority, "entry", {
      where: { visible: true },
      limit: 2,
    });
    const r = reader(sub);
    const initial = await r.next();
    assert(initial.t === "snapshot");
    await f.collections.entry.delete({ id: "a" });
    const deleted = await r.next();
    assert(deleted.t === "batch");
    assertEquals(deleted.changes.map((d) => [d.id, d.record?.id ?? null]), [[
      "a",
      null,
    ], ["c", "c"]]);
    await f.collections.entry.create({ id: "d", visible: true });
    await r.next();
    await f.collections.entry.update({ id: "b", set: { visible: false } });
    const exit = await r.next();
    assert(exit.t === "batch");
    assertEquals(exit.changes.map((d) => [d.id, d.record?.id ?? null]), [[
      "b",
      null,
    ], ["d", "d"]]);
    sub.detach();
  } finally {
    await f.close();
  }
});

Deno.test("F6 §6.3 contiguous empty progress and rollback never publishes", async () => {
  const f = await fixture();
  try {
    const sub = await f.observe(f.authority, "entry", {
      where: { visible: true },
    });
    const r = reader(sub);
    const initial = await r.next();
    assert(initial.t === "snapshot");
    await assertRejects(
      () =>
        f.run("rollback", {}, async (_, context) => {
          await f.store.commitMutation({
            draft: { type: "unrelated", namespace: "main", payload: {} },
            consumers: [],
            transaction: context.transaction,
          });
          throw new Error("rollback");
        }),
      Error,
      "rollback",
    );
    await f.collections.entry.create({ id: "hidden", visible: false });
    const progress = await r.next();
    assert(progress.t === "batch");
    assertEquals(progress.from, initial.sequence);
    assertEquals(BigInt(progress.to), BigInt(initial.sequence) + 1n);
    assertEquals(progress.changes, []);
    const sql = await f.db.query<{ last_seq: string }>(
      `SELECT last_seq FROM ${
        createCoreTableNames(f.schema).owner_epochs
      } WHERE owner='schema'`,
    );
    assertEquals(progress.to, String(sql.rows[0].last_seq));
    assertEquals(
      progress.collectionChanged,
      true,
      "mutations outside the selected window still invalidate Collection query Actions",
    );
    await f.run("unrelated", {}, async (_, context) => {
      await f.store.commitMutation({
        draft: { type: "unrelated", namespace: "main", payload: {} },
        consumers: [],
        transaction: context.transaction,
      });
    });
    const unrelated = await r.next();
    assert(unrelated.t === "batch");
    assertEquals(unrelated.changes, []);
    assertEquals(
      unrelated.collectionChanged,
      false,
      "operation-only progress cannot refresh its own query Action",
    );
    sub.detach();
  } finally {
    await f.close();
  }
});

Deno.test("F6 §6.5 and F4 notice revocation fences queued data; changed permissions reset and refill", async () => {
  const f = await fixture();
  try {
    await f.collections.entry.create({ id: "a", visible: false });
    await f.collections.entry.create({ id: "b", visible: true });
    const sub = await f.observe(f.authority, "entry", { limit: 1 });
    const r = reader(sub);
    await r.next();
    await f.collections.entry.update({ id: "a", set: { title: "queued" } });
    await f.collections.member.update({ id: "key", set: { restricted: true } });
    const reset = await r.next();
    assertEquals(reset.t, "reset");
    const fresh = await f.observe(f.authority, "entry", { limit: 1 });
    const rr = reader(fresh);
    const snapshot = await rr.next();
    assert(snapshot.t === "snapshot");
    assertEquals(snapshot.rows.map((row) => row.id), ["b"]);
    const checks = f.counters().evaluations;
    await f.collections.member.update({ id: "key", set: { revision: 1 } });
    await f.run("barrier", {}, () => undefined);
    assert(f.counters().evaluations > checks);
    await f.collections.entry.create({ id: "c", visible: true });
    await f.collections.member.update({ id: "key", set: { allowed: false } });
    assertEquals((await rr.next()).t, "revoked");
    await assertRejects(() => f.observe(f.authority, "entry"));
  } finally {
    await f.close();
  }
});

Deno.test("F6 retention, scope and takeover reset rather than continue another snapshot", async () => {
  const f = await fixture({ maxFrames: 2 });
  try {
    const sub = await f.observe(f.authority, "entry");
    const r = reader(sub);
    const first = await r.next();
    assert(first.t === "snapshot");
    sub.detach();
    for (const id of ["a", "b", "c"]) await f.collections.entry.create({ id });
    const stale = await f.observe(f.authority, "entry", {}, {
      checkpoint: first.checkpoint,
    });
    assertEquals((await reader(stale).next()).t, "reset");
    const other = await f.observe(
      { ...f.authority, scope: { ...f.authority.scope, tenant: "other" } },
      "entry",
      {},
      { checkpoint: first.checkpoint },
    );
    assertEquals((await reader(other).next()).t, "reset");
    const current = await f.observe(f.authority, "entry");
    const rr = reader(current);
    await rr.next();
    f.owner.stop();
    assertEquals((await rr.next()).t, "reset");
  } finally {
    await f.close();
  }
});

Deno.test("F6 slow consumers reset independently; ordinary commits do not reauthorize or scan SQL per reader", async () => {
  const f = await fixture({ maxFrames: 2 });
  try {
    const slow = await f.observe(f.authority, "entry"),
      fast = await f.observe(f.authority, "entry");
    const rr = reader(fast);
    await rr.next();
    const before = f.counters();
    for (const id of ["a", "b", "c"]) {
      await f.collections.entry.create({ id });
      assertEquals((await rr.next()).t, "batch");
    }
    assertEquals(f.counters().evaluations, before.evaluations);
    assertEquals(await reader(slow).next(), {
      t: "reset",
      reason: "slow_consumer",
    });
    fast.detach();
  } finally {
    await f.close();
  }
});

Deno.test("F4 credential lifetime resets and renewed admission reauthorizes", async () => {
  const f = await fixture();
  try {
    const sub = await f.observe(f.authority, "entry");
    const r = reader(sub);
    await r.next();
    // Exercise the existing durable authorization alarm source, no subscription timer.
    await f.db.query(
      `UPDATE "${f.schema}".owner_deadlines SET due_at=NOW()-INTERVAL '1 second' WHERE source='authorization'`,
    );
    await f.owner.wakeAlarms();
    assertEquals((await r.next()).t, "reset");
    const fresh = await f.observe({
      ...f.authority,
      validity: credentialValidity(new Date()),
    }, "entry");
    assertEquals((await reader(fresh).next()).t, "snapshot");
    fresh.detach();
  } finally {
    await f.close();
  }
});

Deno.test("F4 subscription admission rejects lease-bound authority", async () => {
  const f = await fixture();
  try {
    await assertRejects(
      () =>
        f.observe({
          ...f.authority,
          validity: {
            kind: "attempt",
            attempt: "delivery",
            epoch: "1",
            worker: "worker",
          },
        }, "entry"),
      TypeError,
    );
  } finally {
    await f.close();
  }
});

Deno.test("F6 actual owner takeover fences the old stream and refuses its retained checkpoint", async () => {
  const { createOwnerCommands } = await import("../engine/commands.ts");
  const { createAuthorizationOwner } = await import(
    "../authorization/owner.ts"
  );
  const { createCollectionObserver } = await import("./owner.ts");
  const f = await fixture();
  const successor = createOwnerCommands({
    session: f.session,
    schema: f.schema,
    handlers: {},
  });
  try {
    const old = await f.observe(f.authority, "entry");
    const r = reader(old);
    const snapshot = await r.next();
    assert(snapshot.t === "snapshot");
    await successor.acquire(f.owner.epoch!);
    await assertRejects(() => f.run("old.fence", {}, () => undefined));
    assertEquals((await r.next()).t, "reset");
    const authorization = createAuthorizationOwner({
      session: f.session,
      databaseSchema: f.schema,
      owner: successor,
      registration: f.registration,
      collections: f.definitions,
      operations: {} as import("../streams/catalog.ts").OperationCatalog,
    });
    const observe = createCollectionObserver({
      session: f.session,
      schema: f.schema,
      owner: successor,
      authorization,
      collections: f.definitions,
    });
    const resumed = await observe(f.authority, "entry", {}, {
      checkpoint: snapshot.checkpoint,
    });
    assertEquals((await reader(resumed).next()).t, "reset");
    const fresh = await observe(f.authority, "entry");
    assertEquals((await reader(fresh).next()).t, "snapshot");
    fresh.detach();
  } finally {
    successor.stop();
    await f.close();
  }
});

Deno.test("F6 schema replacement and byte capacity reset without joining snapshots", async () => {
  const { createCollectionObserver } = await import("./owner.ts");
  const f = await fixture({ maxBytes: 512 });
  try {
    const sub = await f.observe(f.authority, "entry");
    const snapshot = await reader(sub).next();
    assert(snapshot.t === "snapshot");
    sub.detach();
    const revised = createCollectionObserver({
      session: f.session,
      schema: f.schema,
      owner: f.owner,
      authorization: f.authorization,
      collections: {
        ...f.definitions,
        entry: {
          ...f.definitions.entry,
          schema: { ...f.definitions.entry.schema, description: "revised" },
        },
      },
    });
    const reconnected = await revised(f.authority, "entry", {}, {
      checkpoint: snapshot.checkpoint,
    });
    assertEquals((await reader(reconnected).next()).t, "reset");
    await f.collections.entry.create({ id: "large", title: "x".repeat(1024) });
    const oversized = await f.observe(f.authority, "entry");
    assertEquals(await reader(oversized).next(), {
      t: "reset",
      reason: "capacity",
    });
  } finally {
    await f.close();
  }
});

Deno.test("progress-only subscriptions scan no rows, resume progress and revoke through the same authority gate", async () => {
  const f = await fixture();
  try {
    await f.collections.entry.create({ id: "private", title: "not disclosed" });
    const start = f.statementsSql.length;
    const sub = await f.observe(f.authority, "entry", {}, {
      progressOnly: true,
    });
    const r = reader(sub);
    const snapshot = await r.next();
    assert(snapshot.t === "snapshot");
    assertEquals(snapshot.rows, []);
    assertEquals(
      f.statementsSql.slice(start).some(({ sql, params }) =>
        /^\s*SELECT/i.test(sql) && params?.includes("entry")
      ),
      false,
      "progress-only admission must not scan Collection records",
    );
    assertEquals(f.intents.at(-1)?.operation, "list");
    await f.collections.entry.update({
      id: "private",
      set: { title: "changed" },
    });
    const batch = await r.next();
    assert(batch.t === "batch");
    assertEquals(batch.changes, []);
    assertEquals(batch.collectionChanged, true);
    sub.detach();
    const resumed = await f.observe(f.authority, "entry", {}, {
      progressOnly: true,
      checkpoint: snapshot.checkpoint,
    });
    const resumedReader = reader(resumed);
    assertEquals(await resumedReader.next(), batch);
    const rowMode = await f.observe(f.authority, "entry", {}, {
      checkpoint: snapshot.checkpoint,
    });
    assertEquals(
      (await reader(rowMode).next()).t,
      "reset",
      "progress cursor cannot resume a row selection",
    );
    rowMode.detach();
    await f.collections.member.update({ id: "key", set: { allowed: false } });
    await f.run("barrier", {}, () => undefined);
    assertEquals((await resumedReader.next()).t, "revoked");
    resumed.detach();
    await assertRejects(
      () =>
        f.observe(f.authority, "entry", { limit: 1 }, { progressOnly: true }),
      TypeError,
    );
  } finally {
    await f.close();
  }
});
