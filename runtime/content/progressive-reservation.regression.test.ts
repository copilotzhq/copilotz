import { assertEquals, assertRejects } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { createDatabaseBodyStore } from "./database-body-store.ts";
import { digestContent } from "./digest.ts";
import {
  createProgressiveBodyWriter,
  openProgressiveBodyFollower,
} from "./progressive.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

Deno.test("a remote follower can open an empty reserved progressive body", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "copilotz_progressive_remote_follower";
  const writerStore = createDatabaseBodyStore({
    session: db,
    schema,
    backendId: "database:writer-process",
  });
  const followerStore = createDatabaseBodyStore({
    session: db,
    schema,
    backendId: "database:follower-process",
  });
  const writer = await createProgressiveBodyWriter(writerStore, {
    bodyId: "streams/remote-before-first-byte",
    mediaType: "text/plain",
  });
  try {
    const follower = await openProgressiveBodyFollower(followerStore, {
      bodyId: writer.bodyId,
    });
    const reading = readAll(follower.body);
    await writer.write(encoder.encode("remote stream"));
    await writer.finalize();
    assertEquals(decoder.decode(await reading), "remote stream");
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
        ORDER BY table_name`,
      [schema],
    );
    assertEquals(
      tables.rows.map((row) => row.table_name),
      ["content_bodies", "content_body_parts"],
    );
  } finally {
    await writer.abandon().catch(() => undefined);
    await db.close();
  }
});

Deno.test("progressive writer ownership is exclusive across store instances", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const firstStore = createDatabaseBodyStore({
    session: db,
    schema: "copilotz_progressive_writer_fence",
    backendId: "database:first-process",
  });
  const secondStore = createDatabaseBodyStore({
    session: db,
    schema: "copilotz_progressive_writer_fence",
    backendId: "database:second-process",
  });
  const first = await createProgressiveBodyWriter(firstStore, {
    bodyId: "streams/one-writer",
    mediaType: "text/plain",
  });
  let second:
    | Awaited<ReturnType<typeof createProgressiveBodyWriter>>
    | undefined;
  let rejected = false;
  try {
    try {
      second = await createProgressiveBodyWriter(secondStore, {
        bodyId: "streams/one-writer",
        mediaType: "text/plain",
      });
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
  } finally {
    await second?.abandon().catch(() => undefined);
    await first.abandon().catch(() => undefined);
    await db.close();
  }
});

Deno.test("database BodyStore maintenance compare-deletes exact body version only", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const store = createDatabaseBodyStore({
    session: db,
    schema: "copilotz_body_maintenance",
    protectionMs: 0,
  });
  try {
    const bytes = encoder.encode("orphan");
    const head = await store.put({
      bodyId: "bodies/orphan",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
    });
    const page = await store.maintenance.list({
      states: ["ready"],
      idleForMs: 0,
      limit: 10,
    });
    assertEquals(page.bodies.map((body) => body.bodyId), [head.bodyId]);
    assertEquals(
      await store.maintenance.delete({
        bodyId: head.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: head.maintenanceVersion + 1,
        idleForMs: 0,
      }),
      false,
    );
    assertEquals(
      (await store.head({ bodyId: head.bodyId }))?.bodyId,
      head.bodyId,
    );
    assertEquals(
      await store.maintenance.delete({
        bodyId: head.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: head.maintenanceVersion,
        idleForMs: 0,
      }),
      true,
    );
    assertEquals(await store.head({ bodyId: head.bodyId }), null);
  } finally {
    await db.close();
  }
});

Deno.test("database BodyStore maintenance refuses unexpired ready protection", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const store = createDatabaseBodyStore({
    session: db,
    schema: "copilotz_body_maintenance_protection",
  });
  try {
    const bytes = encoder.encode("protected");
    const head = await store.put({
      bodyId: "bodies/protected",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
    });
    assertEquals(
      await store.maintenance.delete({
        bodyId: head.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: head.maintenanceVersion,
        idleForMs: 0,
      }),
      false,
    );
    assertEquals(
      (await store.head({ bodyId: head.bodyId }))?.bodyId,
      head.bodyId,
    );
  } finally {
    await db.close();
  }
});

Deno.test("database BodyStore matching put renews protection and advances the maintenance fence", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const store = createDatabaseBodyStore({
    session: db,
    schema: "copilotz_body_put_renewal",
    protectionMs: 60_000,
  });
  try {
    const bytes = encoder.encode("renewable");
    const input = {
      bodyId: "bodies/renewable",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
    } as const;
    const expired = await store.put({
      ...input,
      protectedUntil: "2000-01-01T00:00:00.000Z",
    });
    const renewed = await store.put(input);
    assertEquals(
      renewed.maintenanceVersion,
      expired.maintenanceVersion + 1,
    );
    assertEquals(Date.parse(renewed.protectedUntil!) > Date.now(), true);
    const kept = await store.put({
      ...input,
      protectedUntil: "2000-01-01T00:00:00.000Z",
    });
    assertEquals(kept.maintenanceVersion, renewed.maintenanceVersion + 1);
    assertEquals(kept.protectedUntil, renewed.protectedUntil);
    assertEquals(
      await store.maintenance.delete({
        bodyId: input.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: expired.maintenanceVersion,
        idleForMs: 0,
      }),
      false,
    );
    await assertRejects(() =>
      store.put({
        ...input,
        bytes: encoder.encode("conflict"),
        digest:
          "sha256:fa9e1d222a14b79755c8b9d5523c2c8fc73a4ca5a7f25f518c5b1d17770d0fab",
      })
    );
  } finally {
    await db.close();
  }
});

Deno.test("database BodyStore acquire-or-create is linearizable across store instances", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "copilotz_body_put_linearizable";
  const firstStore = createDatabaseBodyStore({
    session: db,
    schema,
    protectionMs: 0,
  });
  const secondStore = createDatabaseBodyStore({
    session: db,
    schema,
    protectionMs: 0,
  });
  try {
    const bytes = encoder.encode("one-body");
    const input = {
      bodyId: "bodies/linearizable",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
      protectedUntil: "2000-01-01T00:00:00.000Z",
    } as const;
    const heads = await Promise.all([
      firstStore.put(input),
      secondStore.put(input),
    ]);
    assertEquals(
      heads.map((head) => head.maintenanceVersion).sort((left, right) =>
        left - right
      ),
      [1, 2],
    );
    assertEquals(
      new TextDecoder().decode(
        await readAll(
          await firstStore.read({
            bodyId: input.bodyId,
          }),
        ),
      ),
      "one-body",
    );
  } finally {
    await db.close();
  }
});

Deno.test("database BodyStore delete enforces idle duration in its SQL CAS", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const store = createDatabaseBodyStore({
    session: db,
    schema: "copilotz_body_maintenance_idle",
    protectionMs: 0,
  });
  try {
    const bytes = encoder.encode("idle-guarded");
    const head = await store.put({
      bodyId: "bodies/idle-guarded",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
      protectedUntil: "2000-01-01T00:00:00.000Z",
    });
    assertEquals(
      await store.maintenance.delete({
        bodyId: head.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: head.maintenanceVersion,
        idleForMs: 60_000,
      }),
      false,
    );
    assertEquals(
      await store.maintenance.delete({
        bodyId: head.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: head.maintenanceVersion,
        idleForMs: 0,
      }),
      true,
    );
  } finally {
    await db.close();
  }
});

Deno.test("database BodyStore append is expected-offset and append-id stable", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const store = createDatabaseBodyStore({
    session: db,
    schema: "copilotz_body_append_identity",
  });
  try {
    const writer = await store.reserve({
      bodyId: "bodies/progressive",
      mediaType: "text/plain",
    });
    const bytes = encoder.encode("abc");
    const first = await store.append({
      writer,
      expectedOffset: 0,
      appendId: "append-a",
      bytes,
    });
    assertEquals(first.endOffset, 3);
    const duplicate = await store.append({
      writer,
      expectedOffset: 0,
      appendId: "append-a",
      bytes,
    });
    assertEquals(duplicate.startOffset, first.startOffset);
    assertEquals(duplicate.endOffset, first.endOffset);
    assertEquals(duplicate.protection.remainingMs > 0, true);
    await assertRejects(() =>
      store.append({
        writer,
        expectedOffset: 0,
        appendId: "append-a",
        bytes: encoder.encode("xyz"),
      })
    );
    await assertRejects(() =>
      store.append({
        writer,
        expectedOffset: 1,
        appendId: "append-b",
        bytes: encoder.encode("d"),
      })
    );
  } finally {
    await db.close();
  }
});
