import { authorizeActionCapabilities } from "../actions/capability-authorization.ts";
import type { ActionContext } from "../actions/types.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import { openDatabaseOwner } from "../engine/commands.ts";
import { createContentCatalog } from "../content/catalog.ts";
import { createDatabaseBodyStore } from "../content/database-body-store.ts";
import { recoverLogicalBody } from "../content/maintenance.ts";
import { contentStreamBodyId } from "./body-identity.ts";
import { createContentStreamRuntime } from "./stream.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
async function fixture(interval = 60_000) {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `stream_batch_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  let transactions = 0, rejectCheckpoint = false, loseCommit = false;
  const session: SqlSession = {
    query: db.query.bind(db),
    transaction: async (run) => {
      transactions++;
      const result = await db.transaction((tx) =>
        run({
          async query(sql, params) {
            if (rejectCheckpoint && sql.includes("SET committed_offset=")) {
              throw new Error("checkpoint rejected");
            }
            return await tx.query(sql, params);
          },
        })
      );
      if (loseCommit) {
        loseCommit = false;
        throw new Error("commit reply lost");
      }
      return result;
    },
  };
  const owner = await openDatabaseOwner(session, schema);
  const catalog = createContentCatalog(session, schema);
  const store = createDatabaseBodyStore({ session, schema });
  const runtime = createContentStreamRuntime({
    namespace: "scope",
    catalog,
    store,
    checkpointIntervalMs: interval,
    onOpen(_opened, publication) {
      publication.established();
    },
  });
  return {
    db,
    schema,
    session,
    owner,
    catalog,
    store,
    runtime,
    transactions: () => transactions,
    loseCommitReply: () => {
      loseCommit = true;
    },
    rejectCheckpoint: () => {
      rejectCheckpoint = true;
    },
    async close() {
      owner.stop();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test("database stream pushes first byte before checkpoint and batches 50 appends", async () => {
  const f = await fixture();
  const writer = await f.runtime.open({
    id: "lane",
    mediaType: "text/plain",
    role: "output",
  });
  // A separate catalog/store has no access to the writer closure: it follows the owner.
  const follower = createContentStreamRuntime({
    namespace: "scope",
    catalog: createContentCatalog(f.session, f.schema),
    store: createDatabaseBodyStore({ session: f.session, schema: f.schema }),
  });
  const reader = (await follower.follow({ id: writer.id })).body.getReader();
  const bodyId = contentStreamBodyId("scope", writer.id);
  try {
    const count = f.transactions();
    const first = reader.read(), started = performance.now();
    const chunk = bytes("0123456789abcdef0123456789abcdef");
    for (let i = 0; i < 50; i++) {
      const result = await writer.append({
        appendId: `chunk-${i}`,
        bytes: chunk,
      });
      assertEquals(result, { startOffset: i * 32, endOffset: (i + 1) * 32 });
      if (i === 0) {
        const delivered = await Promise.race([
          first,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("first byte waited for checkpoint")),
              2000,
            );
            first.finally(() => clearTimeout(timer));
          }),
        ]);
        assertEquals(delivered.value, chunk);
        console.log(
          JSON.stringify({ followerFirstByteMs: performance.now() - started }),
        );
      }
    }
    assertEquals(f.transactions(), count);
    assertEquals((await f.store.head({ bodyId }))?.byteLength, 0);
    assertEquals((await f.catalog.read(bodyId))?.committedOffset, 0);
    assertEquals(await writer.append({ appendId: "chunk-0", bytes: chunk }), {
      startOffset: 0,
      endOffset: 32,
    });
    await assertRejects(() =>
      writer.append({ appendId: "chunk-0", bytes: bytes("different") })
    );
    await writer.close({ assetId: "asset" });
    assertEquals(f.transactions() - count, 3); // final checkpoint/intent, physical seal, acceptance
    const remainder: number[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      remainder.push(...next.value);
    }
    assertEquals(remainder.length, 49 * 32);
    assertEquals((await f.catalog.read(bodyId))?.terminal?.length, 1600);
    assertEquals(
      await f.store.readRange({ bodyId, offset: 0, end: 32 }),
      chunk,
    );
  } finally {
    await reader.cancel();
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("database checkpoint rolls back physical bytes with the catalog offset", async () => {
  const f = await fixture();
  const writer = await f.runtime.open({
    id: "rollback",
    mediaType: "text/plain",
    role: "output",
  });
  const bodyId = contentStreamBodyId("scope", writer.id);
  try {
    f.rejectCheckpoint();
    await assertRejects(
      () =>
        writer.append({ appendId: "large", bytes: new Uint8Array(64 * 1024) }),
      Error,
      "checkpoint rejected",
    );
    await writer.abort();
    assertEquals((await f.store.head({ bodyId }))?.byteLength, 0);
    assertEquals((await f.catalog.read(bodyId))?.terminal?.length, 0);
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("database size checkpoints preserve only the accepted prefix on cancellation", async () => {
  const f = await fixture();
  const writer = await f.runtime.open({
    id: "cancel",
    mediaType: "text/plain",
    role: "output",
  });
  const bodyId = contentStreamBodyId("scope", writer.id);
  try {
    await writer.append({
      appendId: "accepted",
      bytes: new Uint8Array(64 * 1024).fill(1),
    });
    await writer.append({ appendId: "tentative", bytes: bytes("tail") });
    assertEquals((await f.catalog.read(bodyId))?.committedOffset, 64 * 1024);
    await writer.abort({ outcome: "cancelled" });
    const terminal = (await f.catalog.read(bodyId))?.terminal;
    assertEquals(terminal?.outcome, "cancelled");
    assertEquals(terminal?.length, 64 * 1024);
    const read = new Uint8Array(
      await new Response((await f.runtime.follow({ id: writer.id })).body)
        .arrayBuffer(),
    );
    assertEquals(read, new Uint8Array(64 * 1024).fill(1));
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("database interval checkpoints flush a quiet tail and maximum chunks stay bounded", async () => {
  const f = await fixture(30);
  const writer = await f.runtime.open({
    id: "quiet",
    mediaType: "text/plain",
    role: "output",
  });
  const bodyId = contentStreamBodyId("scope", writer.id);
  try {
    await writer.append({ appendId: "quiet", bytes: bytes("quiet") });
    const deadline = Date.now() + 2000;
    while ((await f.catalog.read(bodyId))?.committedOffset !== 5) {
      assert(
        Date.now() < deadline,
        "quiet tail must checkpoint without another append",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await writer.append({ appendId: "small", bytes: bytes("small") });
    await writer.append({
      appendId: "maximum",
      bytes: new Uint8Array(1024 * 1024).fill(2),
    });
    await writer.close({ assetId: "asset" });
    assertEquals(
      (await f.catalog.read(bodyId))?.terminal?.length,
      10 + 1024 * 1024,
    );
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("owner loss drops database tentative bytes and recovery keeps the committed prefix", async () => {
  const f = await fixture();
  const writer = await f.runtime.open({
    id: "lost",
    mediaType: "text/plain",
    role: "output",
  });
  const bodyId = contentStreamBodyId("scope", writer.id);
  let successor;
  try {
    await writer.append({
      appendId: "accepted",
      bytes: new Uint8Array(64 * 1024).fill(1),
    });
    await writer.append({ appendId: "lost", bytes: bytes("lost") });
    f.owner.stop();
    await assertRejects(() =>
      writer.append({ appendId: "late", bytes: bytes("late") })
    );
    successor = await openDatabaseOwner(f.db, f.schema);
    const catalog = createContentCatalog(f.db, f.schema);
    const store = createDatabaseBodyStore({ session: f.db, schema: f.schema });
    const revoked = await catalog.beginRevocation(
      (await catalog.read(bodyId))!,
    );
    await recoverLogicalBody(catalog, revoked, store);
    assertEquals((await catalog.read(bodyId))?.terminal?.length, 64 * 1024);
    assertEquals((await store.head({ bodyId }))?.byteLength, 64 * 1024);
  } finally {
    await writer.abort().catch(() => {});
    successor?.stop();
    await f.close();
  }
});

for (const phase of ["checkpoint", "seal intent"] as const) {
  Deno.test(`database ${phase} lost commit reply recovers exactly its durable batch`, async () => {
    const f = await fixture();
    const writer = await f.runtime.open({
      id: "uncertain",
      mediaType: "text/plain",
      role: "output",
    });
    const bodyId = contentStreamBodyId("scope", writer.id);
    let successor;
    try {
      const length = phase === "checkpoint" ? 64 * 1024 : 4;
      if (phase === "seal intent") {
        await writer.append({ appendId: "final", bytes: bytes("tail") });
      }
      f.loseCommitReply();
      await assertRejects(() =>
        phase === "checkpoint"
          ? writer.append({
            appendId: "batch",
            bytes: new Uint8Array(length).fill(1),
          })
          : writer.close({ assetId: "asset" })
      );
      assertEquals(f.owner.state, "stopped");
      successor = await openDatabaseOwner(f.db, f.schema);
      const catalog = createContentCatalog(f.db, f.schema);
      const store = createDatabaseBodyStore({
        session: f.db,
        schema: f.schema,
      });
      const body = (await catalog.read(bodyId))!;
      assertEquals(body.committedOffset, length);
      assertEquals((await store.head({ bodyId }))?.byteLength, length);
      await catalog.beginRevocation(body);
      await recoverLogicalBody(catalog, (await catalog.read(bodyId))!, store);
      const terminal = (await catalog.read(bodyId))!.terminal!;
      assertEquals(terminal.length, length);
      assertEquals(
        terminal.outcome,
        phase === "checkpoint" ? "failed" : "completed",
      );
    } finally {
      await writer.abort().catch(() => {});
      successor?.stop();
      await f.close();
    }
  });
}

Deno.test("a non-expired revocation probe preserves the live database tail", async () => {
  const f = await fixture();
  const writer = await f.runtime.open({
    id: "protected",
    mediaType: "text/plain",
    role: "output",
  });
  const bodyId = contentStreamBodyId("scope", writer.id);
  try {
    await writer.append({ appendId: "first", bytes: bytes("first") });
    const body = (await f.catalog.read(bodyId))!;
    assertEquals(
      (await f.catalog.beginRevocation({ ...body, expiredOnly: true }))
        .revocation,
      "active",
    );
    await writer.append({ appendId: "second", bytes: bytes("second") });
    await writer.close({ assetId: "asset" });
    assertEquals(
      new TextDecoder().decode(
        await f.store.readRange({ bodyId, offset: 0, end: 11 }),
      ),
      "firstsecond",
    );
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("revoked Action policy cannot publish a database tentative tail", async () => {
  const f = await fixture();
  let allowed = true;
  const check = () => {
    if (!allowed) throw new Error("writer policy revoked");
  };
  const context = authorizeActionCapabilities(
    { streams: f.runtime } as unknown as ActionContext,
    check,
    () => {},
    undefined,
    () => {
      check();
      return Promise.resolve();
    },
  );
  const writer = await context.streams.open({
    id: "policy",
    mediaType: "text/plain",
    role: "output",
  });
  const bodyId = contentStreamBodyId("scope", writer.id);
  const watch = await f.catalog.watch(bodyId);
  try {
    allowed = false;
    await assertRejects(
      () => writer.append({ appendId: "denied", bytes: bytes("denied") }),
      Error,
      "writer policy revoked",
    );
    assertEquals(watch.readTail?.(0), undefined);
    assertEquals((await f.store.head({ bodyId }))?.byteLength, 0);
    assertEquals((await f.catalog.read(bodyId))?.committedOffset, 0);
  } finally {
    allowed = true;
    watch.close();
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("another process receives owner-pushed database bytes before checkpoint", async () => {
  const f = await fixture();
  const writer = await f.runtime.open({
    id: "remote",
    mediaType: "text/plain",
    role: "output",
  });
  const attached = Promise.withResolvers<void>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async () => {
      const follower = await f.runtime.follow({ id: writer.id });
      attached.resolve();
      return new Response(follower.body);
    },
  );
  const url = `http://127.0.0.1:${server.addr.port}`;
  const reading = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `
      const response = await fetch(${
        JSON.stringify(url)
      }, { signal: AbortSignal.timeout(5000) });
      const reader = response.body.getReader();
      const result = await reader.read();
      console.log(new TextDecoder().decode(result.value));
      await reader.cancel();
    `,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  try {
    await Promise.race([
      attached.promise,
      reading.then(() => {
        throw new Error("remote follower did not attach");
      }),
    ]);
    await writer.append({
      appendId: "live",
      bytes: bytes("remote tentative bytes"),
    });
    const result = await reading;
    assert(result.success, new TextDecoder().decode(result.stderr));
    assertEquals(
      new TextDecoder().decode(result.stdout).trim(),
      "remote tentative bytes",
    );
    const bodyId = contentStreamBodyId("scope", writer.id);
    assertEquals((await f.store.head({ bodyId }))?.byteLength, 0);
    assertEquals((await f.catalog.read(bodyId))?.committedOffset, 0);
  } finally {
    await reading;
    await server.shutdown();
    await writer.abort().catch(() => {});
    await f.close();
  }
});
