/**
 * The maintenance endpoints: one key, compared in constant time; read SQL
 * that can't write; collection operations through the owner (schema-checked,
 * recorded as events by the system on the maintenance actor's behalf, cached
 * as any write, heard by Processors); raw SQL writes in the owner, audited,
 * after which the owner reads what they left; blobs by id. On every store.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Event,
  invalid,
  type Runtime,
  type Store,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../../stores/sql/sqlite/mod.ts";
import { postgresStore } from "../../../../stores/sql/postgres/mod.ts";
import { routeServer } from "../../../../hosts/web/routes.ts";
import { env, tempFile, temporary, test } from "../../../../testing/mod.ts";
import { maintenance, serveMaintenance } from "../mod.ts";
import { sameKey } from "../resources/routes.ts";

const KEY = "mk_" + "k".repeat(40);
const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
  pglite: () => postgresStore({ url: ":memory:" }),
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(
          postgresStore({ url: POSTGRES, schema: `mx_${crypto.randomUUID().slice(0, 8)}` }),
        ),
    }
    : {}),
};

const heard: Event[] = [];
const text = { type: "string" } as const;
const notes = definePlugin({
  name: "notes",
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { text, n: { type: "number" } }, required: ["text"] },
      queries: {
        one: (notes, { id }: { id: string }) => notes.findOne({ _id: id }),
        // An app's numbers (as Mobizap's `booking.stats`): it checks its own params.
        stats: (notes, { by }: { by?: string }) => {
          if (by !== "text") throw invalid('stats takes `by: "text"`');
          return notes.aggregate([
            { $group: { _id: "$text", n: { $count: {} } } },
            { $sort: { _id: 1 } },
          ]);
        },
      },
    }),
  },
  actions: {
    "note.add": defineAction({
      input: { type: "object", properties: { id: text, text } },
      run: (ctx, input) =>
        ctx.db.collection("note").insertOne({ _id: input.id, text: input.text! }),
    }),
  },
  processors: {
    "notes.heard": { on: ["note.updated", "maintenance.sql"], run: (_, e) => void heard.push(e) },
  },
});
const settings = (key?: string) =>
  definePlugin({ name: "app", resources: { maintenance: { key, limit: 50 } } });

const open = async (store: Store, key: string | undefined = KEY) =>
  await createRuntime({ store, plugins: [notes, maintenance, settings(key)] });

// deno-lint-ignore no-explicit-any
type Sent = { status: number; body: any; headers: Headers };
/** A request to the endpoints, with the key unless told otherwise. */
async function send(
  runtime: Runtime,
  method: string,
  path: string,
  options: { body?: unknown; key?: string | null; headers?: Record<string, string> } = {},
): Promise<Sent> {
  const key = options.key === undefined ? KEY : options.key;
  const response = await serveMaintenance(
    new Request(`http://app.test/maintenance${path}`, {
      method,
      headers: {
        ...(key !== null ? { authorization: `Bearer ${key}` } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
    { runtime },
  );
  const type = response.headers.get("content-type") ?? "";
  const body = type.startsWith("application/json")
    ? await response.json()
    : new Uint8Array(await response.arrayBuffer());
  return { status: response.status, body, headers: response.headers };
}

const sha256 = async (text: string) =>
  `sha256-${
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("")
  }`;

test("maintenance: the key, in constant time; without one, it's off", async () => {
  assert(await sameKey(KEY, KEY));
  for (const other of ["", "x" + KEY.slice(1), KEY.slice(0, -1) + "x", KEY + "x", KEY.slice(1)]) {
    assertEquals(await sameKey(other, KEY), false);
  }
  const off = await open(memoryStore(), "");
  try {
    const answer = await send(off, "GET", "/");
    assertEquals([answer.status, answer.body.error.code], [503, "unavailable"]);
  } finally {
    await off.close();
  }
  const runtime = await open(memoryStore());
  try {
    for (const key of [null, "wrong", KEY.slice(0, -1), `${KEY} ${KEY}`]) {
      const answer = await send(runtime, "GET", "/", { key });
      assertEquals([answer.status, answer.body.error.code], [401, "unauthorized"]);
      assertEquals(answer.headers.get("www-authenticate"), 'Bearer realm="maintenance"');
    }
    const basic = await send(runtime, "GET", "/", {
      key: null,
      headers: { authorization: `Basic ${btoa(`x:${KEY}`)}` },
    });
    assertEquals(basic.status, 401);
    const index = await send(runtime, "GET", "/");
    assertEquals(index.status, 200);
    assertEquals([index.body.sql, index.body.limit, index.body.collections], [false, 50, ["note"]]);
    // The web host routes it, by its `routes` resource.
    const routed = await routeServer(runtime, () => Promise.resolve(null))(
      new Request("http://app.test/maintenance/", { headers: { authorization: `Bearer ${KEY}` } }),
    );
    assertEquals(routed?.status, 200);
    const wrongMethod = await send(runtime, "DELETE", "/");
    assertEquals(wrongMethod.status, 405);
    assertEquals((await send(runtime, "GET", "/nowhere")).status, 404);
  } finally {
    await runtime.close();
  }
  // A key too short to be safe stops the app.
  await assertRejects(() => open(memoryStore(), "short"), Error, "maintenance.key");
});

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: operations go through the owner: checked, recorded, cached, heard`, async () => {
    heard.length = 0;
    const store = await make();
    const runtime = await open(store);
    try {
      await runtime.call("note.add", { id: "n1", text: "one" });
      await runtime.call("note.add", { id: "n2", text: "two" });
      assertEquals((await runtime.query<{ text: string }>("note.one", { id: "n1" })).text, "one");

      const by = { "x-maintenance-by": "ana" };
      const updated = await send(runtime, "POST", "/collections/note/updateMany", {
        body: { filter: { _id: { $in: ["n1", "n2"] } }, update: { $set: { text: "fixed" } } },
        headers: by,
      });
      assertEquals(updated.status, 200);
      assertEquals([updated.body.matchedCount, updated.body.modifiedCount], [2, 2]);
      // Read through the owner's cache, which followed the write.
      assertEquals((await runtime.query<{ text: string }>("note.one", { id: "n1" })).text, "fixed");
      // The events say the system did it, for the maintenance actor; Processors heard them.
      const operator = { kind: "maintenance", id: "maintenance", by: "ana" };
      const events = (await store.events(0)).filter((e) => e.type === "note.updated");
      assertEquals(events.map((e) => [e.data._id, e.actor]), [
        ["n1", { kind: "system", id: "system", via: operator }],
        ["n2", { kind: "system", id: "system", via: operator }],
      ]);
      const started = (await store.events(0)).find((e) =>
        e.type === "action.started" && e.data.action === "maintenance.write"
      );
      // Its call says who asked (the call's first write carries it, as the system for them).
      assertEquals(started?.actor?.via ?? started?.actor, operator);
      await runtime.idle();
      assertEquals(heard.filter((e) => e.type === "note.updated").length, 2);

      // Inserts are checked against the schema; one sent again with its key is done once.
      const wrong = await send(runtime, "POST", "/collections/note/insertOne", {
        body: { doc: { _id: "n3", text: 3 } },
      });
      assertEquals([wrong.status, wrong.body.error.code], [400, "invalid"]);
      const twice = { "idempotency-key": "add-n3" };
      const added = await send(runtime, "POST", "/collections/note/insertOne", {
        body: { doc: { _id: "n3", text: "three" } },
        headers: twice,
      });
      const again = await send(runtime, "POST", "/collections/note/insertOne", {
        body: { doc: { _id: "n3", text: "three" } },
        headers: twice,
      });
      assertEquals([added.status, again.status, again.body], [200, 200, added.body]);

      const found = await send(runtime, "POST", "/collections/note/find", {
        body: { sort: { _id: -1 }, limit: 2 },
      });
      assertEquals(found.body.docs.map((d: { _id: string }) => d._id), ["n3", "n2"]);
      assertEquals(found.body.truncated, true);
      const count = await send(runtime, "POST", "/collections/note/countDocuments", { body: {} });
      assertEquals(count.body, { count: 3 });

      // Deleting takes a filter, said; all of them is `{}`.
      const bare = await send(runtime, "POST", "/collections/note/deleteMany", { body: {} });
      assertEquals([bare.status, bare.body.error.code], [400, "invalid"]);
      const deleted = await send(runtime, "POST", "/collections/note/deleteOne", {
        body: { filter: { _id: "n3" } },
      });
      assertEquals(deleted.body.deletedCount, 1);

      for (
        const [path, status] of [
          ["/collections/note/drop", 404],
          ["/collections/nowhere/insertOne", 404],
          ["/collections/sys.timers/deleteMany", 400],
        ] as const
      ) {
        const answer = await send(runtime, "POST", path, { body: { filter: {}, doc: {} } });
        assertEquals(answer.status, status, path);
      }
      const misspelt = await send(runtime, "POST", "/collections/note/find", {
        body: { filters: {} },
      });
      assertEquals([misspelt.status, misspelt.body.error.code], [400, "invalid"]);
    } finally {
      await runtime.close();
    }
  });

  test(`${name}: a collection's named query, its params the body`, async () => {
    const runtime = await open(await make());
    try {
      for (const [id, text] of [["n1", "a"], ["n2", "b"], ["n3", "a"]]) {
        await runtime.call("note.add", { id, text });
      }
      const stats = await send(runtime, "POST", "/queries/note.stats", { body: { by: "text" } });
      assertEquals(stats.status, 200);
      assertEquals(stats.body.result, [{ _id: "a", n: 2 }, { _id: "b", n: 1 }]);
      const one = await send(runtime, "POST", "/queries/note.one", { body: { id: "n2" } });
      assertEquals(one.body.result.text, "b");
      // Its params are the query's to check; unknown names aren't there.
      const wrong = await send(runtime, "POST", "/queries/note.stats", { body: { by: "day" } });
      assertEquals([wrong.status, wrong.body.error.code], [400, "invalid"]);
      for (const path of ["/queries/note.nope", "/queries/nowhere.stats", "/queries/stats"]) {
        assertEquals((await send(runtime, "POST", path, { body: {} })).status, 404, path);
      }
      assertEquals((await send(runtime, "GET", "/queries/note.stats")).status, 405);
    } finally {
      await runtime.close();
    }
  });

  test(`${name}: a blob by id`, async () => {
    const store = await make();
    const runtime = await open(store);
    try {
      const long = "é".repeat(20_000);
      await runtime.call("note.add", { id: "n1", text: long });
      const id = await sha256(long);
      const blob = await send(runtime, "GET", `/blobs/${id}`);
      assertEquals(blob.status, 200);
      assertEquals(new TextDecoder().decode(blob.body), long);
      assertEquals(blob.headers.get("content-type"), "text/plain; charset=utf-8");
      assertMatch(blob.headers.get("content-disposition")!, /^attachment/);
      assertEquals(blob.headers.get("x-content-type-options"), "nosniff");
      assertEquals((await send(runtime, "GET", `/blobs/sha256-${"0".repeat(64)}`)).status, 404);
      assertEquals((await send(runtime, "GET", "/blobs/nope")).status, 400);
    } finally {
      await runtime.close();
    }
  });
}

/** SQL, in each SQL store's dialect. */
const sqlStores = Object.entries(stores).filter(([name]) => name !== "memory");

for (const [name, make] of sqlStores) {
  const p = (n: number) => name === "sqlite" ? `?${n}` : `$${n}`;
  const setText = name === "sqlite"
    ? "UPDATE nodes SET doc = json_set(doc, '$.text', ?1) WHERE collection = 'note' AND id = ?2"
    : "UPDATE nodes SET doc = jsonb_set(doc, '{text}', to_jsonb($1::text)) WHERE " +
      "collection = 'note' AND id = $2";

  test(`${name}: read SQL: rows, limited, read only, one statement`, async () => {
    const runtime = await open(await make());
    try {
      for (const n of [1, 2, 3]) await runtime.call("note.add", { id: `n${n}`, text: `t${n}` });
      const read = await send(runtime, "POST", "/sql", {
        body: {
          sql: `SELECT _id, text FROM note WHERE _id <> ${p(1)} ORDER BY _id`,
          params: ["n2"],
        },
      });
      assertEquals(read.status, 200);
      assertEquals(read.body.rows, [{ _id: "n1", text: "t1" }, { _id: "n3", text: "t3" }]);
      assertEquals([read.body.count, read.body.truncated], [2, false]);
      const limited = await send(runtime, "POST", "/sql", {
        body: { sql: "SELECT id FROM nodes ORDER BY id", limit: 2 },
      });
      assertEquals([limited.body.count, limited.body.truncated], [2, true]);
      // Never more than the settings allow.
      const over = await send(runtime, "POST", "/sql", { body: { sql: "SELECT 1", limit: 51 } });
      assertEquals(over.status, 400);

      const write = await send(runtime, "POST", "/sql", {
        body: { sql: setText, params: ["x", "n1"] },
      });
      assertEquals([write.status, write.body.error.code], [400, "read_only"]);
      const two = await send(runtime, "POST", "/sql", { body: { sql: "SELECT 1; SELECT 2" } });
      assertEquals([two.status, two.body.error.code], [400, "invalid"]);
      const commit = await send(runtime, "POST", "/sql", { body: { sql: "COMMIT" } });
      assertEquals([commit.status, commit.body.error.code], [400, "invalid"]);
      const broken = await send(runtime, "POST", "/sql", { body: { sql: "SELEC 1" } });
      assertEquals([broken.status, broken.body.error.code], [400, "sql"]);
      assertEquals((await send(runtime, "GET", "/sql")).status, 405);
      assertEquals((await runtime.query<{ text: string }>("note.one", { id: "n1" })).text, "t1");
    } finally {
      await runtime.close();
    }
  });

  test(`${name}: a raw SQL write runs in the owner: audited, then read as it left things`, async () => {
    heard.length = 0;
    const store = await make();
    const runtime = await open(store);
    try {
      await runtime.call("note.add", { id: "n1", text: "typo" });
      assertEquals((await runtime.query<{ text: string }>("note.one", { id: "n1" })).text, "typo");
      const fix = { sql: setText, params: ["fixed", "n1"] };
      const headers = { "x-maintenance-by": "ana", "idempotency-key": "fix-n1" };
      const done = await send(runtime, "POST", "/sql/write", { body: fix, headers });
      assertEquals(done.status, 200);
      assertEquals([done.body.changed, done.body.rows, done.body.repeated], [1, [], undefined]);
      // The owner's next read sees it: the cache was emptied.
      assertEquals((await runtime.query<{ text: string }>("note.one", { id: "n1" })).text, "fixed");
      // One audit event, with the statement, its params, what it changed, and who.
      const audit = (await store.events(0)).filter((e) => e.type === "maintenance.sql");
      assertEquals(audit.map((e) => [e.id, e.data.sql, e.data.params, e.data.changed, e.actor]), [[
        done.body.event.id,
        setText,
        ["fixed", "n1"],
        1,
        { kind: "maintenance", id: "maintenance", by: "ana" },
      ]]);
      await runtime.idle();
      assertEquals(heard.map((e) => e.type), ["maintenance.sql"]);
      // Sent again with its key: answered from its record, not run.
      const again = await send(runtime, "POST", "/sql/write", { body: fix, headers });
      assertEquals([again.body.repeated, again.body.event.id], [true, done.body.event.id]);
      assertEquals((await store.events(0)).filter((e) => e.type === "maintenance.sql").length, 1);
      // Still one statement, and nothing that ends its transaction.
      const session = name === "sqlite" ? "PRAGMA journal_mode = DELETE" : "SET search_path = x";
      for (const sql of [`${setText}; DELETE FROM nodes`, "ROLLBACK", session]) {
        const refused = await send(runtime, "POST", "/sql/write", { body: { sql } });
        assertEquals([refused.status, refused.body.error.code], [400, "invalid"], sql);
      }
      // RETURNING rows come back, within the limit.
      const returned = await send(runtime, "POST", "/sql/write", {
        body: { sql: `${setText} RETURNING id`, params: ["again", "n1"], limit: 1 },
      });
      assertEquals([returned.body.changed, returned.body.rows], [1, [{ id: "n1" }]]);
    } finally {
      await runtime.close();
    }
  });
}

test("memory: SQL isn't there, operations are", async () => {
  const runtime = await open(memoryStore());
  try {
    for (const path of ["/sql", "/sql/write"]) {
      const answer = await send(runtime, "POST", path, { body: { sql: "SELECT 1" } });
      assertEquals([answer.status, answer.body.error.code], [501, "unsupported"]);
    }
  } finally {
    await runtime.close();
  }
});
