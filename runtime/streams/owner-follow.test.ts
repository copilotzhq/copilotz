import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createContentCatalog } from "../content/catalog.ts";
import { recoverLogicalBody } from "../content/maintenance.ts";
import { createMemoryBodyStore } from "../content/body-store.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
} from "../engine/commands.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import { createContentStreamRuntime } from "./stream.ts";
import { contentStreamBodyId } from "./body-identity.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value?: Uint8Array) => new TextDecoder().decode(value);
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `follow_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const catalog = createContentCatalog(db, schema),
    store = createMemoryBodyStore();
  const runtime = createContentStreamRuntime({
    namespace: "scope",
    catalog,
    store,
    checkpointIntervalMs: 60_000,
    onOpen(_opened, publication) {
      publication.established();
    },
  });
  return {
    db,
    schema,
    owner,
    catalog,
    store,
    runtime,
    run: createSchemaCommandRunner(db, schema),
    async close() {
      owner.stop();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test("followers attach before their first read and see tentative bytes independently of accepted offsets", async () => {
  const f = await fixture();
  const writer = await f.runtime.open({
    id: "lane",
    mediaType: "text/plain",
    role: "output",
  });
  let attached = false;
  const observing = createContentStreamRuntime({
    namespace: "scope",
    store: f.store,
    catalog: {
      ...f.catalog,
      async watch(id) {
        const watch = await f.catalog.watch(id);
        attached = true;
        return watch;
      },
      read(id, executor) {
        assert(attached);
        return f.catalog.read(id, executor);
      },
    },
  });
  const follower = await observing.follow({ id: writer.id }),
    reader = follower.body.getReader();
  try {
    const first = reader.read();
    await writer.append({ appendId: "first", bytes: bytes("first") });
    assertEquals(text((await first).value), "first");
    const second = reader.read();
    await turn();
    await writer.append({ appendId: "second", bytes: bytes("tentative") });
    assertEquals(text((await second).value), "tentative");
    assertEquals(
      (await f.catalog.read(contentStreamBodyId("scope", writer.id)))
        ?.committedOffset,
      5,
    );
    assertEquals(
      String(
        (await f.db.query(
          `SELECT last_seq FROM ${createCoreTableNames(f.schema).owner_epochs}`,
        )).rows[0].last_seq,
      ),
      "0",
    );
    await writer.abort({ reason: "test" });
    assertEquals((await reader.read()).done, true);
    assertEquals(
      (await f.catalog.read(contentStreamBodyId("scope", writer.id)))?.terminal
        ?.length,
      5,
    );
  } finally {
    await reader.cancel();
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("a physical append applied before its rejected reply invalidates followers without accepting bytes", async () => {
  const f = await fixture();
  const runtime = createContentStreamRuntime({
    namespace: "scope",
    catalog: f.catalog,
    store: {
      ...f.store,
      async append(input) {
        await f.store.append(input);
        throw new Error("reply lost");
      },
    },
    onOpen(_opened, publication) {
      publication.established();
    },
  });
  const writer = await runtime.open({
    id: "uncertain",
    mediaType: "text/plain",
    role: "output",
  });
  const reader = (await runtime.follow({ id: writer.id })).body.getReader();
  try {
    const reading = reader.read();
    await turn();
    await assertRejects(
      () => writer.append({ appendId: "unknown", bytes: bytes("tentative") }),
      Error,
      "reply lost",
    );
    assertEquals(text((await reading).value), "tentative");
    assertEquals(
      (await f.catalog.read(contentStreamBodyId("scope", writer.id)))
        ?.committedOffset,
      0,
    );
    await writer.abort();
    assertEquals((await reader.read()).done, true);
    assertEquals(
      (await f.catalog.read(contentStreamBodyId("scope", writer.id)))?.terminal
        ?.length,
      0,
    );
  } finally {
    await reader.cancel();
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("a missed final terminal publication repairs on shared heartbeat with no later traffic", async () => {
  const f = await fixture(), release = Promise.withResolvers<void>();
  const writer = await f.runtime.open({
    id: "terminal",
    mediaType: "text/plain",
    role: "output",
  });
  const reader = (await f.runtime.follow({ id: writer.id })).body.getReader();
  try {
    await writer.append({ appendId: "prefix", bytes: bytes("prefix") });
    assertEquals(text((await reader.read()).value), "prefix");
    const terminal = reader.read();
    await turn();
    await f.run(
      "test.holdPublication",
      {},
      (_input, context) => context.afterCommit(() => release.promise),
    );
    await writer.close({ assetId: "asset" });
    assertEquals((await terminal).done, true);
  } finally {
    release.resolve();
    await reader.cancel();
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("idle followers do not grow durable or physical reads and abort disposes a pending wait", async () => {
  const f = await fixture();
  const writer = await f.runtime.open({
    id: "quiet",
    mediaType: "text/plain",
    role: "output",
  });
  let reads = 0, heads = 0;
  const allReading = Promise.withResolvers<void>();
  const runtime = createContentStreamRuntime({
    namespace: "scope",
    catalog: {
      ...f.catalog,
      read(id, executor) {
        reads++;
        return f.catalog.read(id, executor);
      },
    },
    store: {
      ...f.store,
      head(input) {
        heads++;
        if (heads === 24) allReading.resolve();
        return f.store.head(input);
      },
    },
  });
  const abort = new AbortController();
  const readers = await Promise.all(
    Array.from(
      { length: 12 },
      async () =>
        (await runtime.follow({ id: writer.id }, { signal: abort.signal })).body
          .getReader(),
    ),
  );
  const pending = readers.map((reader) =>
    reader.read().catch((error) => error)
  );
  try {
    await allReading.promise;
    const initial = { reads, heads };
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assertEquals({ reads, heads }, initial);
    abort.abort(new Error("cancelled follower"));
    for (const result of await Promise.all(pending)) {
      assertEquals((result as Error).message, "cancelled follower");
    }
    const after = { reads, heads };
    await writer.append({ appendId: "after", bytes: bytes("not observed") });
    await turn();
    assertEquals({ reads, heads }, after);
  } finally {
    abort.abort();
    for (const reader of readers) await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("owner loss fails pending followers and a restarted owner can follow the accepted terminal", async () => {
  const f = await fixture();
  const writer = await f.runtime.open({
    id: "restart",
    mediaType: "text/plain",
    role: "output",
  });
  await writer.append({ appendId: "prefix", bytes: bytes("prefix") });
  const reader =
    (await f.runtime.follow({ id: writer.id }, { signal: undefined })).body
      .getReader();
  try {
    assertEquals(text((await reader.read()).value), "prefix");
    const pending = reader.read();
    await turn();
    f.owner.stop();
    await assertRejects(() => pending, Error, "owner was lost");
    await writer.abort().catch(() => {});
    const next = await openDatabaseOwner(f.db, f.schema);
    try {
      const recovered = createContentCatalog(f.db, f.schema);
      const body = await recovered.read(
        contentStreamBodyId("scope", writer.id),
      );
      assert(body);
      await recovered.beginRevocation(body);
      await recoverLogicalBody(recovered, body, f.store);
      const runtime = createContentStreamRuntime({
        namespace: "scope",
        catalog: recovered,
        store: f.store,
      });
      assertEquals(
        await new Response((await runtime.follow({ id: writer.id })).body)
          .text(),
        "prefix",
      );
    } finally {
      next.stop();
    }
  } finally {
    await reader.cancel().catch(() => {});
    await f.close();
  }
});
