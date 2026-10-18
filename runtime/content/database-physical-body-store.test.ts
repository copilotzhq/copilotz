import { PHYSICAL_READ_MAX_BYTES } from "./physical-body-store.ts";
import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import type { SqlSession } from "../events/session.ts";
import { provisionPhysicalBodySchema } from "./physical-body-schema.ts";
import { createDatabasePhysicalBodyStore } from "./database-physical-body-store.ts";

const writer = {
  bodyId: "body",
  mediaType: "text/plain",
  reservationId: "reservation",
  generation: 7,
} as const;
const chunk = (...bytes: number[]) => new Uint8Array(bytes);
async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim() || ":memory:",
  });
  const schema = `physical_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await provisionPhysicalBodySchema(db, schema);
    const store = await createDatabasePhysicalBodyStore({
      session: db,
      schema,
    });
    return { db, store, schema };
  } catch (error) {
    await db.close();
    throw error;
  }
}

Deno.test("database physical reserve is create-only and reopens exact identity", async () => {
  const { db, store, schema } = await fixture();
  try {
    const reserved = await store.reserve(writer);
    const reopened = await createDatabasePhysicalBodyStore({
      session: db,
      schema,
    });
    assertEquals(await reopened.reserve(writer), reserved);
    await assertRejects(() =>
      reopened.reserve({ ...writer, reservationId: "different" })
    );
    await assertRejects(() => reopened.reserve({ ...writer, generation: 8 }));
    await assertRejects(() =>
      reopened.reserve({ ...writer, mediaType: "application/json" })
    );
    assertEquals(await store.head("missing"), null);
  } finally {
    await db.close();
  }
});

Deno.test("database physical append captures bytes and binds original offset on replay", async () => {
  const { db, store } = await fixture();
  try {
    await store.reserve(writer);
    const bytes = chunk(1, 2, 3);
    const pending = store.append({
      writer,
      expectedOffset: 0,
      appendId: "a",
      bytes,
    });
    bytes.fill(9);
    const first = await pending;
    assertEquals(
      await store.readRange({ bodyId: writer.bodyId, offset: 0, end: 3 }),
      chunk(1, 2, 3),
    );
    const second = await store.append({
      writer,
      expectedOffset: 3,
      appendId: "b",
      bytes: chunk(4, 5),
    });
    assertNotEquals(second.versionToken, first.versionToken);
    assertEquals(
      await store.append({
        writer,
        expectedOffset: 0,
        appendId: "a",
        bytes: chunk(1, 2, 3),
      }),
      {
        startOffset: 0,
        endOffset: 5,
        versionToken: second.versionToken,
      },
    );
    await assertRejects(() =>
      store.append({
        writer,
        expectedOffset: 1,
        appendId: "a",
        bytes: chunk(1, 2, 3),
      })
    );
    await assertRejects(() =>
      store.append({
        writer,
        expectedOffset: 0,
        appendId: "a",
        bytes: chunk(9, 2, 3),
      })
    );
    await assertRejects(() =>
      store.append({
        writer,
        expectedOffset: 0,
        appendId: "c",
        bytes: chunk(1),
      })
    );
    await assertRejects(() =>
      store.append({
        writer,
        expectedOffset: 5,
        appendId: "empty",
        bytes: chunk(),
      })
    );
    assertEquals(
      await store.readRange({ bodyId: writer.bodyId, offset: 1, end: 4 }),
      chunk(2, 3, 4),
    );
    assertEquals(
      (await store.head(writer.bodyId))?.versionToken,
      second.versionToken,
    );
  } finally {
    await db.close();
  }
});

Deno.test("database physical fence advances once, keeps the tail and blocks stale duplicates", async () => {
  const { db, store } = await fixture();
  try {
    await store.reserve(writer);
    await store.append({
      writer,
      expectedOffset: 0,
      appendId: "a",
      bytes: chunk(1, 2, 3),
    });
    const fenced = await store.fence(writer);
    assertEquals(fenced.state, "fenced");
    assertEquals(fenced.generation, 8);
    assertEquals(await store.fence(writer), fenced);
    assertEquals(
      await store.readRange({ bodyId: writer.bodyId, offset: 0, end: 3 }),
      chunk(1, 2, 3),
    );
    await assertRejects(() =>
      store.append({
        writer,
        expectedOffset: 0,
        appendId: "a",
        bytes: chunk(1, 2, 3),
      })
    );
    await assertRejects(() => store.reserve(writer));
    await assertRejects(() => store.reserve({ ...writer, generation: 8 }));
    await assertRejects(() => store.fence({ ...writer, generation: 8 }));
  } finally {
    await db.close();
  }
});

Deno.test("database physical missing-key fence refuses a delayed reserve", async () => {
  const { db, store } = await fixture();
  try {
    const fenced = await store.fence(writer);
    assertEquals(await store.fence(writer), fenced);
    await assertRejects(() => store.reserve(writer));
    assertEquals(
      await store.readRange({ bodyId: writer.bodyId, offset: 0, end: 0 }),
      chunk(),
    );
    await assertRejects(() =>
      store.readRange({ bodyId: writer.bodyId, offset: 0, end: 1 })
    );
  } finally {
    await db.close();
  }
});

Deno.test("database physical range enforces bounds and contiguous indexed parts", async () => {
  const { db, store, schema } = await fixture();
  try {
    await store.reserve(writer);
    await store.append({
      writer,
      expectedOffset: 0,
      appendId: "a",
      bytes: chunk(1, 2, 3),
    });
    await store.append({
      writer,
      expectedOffset: 3,
      appendId: "b",
      bytes: chunk(4, 5, 6),
    });
    for (let start = 0; start <= 6; start++) {
      for (let end = start; end <= 6; end++) {
        assertEquals(
          await store.readRange({ bodyId: writer.bodyId, offset: start, end }),
          chunk(1, 2, 3, 4, 5, 6).slice(start, end),
        );
      }
    }
    await assertRejects(() =>
      store.readRange({ bodyId: writer.bodyId, offset: 0, end: 7 })
    );
    let payloads: unknown[] = [];
    const measured = await createDatabasePhysicalBodyStore({
      schema,
      session: {
        transaction: db.transaction,
        async query<
          TRow extends Record<string, unknown> = Record<string, unknown>,
        >(sql: string, params?: unknown[]) {
          const result = await db.query<TRow>(sql, params);
          if (sql.includes("LEFT JOIN LATERAL")) {
            payloads = result.rows.map((row) => row.bytes);
          }
          return result;
        },
      },
    });
    assertEquals(
      await measured.readRange({ bodyId: writer.bodyId, offset: 1, end: 4 }),
      chunk(2, 3, 4),
    );
    const transferred = payloads.reduce<number>((sum, value) => {
      if (value instanceof Uint8Array) return sum + value.byteLength;
      if (value instanceof ArrayBuffer) return sum + value.byteLength;
      if (typeof value === "string") {
        return sum +
          (value.startsWith("\\x")
            ? (value.length - 2) / 2
            : atob(value).length);
      }
      throw new Error("Expected SQL byte payload in positive control");
    }, 0);
    assertEquals(transferred, 3);
    await db.query(
      `INSERT INTO ${schema}.content_body_parts(body_id,start_offset,append_id,bytes) VALUES ($1,1,'overlap',$2)`,
      [writer.bodyId, chunk(9, 9, 9)],
    );
    await assertRejects(() =>
      measured.readRange({ bodyId: writer.bodyId, offset: 0, end: 6 })
    );
    assertEquals(
      payloads,
      [null],
      "invalid coverage sends no payload across SQL",
    );
    await db.query(
      `DELETE FROM ${schema}.content_body_parts WHERE append_id='overlap'`,
    );
    await db.query(
      `DELETE FROM ${schema}.content_body_parts WHERE start_offset=0`,
    );
    await assertRejects(() =>
      store.readRange({ bodyId: writer.bodyId, offset: 0, end: 6 })
    );
  } finally {
    await db.close();
  }
});

Deno.test("database physical failed final update rolls back inserted bytes", async () => {
  const { db, store, schema } = await fixture();
  try {
    await store.reserve(writer);
    const session: SqlSession = {
      query: db.query,
      transaction: (operation) =>
        db.transaction((tx) =>
          operation({
            query(sql, params) {
              if (
                sql.startsWith(`UPDATE "${schema}"."content_bodies"`)
              ) return Promise.resolve({ rows: [] });
              return tx.query(sql, params);
            },
          })
        ),
    };
    const refused = await createDatabasePhysicalBodyStore({
      session,
      schema,
    });
    await assertRejects(() =>
      refused.append({
        writer,
        expectedOffset: 0,
        appendId: "a",
        bytes: chunk(1),
      })
    );
    assertEquals(
      (await db.query(
        `SELECT count(*)::int AS n FROM ${schema}.content_body_parts`,
      )).rows[0].n,
      0,
    );
    assertEquals((await store.head(writer.bodyId))?.byteLength, 0);
  } finally {
    await db.close();
  }
});

Deno.test("database physical append survives lost committed acknowledgement without another part", async () => {
  const { db, store, schema } = await fixture();
  try {
    await store.reserve(writer);
    let lose = true;
    const session: SqlSession = {
      query: db.query,
      async transaction(operation) {
        const result = await db.transaction(operation);
        if (lose) {
          lose = false;
          throw new Error("lost committed acknowledgement");
        }
        return result;
      },
    };
    const uncertain = await createDatabasePhysicalBodyStore({
      session,
      schema,
    });
    const request = {
      writer,
      expectedOffset: 0,
      appendId: "a",
      bytes: chunk(1, 2),
    };
    await assertRejects(() => uncertain.append(request));
    const committed = await store.head(writer.bodyId);
    const replay = await uncertain.append(request);
    assertEquals(replay.versionToken, committed?.versionToken);
    assertEquals(
      (await db.query(
        `SELECT count(*)::int AS n FROM ${schema}.content_body_parts`,
      )).rows[0].n,
      1,
    );
  } finally {
    await db.close();
  }
});

Deno.test("database physical reserve and fence recover lost committed acknowledgements", async () => {
  const { db, schema } = await fixture();
  try {
    let lose = true;
    const session: SqlSession = {
      query: db.query,
      async transaction(operation) {
        const result = await db.transaction(operation);
        if (lose) {
          lose = false;
          throw new Error("lost committed acknowledgement");
        }
        return result;
      },
    };
    const store = await createDatabasePhysicalBodyStore({ session, schema });
    await assertRejects(() => store.reserve(writer));
    const reserved = await store.head(writer.bodyId);
    assertEquals(await store.reserve(writer), reserved);
    lose = true;
    await assertRejects(() => store.fence(writer));
    const fenced = await store.head(writer.bodyId);
    assertEquals(await store.fence(writer), fenced);
    assertEquals(fenced?.generation, 8);
    await assertRejects(() => store.reserve(writer));
  } finally {
    await db.close();
  }
});

Deno.test("database physical replay refuses an acknowledged extent beyond a corrupt head", async () => {
  const { db, store, schema } = await fixture();
  try {
    await store.reserve(writer);
    const request = {
      writer,
      expectedOffset: 0,
      appendId: "a",
      bytes: chunk(1, 2),
    };
    await store.append(request);
    await db.query(`UPDATE ${schema}.content_bodies SET byte_length=1`);
    await assertRejects(() => store.append(request));
  } finally {
    await db.close();
  }
});

Deno.test("database physical competing offsets and fencing keep a single ordered outcome", async () => {
  const { db, store } = await fixture();
  try {
    await store.reserve(writer);
    const results = await Promise.allSettled([
      store.append({
        writer,
        expectedOffset: 0,
        appendId: "a",
        bytes: chunk(1),
      }),
      store.append({
        writer,
        expectedOffset: 0,
        appendId: "b",
        bytes: chunk(2),
      }),
    ]);
    assertEquals(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assertEquals((await store.head(writer.bodyId))?.byteLength, 1);
    const other = { ...writer, bodyId: "other" };
    await Promise.allSettled([store.reserve(other), store.fence(other)]);
    assertEquals((await store.head(other.bodyId))?.state, "fenced");
    await assertRejects(() => store.reserve(other));
    const raced = await Promise.allSettled([
      store.append({
        writer,
        expectedOffset: 1,
        appendId: "c",
        bytes: chunk(3),
      }),
      store.fence(writer),
    ]);
    assertEquals(raced[1].status, "fulfilled");
    assertEquals((await store.head(writer.bodyId))?.state, "fenced");
    assertEquals(
      (await store.head(writer.bodyId))?.byteLength,
      raced[0].status === "fulfilled" ? 2 : 1,
    );
  } finally {
    await db.close();
  }
});

Deno.test("database physical ranges page at the shared 1 MiB bound", async () => {
  const { db, store } = await fixture();
  try {
    const payload = new Uint8Array(PHYSICAL_READ_MAX_BYTES).fill(7);
    await store.reserve(writer);
    await store.append({
      writer: writer,
      expectedOffset: 0,
      appendId: "maximum",
      bytes: payload,
    });
    assertEquals(
      await store.readRange({
        bodyId: writer.bodyId,
        offset: 0,
        end: PHYSICAL_READ_MAX_BYTES,
      }),
      payload,
    );
    const error = await assertRejects(async () =>
      await store.readRange({
        bodyId: "missing",
        offset: 0,
        end: PHYSICAL_READ_MAX_BYTES + 1,
      })
    );
    assertEquals((error as { code: string }).code, "content_invalid");
  } finally {
    await db.close();
  }
});
