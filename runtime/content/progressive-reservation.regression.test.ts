import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createContentCatalog } from "./catalog.ts";
import { createDatabaseBodyStore } from "./database-body-store.ts";
import { createContentStreamRuntime } from "../streams/stream.ts";
import { digestContent } from "./digest.ts";
const schema = "content_reservation_test", namespace = "namespace-a";
async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await provisionCopilotzSchema(db, schema);
  const catalog = createContentCatalog(db, schema),
    store = createDatabaseBodyStore({ session: db, schema });
  return { db, catalog, store };
}
Deno.test("a remote catalog follower attaches to an empty reservation before first byte", async () => {
  const f = await fixture();
  try {
    const writerRuntime = createContentStreamRuntime({
        namespace,
        store: f.store,
        catalog: f.catalog,
        onOpen(_o, p) {
          p.established();
        },
      }),
      writer = await writerRuntime.open({
        id: "empty",
        mediaType: "text/plain",
        role: "content",
      }),
      remote = createContentStreamRuntime({
        namespace,
        store: createDatabaseBodyStore({ session: f.db, schema }),
        catalog: createContentCatalog(f.db, schema),
      });
    const reading = new Response((await remote.follow({ id: "empty" })).body)
      .text();
    await writer.append({
      appendId: "first",
      bytes: new TextEncoder().encode("remote"),
    });
    await writer.close({ assetId: "unused" });
    assertEquals(await reading, "remote");
  } finally {
    await f.db.close();
  }
});
Deno.test("database exact append replay uses the original offset and rejects changed bytes", async () => {
  const f = await fixture();
  try {
    const writer = await f.store.reserve({
        bodyId: "physical",
        mediaType: "text/plain",
        reservationId: "writer",
        generation: 1,
      }),
      bytes = new TextEncoder().encode("a");
    await f.store.append({ writer, appendId: "one", expectedOffset: 0, bytes });
    await f.store.append({ writer, appendId: "two", expectedOffset: 1, bytes });
    assertEquals(
      (await f.store.append({
        writer,
        appendId: "one",
        expectedOffset: 0,
        bytes,
      })).endOffset,
      1,
    );
    await assertRejects(() =>
      f.store.append({ writer, appendId: "one", expectedOffset: 1, bytes })
    );
    await assertRejects(() =>
      f.store.append({
        writer,
        appendId: "one",
        expectedOffset: 0,
        bytes: new Uint8Array([2]),
      })
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("database fencing preserves accepted prefix and rejects stale physical authority", async () => {
  const f = await fixture();
  try {
    const writer = await f.store.reserve({
      bodyId: "physical",
      mediaType: "text/plain",
      reservationId: "writer",
      generation: 1,
    });
    await f.store.append({
      writer,
      appendId: "one",
      expectedOffset: 0,
      bytes: new Uint8Array([1, 2, 3]),
    });
    const fenced = await f.store.fence({ writer });
    assertEquals(
      (await f.store.fence({ writer })).generation,
      fenced.generation,
    );
    await assertRejects(() =>
      f.store.append({
        writer,
        appendId: "late",
        expectedOffset: 3,
        bytes: new Uint8Array([4]),
      })
    );
    const prefix = new Uint8Array([1, 2]),
      head = await f.store.terminate({
        writer: fenced,
        expectedByteLength: 2,
        expectedDigest: await digestContent(prefix),
      });
    assertEquals(head.byteLength, 2);
    assertEquals(
      await f.store.readRange({ bodyId: "physical", offset: 0, end: 2 }),
      prefix,
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("database physical exact-version deletion refuses a stale observation", async () => {
  const f = await fixture();
  try {
    const writer = await f.store.reserve({
        bodyId: "physical",
        mediaType: "text/plain",
        reservationId: "writer",
        generation: 1,
      }),
      before = (await f.store.head({ bodyId: "physical" }))!;
    await f.store.append({
      writer,
      appendId: "one",
      expectedOffset: 0,
      bytes: new Uint8Array([1]),
    });
    const head = await f.store.seal({
      writer,
      expectedByteLength: 1,
      expectedDigest: await digestContent(new Uint8Array([1])),
    });
    assertEquals(
      await f.store.maintenance.delete({
        bodyId: "physical",
        expectedState: "ready",
        expectedVersionToken: before.versionToken,
        idleForMs: 0,
      }),
      false,
    );
    assertEquals(
      await f.store.maintenance.delete({
        bodyId: "physical",
        expectedState: "ready",
        expectedVersionToken: head.versionToken,
        idleForMs: 0,
      }),
      true,
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("physical appends never renew logical catalog protection", async () => {
  const f = await fixture();
  try {
    const identity = { bodyId: "logical", writerId: "writer", generation: 1 };
    await f.catalog.reserve({
      ...identity,
      namespace,
      copy: {
        key: "physical",
        backendKind: f.store.kind,
        backendId: f.store.backendId,
      },
      protectForMs: 0,
    });
    const protectedUntil =
        (await f.catalog.read(identity.bodyId))!.protectedUntil,
      writer = await f.store.reserve({
        bodyId: "physical",
        mediaType: "text/plain",
        reservationId: "writer",
        generation: 1,
      });
    await f.store.append({
      writer,
      appendId: "one",
      expectedOffset: 0,
      bytes: new Uint8Array([1]),
    });
    assertEquals(
      (await f.catalog.read(identity.bodyId))!.protectedUntil,
      protectedUntil,
    );
  } finally {
    await f.db.close();
  }
});
