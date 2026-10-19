import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createContentCatalog } from "./catalog.ts";
import { createMemoryBodyStore } from "./body-store.ts";
import {
  createProgressiveBodyWriter,
  openProgressiveBodyFollower,
} from "./progressive.ts";
import { digestContent } from "./digest.ts";
const schema = "content_progressive_test", namespace = "namespace-a";
async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await provisionCopilotzSchema(db, schema);
  return {
    db,
    catalog: createContentCatalog(db, schema),
    store: createMemoryBodyStore(),
  };
}
Deno.test("progressive convenience writer uses accepted catalog seals and checksummed bytes", async () => {
  const f = await fixture();
  try {
    const input = {
        bodyId: "lane-a",
        namespace,
        catalog: f.catalog,
        mediaType: "text/plain",
      },
      writer = await createProgressiveBodyWriter(f.store, input),
      bytes = new TextEncoder().encode("hello");
    const follower = await openProgressiveBodyFollower(f.store, input);
    const reading = new Response(follower.body).text();
    await writer.write(bytes);
    const head = await writer.finalize();
    assertEquals(head.digest, await digestContent(bytes));
    assertEquals(await reading, "hello");
    assertEquals(
      (await f.catalog.read(writer.bodyId))?.terminal?.outcome,
      "completed",
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("progressive followers resume at an exact offset and do not block other readers", async () => {
  const f = await fixture();
  try {
    const input = {
        bodyId: "lane-a",
        namespace,
        catalog: f.catalog,
        mediaType: "text/plain",
      },
      writer = await createProgressiveBodyWriter(f.store, input);
    await writer.write(new TextEncoder().encode("abcdef"));
    const slow = await openProgressiveBodyFollower(f.store, input),
      fast = await openProgressiveBodyFollower(f.store, {
        ...input,
        offset: 3,
      });
    const fastReading = new Response(fast.body).text();
    await writer.finalize();
    assertEquals(await fastReading, "def");
    assertEquals(await new Response(slow.body).text(), "abcdef");
  } finally {
    await f.db.close();
  }
});
Deno.test("progressive producer splits large writes into bounded physical chunks", async () => {
  const f = await fixture();
  try {
    const lengths: number[] = [],
      store = {
        ...f.store,
        async append(input: Parameters<typeof f.store.append>[0]) {
          lengths.push(input.bytes.length);
          return await f.store.append(input);
        },
      },
      input = {
        bodyId: "large",
        namespace,
        catalog: f.catalog,
        mediaType: "application/octet-stream",
      },
      writer = await createProgressiveBodyWriter(store, input);
    await writer.write(new Uint8Array(2 * 1024 * 1024 + 3));
    await writer.finalize();
    assertEquals(lengths, [1024 * 1024, 1024 * 1024, 3]);
  } finally {
    await f.db.close();
  }
});
Deno.test("progressive terminate retains the accepted prefix and never creates adoptable content", async () => {
  const f = await fixture();
  try {
    const input = {
        bodyId: "partial",
        namespace,
        catalog: f.catalog,
        mediaType: "text/plain",
      },
      writer = await createProgressiveBodyWriter(f.store, input);
    await writer.write(new TextEncoder().encode("prefix"));
    writer.fence();
    await assertRejects(() =>
      writer.append({ appendId: "late", bytes: new Uint8Array([1]) })
    );
    assertEquals((await writer.terminate()).state, "incomplete");
    assertEquals(
      await new Response(
        (await openProgressiveBodyFollower(f.store, input)).body,
      ).text(),
      "prefix",
    );
    assertEquals(
      (await f.catalog.read(writer.bodyId))?.terminal?.outcome,
      "failed",
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("a second progressive writer cannot take over or splice a live logical body", async () => {
  const f = await fixture();
  try {
    const input = {
        bodyId: "same",
        namespace,
        catalog: f.catalog,
        mediaType: "text/plain",
      },
      writer = await createProgressiveBodyWriter(f.store, input);
    await writer.write(new Uint8Array([1]));
    await assertRejects(() => createProgressiveBodyWriter(f.store, input));
    await writer.abandon();
    await assertRejects(() => createProgressiveBodyWriter(f.store, input));
  } finally {
    await f.db.close();
  }
});
