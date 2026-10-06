import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createDatabaseBodyStore } from "./database-body-store.ts";
import { readBodyBytes } from "./body-store.ts";
import type { SqlExecutor } from "../events/index.ts";

Deno.test("database BodyStore ranges use indexed overlapping parts and transfer only requested bytes", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "body_indexed_ranges";
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
    assertEquals(
      ranges.at(-1)?.rows,
      0,
      "empty/clamped ranges do not fetch parts",
    );
    assertEquals(ranges.at(-1)?.bytes, 0);
    const ready = await store.seal({
      writer,
      expectedByteLength: 32 * chunk.length,
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
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "body_range_integrity";
  const store = createDatabaseBodyStore({ session: db, schema });
  try {
    const writer = await store.reserve({
      bodyId: "damaged",
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
      `INSERT INTO "${schema}".content_body_parts(body_id,start_offset,append_id,bytes) VALUES($1,4,'overlap',$2)`,
      [writer.bodyId, new TextEncoder().encode("abcdef")],
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
