import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createDatabaseBodyStore } from "./database-body-store.ts";
import { digestContent } from "./digest.ts";
import { bodyStoreConformance } from "../testing/body-store-conformance.ts";
import { readBodyBytes } from "./body-store.ts";
import type { SqlExecutor } from "../events/index.ts";

Deno.test("database BodyStore ranges use indexed overlapping parts and transfer only requested bytes", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `body_indexed_${crypto.randomUUID().replaceAll("-", "")}`;
  const ranges: { rows: number; bytes: number; sql: string }[] = [];
  const query: SqlExecutor["query"] = async (sql, params) => {
    const result = await db.query(sql, params);
    if (sql.includes("WITH anchor AS")) {
      ranges.push({
        rows: result.rows.filter((row) => row.start_offset !== null).length,
        bytes: result.rows.reduce(
          (sum, row) =>
            sum + ((row.bytes as Uint8Array | null)?.byteLength ?? 0),
          0,
        ),
        sql,
      });
    }
    return result as never;
  };
  const store = createDatabaseBodyStore({
    session: { query, transaction: db.transaction } as SqlExecutor,
    schema,
  });
  try {
    const writer = await store.reserve({
      bodyId: "many-parts",
      reservationId: "range-test",
      generation: 1,
      mediaType: "application/octet-stream",
    });
    const chunk = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
    for (let part = 0; part < 32; part++) {
      await store.append({
        writer,
        expectedOffset: part * chunk.length,
        appendId: `part-${part}`,
        bytes: chunk,
      });
    }
    const offset = 31 * chunk.length - 16;
    const expected = new Uint8Array(33);
    expected.set(chunk.subarray(chunk.length - 16));
    expected.set(chunk.subarray(0, 17), 16);
    assertEquals(
      await store.readRange({
        bodyId: writer.bodyId,
        offset,
        end: offset + 33,
      }),
      expected,
    );
    assertEquals(ranges.at(-1)?.rows, 2);
    assertEquals(ranges.at(-1)?.bytes, 33);
    assertEquals(
      await store.readRange({
        bodyId: writer.bodyId,
        offset: 32 * chunk.length,
        end: 32 * chunk.length + 1,
      }),
      new Uint8Array(),
    );

    const ready = await store.seal({
      writer,
      expectedByteLength: 32 * chunk.length,
      expectedDigest: await digestContent(
        Uint8Array.from(
          { length: 32 * chunk.length },
          (_, index) => chunk[index % chunk.length],
        ),
      ),
    });
    assertEquals(
      await store.readRange({
        bodyId: writer.bodyId,
        offset: ready.byteLength - 7,
        end: ready.byteLength + 100,
      }),
      chunk.subarray(chunk.length - 7),
    );
    assertEquals(ranges.at(-1)?.rows, 1);
    assertEquals(
      ranges.at(-1)?.bytes,
      7,
      "compacted immutable parts are sliced inside SQL",
    );
    assertEquals(
      (await readBodyBytes(store, { bodyId: writer.bodyId })).length,
      32 * chunk.length,
    );
    await assertRejects(() =>
      store.readRange({ bodyId: "missing", offset: 0, end: 1 })
    );
  } finally {
    await db.close();
  }
});

Deno.test("database BodyStore ranges detect missing, overlapping, and truncated committed parts", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `body_ranges_${crypto.randomUUID().replaceAll("-", "")}`;
  const store = createDatabaseBodyStore({ session: db, schema });
  try {
    const writer = await store.reserve({
      bodyId: "damaged",
      reservationId: "damaged-test",
      generation: 1,
      mediaType: "text/plain",
    });
    const bytes = new TextEncoder().encode("abcd");
    for (let part = 0; part < 3; part++) {
      await store.append({
        writer,
        expectedOffset: part * 4,
        appendId: `part-${part}`,
        bytes,
      });
    }
    await db.query(
      `DELETE FROM "${schema}".content_body_parts WHERE body_id=$1 AND start_offset=4`,
      [writer.bodyId],
    );
    const missing = await assertRejects(() =>
      store.readRange({ bodyId: writer.bodyId, offset: 2, end: 10 })
    );
    assertEquals((missing as Error & { code: string }).code, "asset_corrupted");
    await db.query(
      `INSERT INTO "${schema}".content_body_parts(body_id,start_offset,append_id,bytes,part_digest) VALUES($1,4,'overlap',$2,$3)`,
      [
        writer.bodyId,
        new TextEncoder().encode("abcdef"),
        await digestContent(new TextEncoder().encode("abcdef")),
      ],
    );
    const overlap = await assertRejects(() =>
      store.readRange({ bodyId: writer.bodyId, offset: 2, end: 10 })
    );
    assertEquals((overlap as Error & { code: string }).code, "asset_corrupted");
    await db.query(
      `DELETE FROM "${schema}".content_body_parts WHERE body_id=$1 AND start_offset=8`,
      [writer.bodyId],
    );
    const truncated = await assertRejects(() =>
      store.readRange({ bodyId: writer.bodyId, offset: 9, end: 12 })
    );
    assertEquals(
      (truncated as Error & { code: string }).code,
      "asset_corrupted",
    );
  } finally {
    await db.close();
  }
});

Deno.test("database BodyStore physical conformance", async (t) => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  try {
    await bodyStoreConformance(
      t,
      createDatabaseBodyStore({
        session: db,
        schema: `body_conformance_${crypto.randomUUID().replaceAll("-", "")}`,
      }),
    );
  } finally {
    await db.close();
  }
});

Deno.test("database body CAS rolls back header updates when writing a part fails", async () => {
  const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    }),
    schema = `body_rollback_${crypto.randomUUID().replaceAll("-", "")}`;
  let refuse = false;
  const session = {
    query: db.query,
    transaction: <T>(operation: (tx: SqlExecutor) => Promise<T>) =>
      db.transaction((tx) =>
        operation({
          query(sql, params) {
            if (
              refuse &&
              sql.startsWith(`INSERT INTO "${schema}"."content_body_parts"`)
            ) throw new Error("injected part failure");
            return tx.query(sql, params);
          },
        })
      ),
  };
  const store = createDatabaseBodyStore({ session, schema });
  try {
    const writer = await store.reserve({
        bodyId: "rollback",
        mediaType: "text/plain",
        reservationId: "rollback",
        generation: 1,
      }),
      before = await store.head({ bodyId: writer.bodyId });
    refuse = true;
    await assertRejects(() =>
      store.append({
        writer,
        expectedOffset: 0,
        appendId: "a",
        bytes: new Uint8Array([1]),
      })
    );
    refuse = false;
    assertEquals(await store.head({ bodyId: writer.bodyId }), before);
    assertEquals(
      (await db.query(
        `SELECT count(*)::int AS n FROM "${schema}".content_body_parts`,
      )).rows[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});
Deno.test("database body retries reconcile lost commit acknowledgement and reject corrupt head extents", async () => {
  const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    }),
    schema = `body_unknown_${crypto.randomUUID().replaceAll("-", "")}`;
  let lose = false, mutated = false;
  const session = {
    query: db.query,
    async transaction<T>(
      operation: (tx: SqlExecutor) => Promise<T>,
    ): Promise<T> {
      const result = await db.transaction((tx) =>
        operation({
          query(sql, params) {
            if (
              lose &&
              (sql.startsWith(`UPDATE "${schema}"."content_bodies"`) ||
                sql.startsWith(`INSERT INTO "${schema}"."content_bodies"`))
            ) mutated = true;
            return tx.query(sql, params);
          },
        })
      );
      if (lose && mutated) {
        lose = false;
        mutated = false;
        throw new Error("lost committed acknowledgement");
      }
      return result;
    },
  };
  let store = createDatabaseBodyStore({ session, schema });
  try {
    await store.reserve({
      bodyId: "warm",
      mediaType: "text/plain",
      reservationId: "warm",
      generation: 1,
    });
    const identity = {
      bodyId: "unknown",
      mediaType: "text/plain",
      reservationId: "unknown",
      generation: 1,
    };
    lose = true;
    await assertRejects(() => store.reserve(identity));
    const writer = await store.reserve(identity);
    store = createDatabaseBodyStore({
      session: { ...session },
      schema,
      provisioned: true,
    });
    const request = {
      writer,
      expectedOffset: 0,
      appendId: "a",
      bytes: new Uint8Array([1, 2]),
    };
    lose = true;
    await assertRejects(() => store.append(request));
    const head = (await store.head({ bodyId: writer.bodyId }))!;
    assertEquals((await store.append(request)).versionToken, head.versionToken);
    await db.query(
      `UPDATE "${schema}".content_bodies SET byte_length=1 WHERE body_id=$1`,
      [writer.bodyId],
    );
    await assertRejects(() => store.append(request));
    await db.query(
      `UPDATE "${schema}".content_bodies SET byte_length=2 WHERE body_id=$1`,
      [writer.bodyId],
    );
    store = createDatabaseBodyStore({
      session: { ...session },
      schema,
      provisioned: true,
    });
    lose = true;
    await assertRejects(() => store.fence({ writer }));
    assertEquals((await store.fence({ writer })).generation, 2);
  } finally {
    await db.close();
  }
});
