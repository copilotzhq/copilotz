import { insertTestOwnerBody } from "../testing/owner-catalog.ts";
import { createEventStore } from "../events/store.ts";
import { provisionOwnerCommandSchema } from "../owner/schema.ts";
import { provisionOwnerAssignments } from "../owner/assignments.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import {
  createOperationCatalogTables,
  provisionOperationCatalog,
} from "./catalog.ts";
import { operationCatalogSchemaStatements } from "./catalog-schema.ts";
import {
  provisionOwnerContentCatalog,
  validateOwnerContentCatalog,
} from "./owner-catalog-schema.ts";

async function fixtureStatements(db: SqlExecutor, sql: string): Promise<void> {
  // Fixed fixture DDL only; none of these literals contains an embedded semicolon.
  for (const statement of sql.split(";").filter((s) => s.trim())) {
    await db.query(statement);
  }
}

function schemaName() {
  return `owner_catalog_${crypto.randomUUID().replaceAll("-", "")}`;
}
function traced(
  session: SqlSession,
  statements: string[],
  reject?: (sql: string) => boolean,
): SqlSession {
  const wrap = (executor: SqlExecutor): SqlExecutor => ({
    query: (sql, params) => {
      statements.push(sql);
      if (reject?.(sql)) {
        return Promise.reject(new Error("injected DDL refusal"));
      }
      return executor.query(sql, params);
    },
  });
  return {
    ...wrap(session),
    transaction: (fn) => session.transaction((tx) => fn(wrap(tx))),
  };
}
async function inventory(db: SqlExecutor, schema: string) {
  return (await db.query(
    `SELECT c.relname,c.relkind::text,
    CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) ELSE NULL END AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 ORDER BY c.relname`,
    [schema],
  )).rows;
}

Deno.test("shared catalog DDL preserves all twenty legacy statements exactly", async () => {
  const statements = operationCatalogSchemaStatements(
    createOperationCatalogTables("catalog_ddl_parity"),
  );
  assertEquals(statements.length, 20);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(statements)),
  );
  assertEquals(
    Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0"))
      .join(""),
    "71883dc01caa243c8a90634e7d2b68b5d812193cd471fd01959aa731ac8885e2",
  );
});

Deno.test("owner catalog fresh provisioning is atomic and identical reopen is read-only", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const schema = schemaName();
    const statements: string[] = [];
    await provisionOwnerContentCatalog(traced(db, statements), schema);
    const locks = statements.filter((s) => s.includes("pg_advisory_xact_lock"));
    assertEquals(locks.length, 2);
    const before = await inventory(db, schema);
    statements.length = 0;
    const readOnly = traced(
      db,
      statements,
      (sql) => /^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i.test(sql),
    );
    await provisionOwnerContentCatalog(readOnly, schema);
    await validateOwnerContentCatalog(readOnly, schema);
    assertEquals(await inventory(db, schema), before);
    await db.query(
      `SELECT nextval('"${schema}".copilotz_operation_streams_replay_key_seq')`,
    );
    await validateOwnerContentCatalog(db, schema);
    await assertRejects(() => provisionOperationCatalog(db, schema));
    await assertRejects(() => provisionCopilotzSchema(db, schema));
    assertEquals(await inventory(db, schema), before);
    const failed = schemaName();
    await assertRejects(() =>
      provisionOwnerContentCatalog(
        traced(db, [], (sql) =>
          sql.includes("CREATE TABLE IF NOT EXISTS") &&
          sql.includes("copilotz_operation_streams")),
        failed,
      )
    );
    assertEquals(await inventory(db, failed), []);
    assertEquals(
      (await db.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [failed]))
        .rows,
      [],
    );
    await provisionOwnerContentCatalog(db, failed);
  } finally {
    await db.close();
  }
});

Deno.test("owner catalog can follow fresh core tables without changing legacy admission", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const schema = schemaName();
    await provisionCopilotzSchema(db, schema);
    await provisionOwnerContentCatalog(db, schema);
    await validateOwnerContentCatalog(db, schema);
    await provisionOwnerCommandSchema(db, schema);
    await provisionOwnerAssignments(db, schema);
    await provisionOwnerContentCatalog(db, schema);
    await assertRejects(() => provisionCopilotzSchema(db, schema));
    assertEquals(
      (await db.query(`SELECT count(*)::integer AS n FROM "${schema}".events`))
        .rows,
      [{ n: 0 }],
    );
  } finally {
    await db.close();
  }
});

Deno.test("owner catalog refuses legacy, unmarked, partial and orphan relation layouts before DDL", async (t) => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const setups: Record<string, (schema: string) => Promise<unknown>> = {
      legacy: async (schema) => {
        await db.query(`CREATE SCHEMA "${schema}"`);
        await provisionOperationCatalog(db, schema);
      },
      unmarked: (schema) =>
        fixtureStatements(
          db,
          `CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".copilotz_operations (id text)`,
        ),
      sequence: (schema) =>
        fixtureStatements(
          db,
          `CREATE SCHEMA "${schema}"; CREATE SEQUENCE "${schema}".copilotz_operation_streams_replay_key_seq`,
        ),
      index: (schema) =>
        fixtureStatements(
          db,
          `CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".unrelated (id text);CREATE INDEX copilotz_operations_public_root_idx ON "${schema}".unrelated(id)`,
        ),
      physicalIndex: (schema) =>
        fixtureStatements(
          db,
          `CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".unrelated (id text);CREATE INDEX owner_stream_physical_key ON "${schema}".unrelated(id)`,
        ),
      retainedCore: async (schema) => {
        await provisionCopilotzSchema(db, schema);
        await createEventStore({ session: db, schema }).append({
          type: "seed",
          namespace: "tenant",
          payload: {},
        }, []);
      },
      coreRls: async (schema) => {
        await provisionCopilotzSchema(db, schema);
        await db.query(
          `ALTER TABLE "${schema}".nodes ENABLE ROW LEVEL SECURITY`,
        );
      },
      coreForcedRls: async (schema) => {
        await provisionCopilotzSchema(db, schema);
        await db.query(
          `ALTER TABLE "${schema}".nodes FORCE ROW LEVEL SECURITY`,
        );
      },
      partialCore: (schema) =>
        fixtureStatements(
          db,
          `CREATE SCHEMA "${schema}";CREATE TABLE "${schema}".nodes(id text)`,
        ),
      emptyOwner: (schema) =>
        fixtureStatements(
          db,
          `CREATE SCHEMA "${schema}";CREATE TABLE "${schema}".owner_epochs(owner text)`,
        ),
      ownerView: (schema) =>
        fixtureStatements(
          db,
          `CREATE SCHEMA "${schema}";CREATE VIEW "${schema}".owner_assignments AS SELECT 1 AS value`,
        ),
      physical: (schema) =>
        fixtureStatements(
          db,
          `CREATE SCHEMA "${schema}";CREATE TABLE "${schema}".content_bodies(id text)`,
        ),
      partial: async (schema) => {
        await provisionOwnerContentCatalog(db, schema);
        await db.query(
          `DROP TABLE "${schema}".copilotz_operation_selection_heads`,
        );
      },
    };
    for (const [name, setup] of Object.entries(setups)) {
      await t.step(name, async () => {
        const schema = schemaName();
        await setup(schema);
        const before = await inventory(db, schema);
        const statements: string[] = [];
        await assertRejects(() =>
          provisionOwnerContentCatalog(traced(db, statements), schema)
        );
        assertEquals(
          statements.some((s) =>
            /^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i.test(s)
          ),
          false,
        );
        assertEquals(await inventory(db, schema), before);
      });
    }
  } finally {
    await db.close();
  }
});

Deno.test("owner catalog refuses damaged shared and stream layouts without repair", async (t) => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const changes: Record<string, (s: string) => string> = {
      nullable: (s) =>
        `ALTER TABLE "${s}".copilotz_operation_streams ALTER COLUMN owner_id DROP NOT NULL`,
      type: (s) =>
        `ALTER TABLE "${s}".copilotz_operations ALTER COLUMN correlation_id TYPE varchar`,
      default: (s) =>
        `ALTER TABLE "${s}".copilotz_operations ALTER COLUMN next_stream_ordinal SET DEFAULT 2`,
      check: (s) =>
        `ALTER TABLE "${s}".copilotz_operation_streams DROP CONSTRAINT owner_stream_generation_check`,
      weakCheck: (s) =>
        `ALTER TABLE "${s}".copilotz_operation_streams DROP CONSTRAINT owner_stream_generation_check; ALTER TABLE "${s}".copilotz_operation_streams ADD CONSTRAINT owner_stream_generation_check CHECK(writer_generation>0)`,
      generated: (s) =>
        `ALTER TABLE "${s}".copilotz_operation_streams ADD COLUMN extra text GENERATED ALWAYS AS (owner_id) STORED`,
      renewal: (s) =>
        `DROP INDEX "${s}".copilotz_operation_streams_renewal_idx`,
      gin: (s) =>
        `DROP INDEX "${s}".copilotz_operations_metadata_idx;CREATE INDEX copilotz_operations_metadata_idx ON "${s}".copilotz_operations USING GIN(metadata jsonb_ops)`,
      predicate: (s) =>
        `DROP INDEX "${s}".copilotz_operation_streams_renewal_idx; CREATE INDEX copilotz_operation_streams_renewal_idx ON "${s}".copilotz_operation_streams(owner_id,protection_deadline,namespace,operation_id,stream_id) WHERE revocation_state='revoked'`,
      sequence: (s) =>
        `CREATE SEQUENCE "${s}".other;ALTER TABLE "${s}".copilotz_operation_streams ALTER COLUMN replay_key SET DEFAULT nextval('"${s}".other')`,
      sequenceOwner: (s) =>
        `ALTER SEQUENCE "${s}".copilotz_operation_streams_replay_key_seq OWNED BY NONE`,
      sequenceIncrement: (s) =>
        `ALTER SEQUENCE "${s}".copilotz_operation_streams_replay_key_seq INCREMENT BY 2`,
      rls: (s) =>
        `ALTER TABLE "${s}".copilotz_operations ENABLE ROW LEVEL SECURITY`,
      timestampPrecision: (s) =>
        `ALTER TABLE "${s}".copilotz_operation_streams ALTER COLUMN protection_deadline TYPE timestamptz(3)`,
      prototypeColumn: (s) =>
        `ALTER TABLE "${s}".copilotz_operation_streams ADD COLUMN "__proto__" text`,
      prototypeConstraint: (s) =>
        `ALTER TABLE "${s}".copilotz_operation_streams ADD CONSTRAINT "__proto__" CHECK (TRUE)`,
      orphan: (s) => `CREATE SEQUENCE "${s}".copilotz_operation_unexpected`,
      marker: (s) => `DELETE FROM "${s}".copilotz_operation_catalog_metadata`,
    };
    for (const [name, change] of Object.entries(changes)) {
      await t.step(name, async () => {
        const schema = schemaName();
        await provisionOwnerContentCatalog(db, schema);
        await fixtureStatements(db, change(schema));
        const before = await inventory(db, schema);
        const statements: string[] = [];
        await assertRejects(() =>
          provisionOwnerContentCatalog(traced(db, statements), schema)
        );
        assertEquals(
          statements.some((s) =>
            /^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i.test(s)
          ),
          false,
        );
        assertEquals(await inventory(db, schema), before);
      });
    }
  } finally {
    await db.close();
  }
});

Deno.test("owner catalog constrains original writer identity, finite deadlines and bounded bindings", async (t) => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const schema = schemaName();
    await provisionOwnerContentCatalog(db, schema);
    const base = {
      namespace: "tenant",
      operation_id: "operation",
      stream_ordinal: null,
      stream_id: "stream",
      semantic_stream_id: "lane",
      body_id: "body",
      descriptor: {
        type: "stream.output",
        namespace: "tenant",
        streamId: "stream",
      },
      owner_id: "owner",
      opening_owner_epoch: 1,
      delivery_attempt: 1,
      placement_binding: { placement: "owner-local", namespace: "tenant" },
      physical_backend_id: "db",
      reservation_id: "reservation",
      writer_generation: 1,
      protection_deadline: "2026-10-18T08:00:00.123456Z",
      revocation_state: "active",
      state: "reserving",
    };
    const insert = (patch: Record<string, unknown> = {}) => {
      const value = { ...base, ...patch };
      const entries = Object.entries(value);
      return db.query(
        `INSERT INTO "${schema}".copilotz_operation_streams (${
          entries.map(([key]) => key).join(",")
        }) VALUES (${entries.map((_, i) => `$${i + 1}`).join(",")})`,
        entries.map(([, v]) =>
          v !== null && typeof v === "object" ? JSON.stringify(v) : v
        ),
      );
    };
    for (
      const [name, patch] of Object.entries({
        reservedOrdinal: { stream_ordinal: 1 },
        unconfirmedOffset: { committed_offset: 1 },
        publishedWithoutOrdinal: { state: "open" },
        zeroPublishedOrdinal: { state: "open", stream_ordinal: 0 },
        unsafePublishedOrdinal: {
          state: "open",
          stream_ordinal: "9007199254740992",
        },
        epoch: { opening_owner_epoch: 0 },
        attempt: { delivery_attempt: 0 },
        generation: { writer_generation: 9007199254740991 },
        deadline: { protection_deadline: "infinity" },
        state: { revocation_state: "expired" },
        prematureTerminal: { outcome: "completed", capture: "complete" },
        binding: { placement_binding: { namespace: "other" } },
        missingBindingNamespace: { placement_binding: {} },
        oversize: {
          placement_binding: { namespace: "tenant", value: "x".repeat(32768) },
        },
        descriptor: {
          descriptor: {
            type: "stream.output",
            namespace: "tenant",
            streamId: "other",
          },
        },
      })
    ) {
      await t.step(name, async () => {
        await assertRejects(() => insert(patch));
      });
    }
    await insert();
    assertEquals(
      (await db.query(
        `SELECT state FROM "${schema}".copilotz_operation_streams`,
      )).rows,
      [{ state: "reserving" }],
    );
    // Schema-only transition. Actual owner confirmation/publication is a later gate.
    await db.query(
      `UPDATE "${schema}".copilotz_operation_streams SET state='open',stream_ordinal=1`,
    );
    assertEquals(
      (await db.query(
        `SELECT to_char(protection_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline,writer_generation::text AS generation FROM "${schema}".copilotz_operation_streams`,
      )).rows,
      [{ deadline: "2026-10-18T08:00:00.123456Z", generation: "1" }],
    );
    await assertRejects(() =>
      insert({
        stream_id: "other",
        state: "open",
        stream_ordinal: 2,
        descriptor: {
          type: "stream.output",
          namespace: "tenant",
          streamId: "other",
        },
      })
    );
    await validateOwnerContentCatalog(db, schema);
  } finally {
    await db.close();
  }
});

Deno.test("owner catalog validates replay sequence identity with public and visible schema names", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionOwnerContentCatalog(db, "public");
    await validateOwnerContentCatalog(db, "public");
    const schema = schemaName();
    await provisionOwnerContentCatalog(db, schema);
    await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL search_path TO "${schema}",pg_catalog`);
      await validateOwnerContentCatalog(tx, schema);
    });
  } finally {
    await db.close();
  }
});

Deno.test("owner publication schema supports confirmation-order ordinals and hidden revoked reservations", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const schema = schemaName();
    await provisionOwnerContentCatalog(db, schema);
    const table = `"${schema}".copilotz_operation_streams`;
    for (const id of ["first", "second", "failed"]) {
      await db.query(
        `INSERT INTO ${table}
        (namespace,operation_id,stream_id,semantic_stream_id,body_id,descriptor,
         owner_id,opening_owner_epoch,delivery_attempt,placement_binding,
         physical_backend_id,reservation_id,writer_generation,protection_deadline,
         revocation_state,state)
        VALUES ('tenant','operation',$1,$1,$1,
          jsonb_build_object('type','stream.output','namespace','tenant','streamId',$1::text),
          'owner',1,1,'{"namespace":"tenant"}','db',$1,1,NOW(),'active','reserving')`,
        [id],
      );
    }
    const published = async (after: number) =>
      (await db.query(
        `SELECT stream_id,stream_ordinal::integer AS ordinal FROM ${table}
       WHERE stream_ordinal > $1 ORDER BY stream_ordinal`,
        [after],
      )).rows;
    assertEquals(await published(0), []);
    // These fixture updates prove the layout only. The actual confirmation command
    // must allocate from the operation counter and publish its event atomically.
    await db.query(
      `UPDATE ${table} SET state='open',stream_ordinal=1 WHERE stream_id='second'`,
    );
    assertEquals(await published(0), [{ stream_id: "second", ordinal: 1 }]);
    await db.query(
      `UPDATE ${table} SET state='open',stream_ordinal=2 WHERE stream_id='first'`,
    );
    assertEquals(await published(1), [{ stream_id: "first", ordinal: 2 }]);
    await db.query(
      `UPDATE ${table} SET revocation_state='revoked' WHERE stream_id='failed'`,
    );
    assertEquals(
      (await db.query(
        `SELECT stream_ordinal,state FROM ${table} WHERE stream_id='failed'`,
      )).rows,
      [{ stream_ordinal: null, state: "reserving" }],
    );
    await assertRejects(() =>
      db.query(
        `UPDATE ${table} SET stream_ordinal=NULL WHERE stream_id='first'`,
      )
    );
    await assertRejects(() =>
      db.query(`UPDATE ${table} SET stream_ordinal=1 WHERE stream_id='first'`)
    );
    await assertRejects(() =>
      db.query(
        `UPDATE ${table} SET state='terminal',outcome='completed',capture='complete',terminal_at=NOW() WHERE stream_id='first'`,
      )
    );
    await db.query(
      `UPDATE ${table} SET revocation_state='revoking' WHERE stream_id='first'`,
    );
    await assertRejects(() =>
      db.query(
        `UPDATE ${table} SET state='terminal',outcome='completed',capture='complete',terminal_at=NOW() WHERE stream_id='first'`,
      )
    );
    await db.query(
      `UPDATE ${table} SET revocation_state='revoked',state='terminal',outcome='completed',capture='complete',terminal_at=NOW() WHERE stream_id='first'`,
    );
    assertEquals(await published(0), [{ stream_id: "second", ordinal: 1 }, {
      stream_id: "first",
      ordinal: 2,
    }]);
    await validateOwnerContentCatalog(db, schema);
  } finally {
    await db.close();
  }
});

Deno.test("owner logical body metadata survives producer pruning and requires atomic adoption evidence", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionOwnerContentCatalog(db, "public");
    await db.query(
      "INSERT INTO copilotz_operations(operation_id,namespace,root_event_id,correlation_id,state,accepted_at,updated_at) VALUES('producer','tenant','event','correlation','completed',NOW(),NOW())",
    );
    await insertTestOwnerBody(db, {
      namespace: "tenant",
      operationId: "producer",
    });
    await db.query(
      "DELETE FROM copilotz_operations WHERE operation_id='producer'",
    );
    assertEquals(
      (await db.query("SELECT logical_body_id FROM copilotz_operation_bodies"))
        .rows,
      [{ logical_body_id: "logical-fixture" }],
    );
    await assertRejects(() =>
      db.query("UPDATE copilotz_operation_bodies SET asset_id='asset'")
    );
    await assertRejects(() =>
      db.query("UPDATE copilotz_operation_bodies SET current_copy='[]'::jsonb")
    );
    await assertRejects(() =>
      db.query("UPDATE copilotz_operation_bodies SET digest='not-a-digest'")
    );
    for (const invalid of ["NULL", "'infinity'::timestamptz"]) {
      await assertRejects(() =>
        db.query(
          `UPDATE copilotz_operation_bodies SET protected_until=${invalid}`,
        )
      );
    }
    assertEquals(
      (await db.query(
        "SELECT protected_until > '2026-10-18'::timestamptz AS protected FROM copilotz_operation_bodies",
      )).rows,
      [{ protected: true }],
    );
    await db.query(
      "UPDATE copilotz_operation_bodies SET adoption_key='message:one:content:0',adoption_fingerprint=$1,asset_id='asset',domain_owner_id='message:one',domain_owner_type='message'",
      [`sha256:${"a".repeat(64)}`],
    );
    await validateOwnerContentCatalog(db, "public");
    await db.query("DROP TABLE copilotz_operation_bodies");
    await assertRejects(() => provisionOwnerContentCatalog(db, "public"));
    assertEquals(
      (await db.query(
        "SELECT to_regclass('public.copilotz_operation_bodies') AS table_name",
      )).rows,
      [{ table_name: null }],
    );
  } finally {
    await db.close();
  }
});
