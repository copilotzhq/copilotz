import { assertEquals } from "@std/assert";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { bindSqlDatabaseIdentity } from "../events/database-identity.ts";
import {
  bindSqlTransactionAlias,
  type SqlExecutor,
  type SqlSession,
} from "../events/session.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testAuthority } from "../testing/authority.ts";
import { testCollectionAuthorizations } from "../testing/collection-authorization.ts";
import {
  type CollectionInvocationAuthority,
  withOwnerCollectionInvocation,
} from "../authorization/invocation.ts";
import type { CollectionPolicyIntent } from "../authorization/intent.ts";
import { defineCollection } from "./definition.ts";
import { createCollectionRuntime } from "./kernel.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const record = defineCollection({
  name: "snapshot_record",
  ownerPolicy: "required",
  schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  } as const,
});
const membership = defineCollection({
  name: "snapshot_state",
  schema: { type: "object" },
});

/**
 * A disclosure evaluates the policy once per row. Every evaluation in one
 * repeatable-read snapshot sees the same facts, so each distinct policy read
 * reaches the database once per snapshot, not once per row.
 */
Deno.test({
  name: "a read snapshot loads each policy fact once for all disclosed rows",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url, pgPoolMax: 4 });
    const schema = `snapshot_reads_${crypto.randomUUID().replaceAll("-", "")}`;
    await provisionCopilotzSchema(db, schema);
    const owner = await openDatabaseOwner(db, schema);
    owner.activate();
    let stateReads = 0;
    let evaluations = 0;
    const counted = (executor: SqlExecutor): SqlExecutor => {
      const alias: SqlExecutor = {
        query(sql, params) {
          if (params?.includes("snapshot_state")) stateReads++;
          return executor.query(sql, params);
        },
      };
      bindSqlTransactionAlias(alias, executor);
      return alias;
    };
    const session: SqlSession = bindSqlDatabaseIdentity({
      query: db.query,
      transaction: db.transaction,
      concurrentReads: db.concurrentReads,
      readTransaction: (operation, options) =>
        db.readTransaction!(
          (snapshot) => operation(counted(snapshot)),
          options,
        ),
    }, db);
    const store = createEventStore({ session, schema });
    const coordinator: EventCoordinator = {
      async commitMutation(input) {
        return {
          ...await store.commitMutation({ ...input, consumers: [] }),
          dispatch: { handles: [], failures: [] },
        };
      },
      append() {
        throw new Error("unused");
      },
      recover() {
        throw new Error("unused");
      },
    };
    const runtime = createCollectionRuntime({
      session,
      eventStore: store,
      coordinator,
      policies: testCollectionAuthorizations(
        { records: record, membership },
        schema,
        async ({ intent, read }) => {
          // Reading the row's identity makes each disclosure its own decision.
          const result = (intent.input as CollectionPolicyIntent).result as
            | { id?: string }
            | undefined;
          if (result?.id) evaluations++;
          if (!(await read.get("membership", "state"))?.allowed) {
            throw new Error("Policy state is missing.");
          }
          return { collections: { records: {} } };
        },
      ),
    });
    runtime.bind(record);
    const rows = 12;
    await db.query(
      `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('state','space','snapshot_state','state','{"allowed":true}')`,
    );
    for (let index = 0; index < rows; index++) {
      await db.query(
        `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES($1,'space','snapshot_record',$1,jsonb_build_object('id',$1::text))`,
        [`record-${String(index).padStart(2, "0")}`],
      );
    }
    const binding = testAuthority(schema);
    const authority: CollectionInvocationAuthority = {
      scope: { databaseSchema: schema, namespace: "space" },
      invocation: { kind: "processor", id: "processor", runId: "run" },
      signal: new AbortController().signal,
      check() {},
      authority: binding,
      resolveSource: () => Promise.reject(new Error("unused")),
    };
    try {
      const listed = await withOwnerCollectionInvocation(
        authority,
        () =>
          runtime.withScope({ namespace: "space" }).snapshot_record.list({
            limit: 50,
          }),
      );
      assertEquals(listed.length, rows);
      assertEquals(evaluations, rows);
      assertEquals(stateReads, 1);
    } finally {
      await releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});
