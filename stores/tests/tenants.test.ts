/**
 * Tenants of the Postgres store: two in one schema never reach each other's
 * rows, through any store operation, and fence independently; a tenant
 * copies to another schema or database and carries on there; it drops and
 * exports as a unit; and many share a pool's few connections.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { spawnSync } from "node:child_process";
import { plan } from "../../runtime/aggregate.ts";
import {
  copyTenant,
  dropTenant,
  exportTenant,
  type PostgresPool,
  postgresPool,
  postgresStore,
} from "../sql/postgres/mod.ts";
import { env, test } from "../../testing/mod.ts";
import { schemaName } from "./pooled.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
/** Where pools connect: PGlite in memory (a new database for each pool), and the server. */
const databases: Record<string, string> = {
  pglite: ":memory:",
  ...(POSTGRES ? { postgres: POSTGRES } : {}),
};

type PgStore = Awaited<ReturnType<typeof postgresStore>>;
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const code = (error: unknown) => (error as { code?: string }).code;
const TABLES = ["meta", "events", "nodes", "edges", "vectors", "blobs"];

/** One tenant's data, the same for every tenant but for `who`: the same ids everywhere. */
async function fill(store: PgStore, who: string) {
  const { epoch } = await store.open();
  await store.index({ things: [{ fields: [{ path: "n", type: "number" }] }] });
  await store.transaction(epoch, async (tx) => {
    await tx.insert("things", [{ _id: "x", who, n: 1 }, { _id: "y", who, n: 2 }, {
      _id: "w",
      who,
      n: 3,
    }]);
    await tx.link({ from: "x", type: "owns", to: "y", data: { who } });
    await tx.putBlob({ id: "sha256-same", data: bytes(who), type: "text/plain" });
    await tx.putVector({
      collection: "things",
      doc: "x",
      field: "e",
      embedding: who === "a" ? [1, 0] : [0, 1],
    });
    tx.emit({ id: "e1", type: "made", data: { who } });
    tx.emit({ type: "made", data: { who }, cause: "e1" });
  }, { positions: { p: who === "a" ? 5 : 1 } });
  return epoch;
}

/** How many rows a tenant has in each table. */
const rows = async (pool: PostgresPool, schema: string, tenant: string) =>
  Object.fromEntries(
    await Promise.all(TABLES.map(async (table) => {
      const { rows: [row] } = await pool.reads.query(
        `SELECT count(*)::int AS n FROM "${schema}".${table} WHERE tenant = $1`,
        [tenant],
      );
      return [table, Number(row.n)];
    })),
  );

const dropSchemas = async (pool: PostgresPool, ...schemas: string[]) => {
  for (const schema of schemas) {
    await pool.writes.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
};

for (const [name, url] of Object.entries(databases)) {
  test(`${name}: two tenants of one schema never reach each other's rows`, async () => {
    const pool = await postgresPool({ url });
    const schema = schemaName();
    const a = await postgresStore({ pool, schema, tenant: "a" });
    const b = await postgresStore({ pool, schema, tenant: "b" });
    const ea = await fill(a, "a");
    const eb = await fill(b, "b");

    // Every read sees its own tenant only, though the ids are the same.
    for (const [store, who] of [[a, "a"], [b, "b"]] as const) {
      assertEquals(
        (await store.find("things", {}, { sort: { n: 1 } })).map((d) => [d._id, d.who]),
        [
          ["x", who],
          ["y", who],
          ["w", who],
        ],
      );
      assertEquals(await store.count("things", { n: { $gte: 2 } }), 2);
      assertEquals((await store.findOne("things", { _id: "x" }))?.who, who);
      assertEquals(
        await store.aggregate("things", plan([{ $group: { _id: "$who", docs: { $count: {} } } }])),
        [{ _id: who, docs: 3 }],
      );
      assertEquals(
        (await store.nearest("things", "e", [1, 0])).map((d) => [d._id, d.who, d._score]),
        [["x", who, who === "a" ? 1 : 0]],
      );
      assertEquals(await store.edges({ from: "x" }), [{
        from: "x",
        type: "owns",
        to: "y",
        data: { who },
      }]);
      assertEquals(text((await store.blob("sha256-same"))!.data), who);
      assertEquals((await store.events(0)).map((e) => [e.seq, e.id === "e1", e.data.who]), [
        [1, true, who],
        [2, false, who],
      ]);
      assertEquals((await store.related("e1", ["made"])).map((e) => e.data.who), [who, who]);
      assertEquals(await store.positions(), { p: who === "a" ? 5 : 1 });
    }

    // Every write of b's, in a transaction and in a command, leaves a's rows as they were.
    await b.transaction(eb, async (tx) => {
      await tx.update("things", {}, { $set: { touched: true } }, { many: true });
      await tx.update("things", { _id: "x" }, { $push: { list: 1 } });
      await tx.replace("things", { _id: "y" }, { who: "b", replaced: true });
      await tx.update("things", { _id: "z" }, { $set: { who: "b" } }, { upsert: true });
      await tx.delete("things", { _id: "w" });
      await tx.unlink({ from: "x", type: "owns", to: "y" });
      await tx.deleteVectors("things", ["x"]);
    }, { positions: { p: 7 } });
    const { events } = await b.command!(eb, {
      steps: [
        {
          write: {
            op: "update",
            collection: "things",
            filter: {},
            update: { $set: { again: true } },
            options: { many: true },
          },
          record: true,
        },
        {
          write: { op: "insert", collection: "others", docs: [{ _id: "x", who: "b" }] },
          record: true,
        },
        { write: { op: "link", edge: { from: "y", type: "owns", to: "x" } }, record: false },
        // b's own e1 is already in its log: skipped, as a retry is.
        { emit: { id: "e1", type: "made", data: { who: "b again" } } },
      ],
      blobs: [{ id: "sha256-b", data: bytes("b only") }],
    })!;
    assertEquals(events.map((e) => [e.seq, e.type]), [
      [3, "things.updated"],
      [4, "things.updated"],
      [5, "things.updated"],
      [6, "others.created"],
    ]);
    const second = await b.command!(eb, {
      steps: [
        {
          write: { op: "delete", collection: "things", filter: { _id: "z" }, options: {} },
          record: true,
        },
      ],
      blobs: [],
    })!;
    assertEquals(second.events.map((e) => [e.seq, e.type]), [[7, "things.deleted"]]);
    assertEquals(await b.find("things", {}, { sort: { _id: 1 } }), [
      { _id: "x", who: "b", n: 1, touched: true, list: [1], again: true },
      { _id: "y", who: "b", replaced: true, again: true },
    ]);
    assertEquals(await a.find("things", {}, { sort: { n: 1 } }), [
      { _id: "x", who: "a", n: 1 },
      { _id: "y", who: "a", n: 2 },
      { _id: "w", who: "a", n: 3 },
    ]);
    assertEquals(await a.find("others"), []);
    assertEquals(await a.edges({}), [{ from: "x", type: "owns", to: "y", data: { who: "a" } }]);
    assertEquals((await a.nearest("things", "e", [1, 0])).map((d) => d._id), ["x"]);
    assertEquals(await b.nearest("things", "e", [1, 0]), []);
    assertEquals(await a.blob("sha256-b"), null);
    assertEquals((await a.events(0)).map((e) => e.seq), [1, 2]);
    assertEquals(await a.positions(), { p: 5 });
    assertEquals(await b.positions(), { p: 7 });
    // The ids b made are a's to make too.
    await a.transaction(ea, (tx) => tx.insert("things", [{ _id: "z", who: "a" }]));
    assertEquals(await b.findOne("things", { _id: "z" }), null);

    // Each tenant has its own epoch: a newer owner of a fences a's old one, never b's.
    const a2 = await postgresStore({ pool, schema, tenant: "a" });
    const { epoch: ea2 } = await a2.open();
    assertEquals(ea2, ea + 1);
    const late = (store: PgStore, epoch: number) =>
      store.transaction(epoch, async (tx) => void await tx.insert("things", [{ _id: "late" }]));
    assertEquals(code(await assertRejects(() => late(a, ea))), "fenced");
    await late(b, eb);
    const b2 = await postgresStore({ pool, schema, tenant: "b" });
    const { epoch: eb2 } = await b2.open();
    assertEquals(code(await assertRejects(() => late(b, eb))), "fenced");
    assertEquals(
      code(
        await assertRejects(async () => {
          await b.command!(eb, { steps: [{ emit: { type: "late", data: {} } }], blobs: [] });
        }),
      ),
      "fenced",
    );
    await late(a2, ea2);
    await b2.transaction(eb2, (tx) => tx.insert("things", [{ _id: "later" }]));

    // One set of views for the schema shows the tenant a session names, and no other.
    const things = { type: "object", properties: { who: { type: "string" } } } as const;
    await a.describe({ things });
    await b.describe({ things });
    const seen = (tenant?: string) =>
      pool.reads.transaction(async (tx) => {
        if (tenant !== undefined) {
          await tx.query(`SELECT set_config('copilotz.tenant', $1, true)`, [tenant]);
        }
        return (await tx.query(`SELECT _id, who FROM "${schema}".things`)).rows;
      });
    assertEquals((await seen("a")).map((row) => row.who), ["a", "a", "a", "a", null]);
    assertEquals((await seen("b")).map((row) => row._id), ["x", "y", "late", "later"]);
    assertEquals(await seen(), []);
    // Raw SQL could reach the other tenant's rows: a store sharing its schema runs none.
    assertEquals(code(await assertRejects(() => a.inspect("SELECT 1"))), "shared_schema");

    // Dropping a tenant takes all its rows, in batches, and fences its owner; b keeps its own.
    const counts = await dropTenant({ pool, schema, tenant: "a", batch: 2 });
    assertEquals(counts, { meta: 2, events: 2, nodes: 5, edges: 1, vectors: 1, blobs: 1 });
    assertEquals(await rows(pool, schema, "a"), Object.fromEntries(TABLES.map((t) => [t, 0])));
    assertEquals(code(await assertRejects(() => late(a2, ea2))), "fenced");
    assertEquals((await b2.find("things", {}, { sort: { _id: 1 } })).map((d) => d._id), [
      "late",
      "later",
      "x",
      "y",
    ]);
    // Alone in the schema now, b's store drops it whole.
    await b2.drop();
    const { rows: [left] } = await pool.reads.query(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`,
      [schema],
    );
    assertEquals(left.n, 0);
    for (const store of [a, b, a2]) await store.close();
    await pool.close();
  });

  for (const across of [false, true]) {
    test(
      `${name}: a tenant copied to another ${
        across ? "database" : "schema"
      } opens there and carries on`,
      async () => {
        const source = await postgresPool({ url });
        // A second pool: on PGlite another database, on the server the same one through other
        // connections (the copy streams through this process either way).
        const target = across ? await postgresPool({ url }) : source;
        const from = schemaName();
        const to = schemaName();
        const other = await postgresStore({ pool: source, schema: from, tenant: "other" });
        await fill(other, "other");
        const org = await postgresStore({ pool: source, schema: from, tenant: "org" });
        await org.open();
        const epoch = await fill(org, "org");
        await org.transaction(epoch, async (tx) => {
          await tx.insert("things", [{ _id: "late", who: "org", n: 9 }]);
          tx.emit({ type: "more", data: {} });
        }, { positions: { q: 3 } });
        // The destination holds a tenant already, which goes on writing.
        const resident = await postgresStore({ pool: target, schema: to, tenant: "resident" });
        const residentEpoch = await fill(resident, "resident");

        const counts = await copyTenant({
          from: { pool: source, schema: from },
          to: { pool: target, schema: to },
          tenant: "org",
        });
        assertEquals(counts, { meta: 3, events: 3, nodes: 4, edges: 1, vectors: 1, blobs: 1 });

        const moved = await postgresStore({ pool: target, schema: to, tenant: "org" });
        const { epoch: next } = await moved.open();
        assertEquals(next, epoch + 1);
        assertEquals(await moved.find("things"), await org.find("things"));
        assertEquals(await moved.events(0), await org.events(0));
        assertEquals(await moved.positions(), { p: 1, q: 3 });
        assertEquals(text((await moved.blob("sha256-same"))!.data), "org");
        assertEquals((await moved.blob("sha256-same"))!.type, "text/plain");
        assertEquals(await moved.edges({}), await org.edges({}));
        assertEquals((await moved.nearest("things", "e", [0, 1])).map((d) => d._score), [1]);
        // It carries on: its next event follows the copied ones, a new document sorts last.
        const { events } = await moved.transaction(next, async (tx) => {
          await tx.insert("things", [{ _id: "after", who: "org" }]);
          tx.emit({ type: "carried", data: {} });
        });
        assertEquals(events.map((e) => e.seq), [4]);
        await resident.transaction(
          residentEpoch,
          (tx) => tx.insert("things", [{ _id: "after", who: "resident" }]),
        );
        assertEquals((await moved.find("things")).map((d) => d._id), [
          "x",
          "y",
          "w",
          "late",
          "after",
        ]);
        assertEquals((await resident.find("things")).map((d) => d._id), ["x", "y", "w", "after"]);
        assertEquals(
          await rows(target, to, "other"),
          Object.fromEntries(TABLES.map((t) => [t, 0])),
        );

        // A destination already holding the tenant is refused, and so is a tenant not there.
        const again = { from: { pool: source, schema: from }, to: { pool: target, schema: to } };
        assertEquals(
          code(await assertRejects(() => copyTenant({ ...again, tenant: "org" }))),
          "exists",
        );
        assertEquals(
          code(await assertRejects(() => copyTenant({ ...again, tenant: "nobody" }))),
          "not_found",
        );
        assertEquals(
          code(
            await assertRejects(() =>
              copyTenant({
                from: { pool: source, schema: from },
                to: { pool: source, schema: from },
                tenant: "org",
              })
            ),
          ),
          "invalid",
        );
        await dropSchemas(source, from);
        await dropSchemas(target, to);
        await source.close();
        if (target !== source) await target.close();
      },
    );
  }

  test(`${name}: a tenant exports as a script of one COPY per table`, async () => {
    const pool = await postgresPool({ url });
    const schema = schemaName();
    const other = await postgresStore({ pool, schema, tenant: "other" });
    await fill(other, "other");
    const org = await postgresStore({ pool, schema, tenant: "org" });
    const epoch = await fill(org, "org");
    // Text COPY must escape, and bytes of every value.
    const awkward = `tab\there, line\nbreak, back\\slash \\N, it's "quoted" $q$ é 😀\r end`;
    await org.transaction(epoch, async (tx) => {
      await tx.insert("things", [{ _id: `odd\t${awkward}`, text: awkward, nothing: null }]);
      await tx.putBlob({ id: "sha256-bytes", data: Uint8Array.from({ length: 256 }, (_, i) => i) });
      tx.emit({ id: `e-${awkward}`, type: "odd", data: { awkward }, cause: awkward });
    });
    const script = await new Response(exportTenant({ pool, schema, tenant: "org" })).text();
    const blocks = [...script.matchAll(/^COPY "[^"]+"\.(\w+) \(.*\) FROM stdin;\n([^]*?)^\\\.$/gm)];
    assertEquals(blocks.map((m) => [m[1], m[2].split("\n").filter(Boolean).length]), [
      ["meta", 2],
      ["events", 3],
      ["nodes", 4],
      ["edges", 1],
      ["vectors", 1],
      ["blobs", 2],
    ]);
    assert(!script.includes("other"), "another tenant's rows");
    assert(script.trimEnd().endsWith("COMMIT;"));

    // psql restores it into a schema a store has opened; a store there finds it all.
    const psql = POSTGRES && url === POSTGRES && !spawnSync("psql", ["--version"]).error;
    if (psql) {
      const into = schemaName();
      await (await postgresStore({ pool, schema: into, tenant: "placeholder" })).close();
      const restore = async () =>
        spawnSync("psql", [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
          input: await new Response(exportTenant({ pool, schema, tenant: "org", into })).text(),
        });
      const done = await restore();
      assertEquals(done.status, 0, String(done.stderr));
      const restored = await postgresStore({ pool, schema: into, tenant: "org" });
      assertEquals(await restored.find("things"), await org.find("things"));
      assertEquals(await restored.events(0), await org.events(0));
      assertEquals(await restored.positions(), await org.positions());
      assertEquals(
        Array.from((await restored.blob("sha256-bytes"))!.data),
        Array.from({ length: 256 }, (_, i) => i),
      );
      assertEquals((await restored.open()).epoch, epoch + 1);
      // Once there, it isn't restored over.
      const twice = await restore();
      assert(twice.status !== 0 && String(twice.stderr).includes("already holds tenant"));
      await dropSchemas(pool, into);
    }
    await dropSchemas(pool, schema);
    await pool.close();
  });
}

if (POSTGRES) {
  test("postgres: many tenants share a pool's few connections, and a closed pool holds none", async () => {
    const app = `copilotz_${crypto.randomUUID().slice(0, 8)}`;
    const url = `${POSTGRES}${POSTGRES.includes("?") ? "&" : "?"}application_name=${app}`;
    const pool = await postgresPool({ url, writes: 2, reads: 2 });
    const watch = await postgresPool({ url: POSTGRES, writes: 1, reads: 1 });
    const connections = async () =>
      Number(
        (await watch.reads.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`,
          [app],
        )).rows[0].n,
      );
    const schema = schemaName();
    const stores = await Promise.all(
      Array.from({ length: 12 }, (_, i) => postgresStore({ pool, schema, tenant: `t${i}` })),
    );
    const epochs = await Promise.all(stores.map((store) => store.open()));
    let most = 0;
    let running = true;
    const watching = (async () => {
      while (running) {
        most = Math.max(most, await connections());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    // Every tenant commits and reads at once.
    await Promise.all(stores.map(async (store, i) => {
      for (let k = 0; k < 10; k++) {
        await store.transaction(epochs[i].epoch, async (tx) => {
          await tx.insert("things", [{ _id: `d${k}` }]);
          tx.emit({ type: "made", data: { k } });
        });
        await store.find("things");
      }
    }));
    running = false;
    await watching;
    assert(most >= 1 && most <= 4, `${most} connections`);
    for (const store of stores) {
      assertEquals((await store.events(0)).map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
    await Promise.all(stores.map((store) => store.close()));
    await pool.close();
    for (let i = 0; i < 100 && await connections(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(await connections(), 0);
    await dropSchemas(watch, schema);
    await watch.close();
  });
}
