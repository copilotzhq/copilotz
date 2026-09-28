import { assert, assertEquals, assertRejects } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "../application/application.ts";
import {
  createCoreTableNames,
  createEventStore,
  createSqlSession,
  type SqlExecutor,
} from "../events/index.ts";
import { definePlugin, defineProcessor } from "../plugins/index.ts";
import { defineAction } from "./define.ts";
import {
  type ActionInputRetention,
  composeActionInputRetention,
  retainActionInputContent,
} from "./content-retention.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

type Statement = Readonly<{ text: string; params: readonly unknown[] }>;

/** Wraps a database so that the statements it runs can be inspected. */
function recording(db: Awaited<ReturnType<typeof createTestDatabase>>) {
  const statements: Statement[] = [];
  let transactions = 0;
  const wrap = (executor: SqlExecutor): SqlExecutor => ({
    query: (text, params) => {
      statements.push({ text, params: params ?? [] });
      return executor.query(text, params);
    },
  });
  return {
    statements,
    get transactions() {
      return transactions;
    },
    reset() {
      statements.length = 0;
      transactions = 0;
    },
    database: {
      query: (text: string, params?: unknown[]) => wrap(db).query(text, params),
      transaction: <T>(operation: (transaction: SqlExecutor) => Promise<T>) => {
        transactions++;
        return db.transaction((transaction) => operation(wrap(transaction)));
      },
      ...(db.listen ? { listen: db.listen } : {}),
      close: db.close,
    },
  } as const;
}

function retentionPlan(
  overrides: Partial<ActionInputRetention> = {},
): ActionInputRetention {
  return {
    namespace: "tenant",
    actionId: "test.retention",
    actionRunId: "run-a",
    refs: [{ assetId: "asset-a", mediaType: "image/png" }, {
      assetId: "asset-b",
      mediaType: "image/png",
    }],
    assetIds: ["asset-a", "asset-b"],
    ownerId: "action-content:owner-a",
    edgeIds: ["action-content-edge:a", "action-content-edge:b"],
    ...overrides,
  };
}

async function receiptScenarios(url: string) {
  const db = await createTestDatabase({ url });
  const schema = "receipts_" +
    crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const namespace = "tenant";
  const tables = createCoreTableNames(schema);
  const recorder = recording(db);
  const bytes = new Uint8Array([9, 8, 7]);
  const captured: { actions?: Record<string, (input: unknown) => unknown> } =
    {};
  let run = () => Promise.resolve();
  const plain = defineAction({
    id: "test.plain",
    execute: (input: { value: number }) => input.value,
  });
  const withContent = defineAction({
    id: "test.with-content",
    content: { input: ["content"] },
    execute: () => "accepted",
  });
  const app = await createCopilotzApplication({
    database: recorder.database as never,
    namespace,
    databaseSchema: schema,
    plugins: [definePlugin({
      version: "1.0.0",
      id: "test.receipts",
      actions: { plain, withContent },
      processors: {
        go: defineProcessor({
          id: "test.receipts.go",
          on: [{ eventType: "test.receipts.go" }],
          async handle(
            _event,
            context: import("../plugins/index.ts").ProcessorContext,
          ) {
            captured.actions = context.actions as never;
            await run();
          },
        }),
      },
    })],
  });
  const send = async (id: string) => {
    const sent = await app.send({
      type: "test.receipts.go",
      deduplicationId: id,
    });
    for await (const _ of sent.outputs) { /* Drain observation. */ }
    await sent.done;
  };
  const receiptReads = () =>
    recorder.statements.filter(({ text, params }) =>
      /^\s*SELECT/.test(text) &&
      params.some((value) =>
        typeof value === "string" && value.includes(":action:")
      )
    );
  try {
    // A fresh action reads no receipts and no protected reference: the
    // invoked receipt claims the run, and only a secret input needs it.
    {
      run = async () => {
        assertEquals(await captured.actions!.plain({ value: 1 }), 1);
      };
      await send("warm");
      recorder.reset();
      run = async () => {
        assertEquals(await captured.actions!.plain({ value: 2 }), 2);
      };
      await send("fresh-plain");
      assert(
        recorder.statements.some(({ text }) => text.includes("inserted_event")),
        "the run was recorded",
      );
      assertEquals(
        receiptReads().length,
        0,
        "a fresh run reads no receipts before claiming it",
      );

      // An input Asset is retained by the statement that writes the receipt.
      run = async () => {
        assertEquals(
          await captured.actions!.withContent({
            content: [{
              kind: "image",
              role: "body",
              mediaType: "image/png",
              value: bytes,
            }],
          }),
          "accepted",
        );
      };
      recorder.reset();
      await send("fresh-content");
      const retaining = recorder.statements.filter(({ text }) =>
        text.includes("retention_state")
      );
      assertEquals(retaining.length, 1, "retention is part of the receipt");
      assert(
        retaining[0].text.includes("inserted_event") &&
          retaining[0].text.includes("retention_edges"),
      );
      assertEquals(
        recorder.statements.filter(({ text, params }) =>
          !text.includes("retention_edges") &&
          params.some((value) =>
            typeof value === "string" &&
            value.startsWith("action-content-edge:")
          )
        ).length,
        0,
        "no other statement writes retention",
      );
      const owned = await db.query<{ target: string }>(
        `SELECT e.target_node_id AS target FROM "${schema}".edges e
           JOIN "${schema}".nodes n ON n.id = e.source_node_id
          WHERE n.type = '@copilotz/action-content'`,
      );
      assertEquals(owned.rows.length, 1);
      await app.collections.rebuild(namespace);
      assertEquals(
        (await db.query(
          `SELECT e.target_node_id AS target FROM "${schema}".edges e
             JOIN "${schema}".nodes n ON n.id = e.source_node_id
            WHERE n.type = '@copilotz/action-content'`,
        )).rows,
        owned.rows,
        "rebuild reproduces the retention the statement wrote",
      );
    }

    // The retention fragment on its own, against every way it can refuse.
    const session = createSqlSession(db);
    const store = createEventStore({ session, schema });
    const asset = (id: string, data: Record<string, unknown>) =>
      db.query(
        `INSERT INTO ${tables.nodes} (id, namespace, type, name, data)
         VALUES ($1, $2, 'asset', 'asset', $3::jsonb)`,
        [id, namespace, JSON.stringify(data)],
      );
    await asset("asset-a", { state: "ready", mediaType: "image/png" });
    await asset("asset-b", { state: "ready", mediaType: "image/png" });
    await asset("asset-pending", { state: "pending", mediaType: "image/png" });
    await asset("asset-text", { state: "ready", mediaType: "text/plain" });
    const retain = (
      plan: ActionInputRetention,
      deduplicationId = `${plan.actionRunId}:action:invoked`,
    ) =>
      store.commitMutation({
        draft: {
          type: "test.retention.invoked",
          namespace,
          payload: {},
          deduplicationId,
        },
        consumers: [],
        statement: (param, statementTables) =>
          composeActionInputRetention(plan, statementTables, param),
      });
    const nodesOf = (ownerId: string) =>
      db.query<{ data: unknown }>(
        `SELECT data FROM ${tables.nodes} WHERE id = $1`,
        [ownerId],
      ).then((result) => result.rows);
    const edgesOf = (ownerId: string) =>
      db.query<{ target_node_id: string }>(
        `SELECT target_node_id FROM ${tables.edges}
          WHERE source_node_id = $1 ORDER BY target_node_id`,
        [ownerId],
      ).then((result) => result.rows.map((row) => row.target_node_id));
    const eventsWith = (deduplicationId: string) =>
      db.query(
        `SELECT 1 FROM ${tables.events} WHERE deduplication_id = $1`,
        [deduplicationId],
      ).then((result) => result.rows.length);

    recorder.reset();
    const stored = await retain(retentionPlan());
    assertEquals(stored.deduplicated, false);
    assertEquals(recorder.transactions, 0);
    assertEquals(await edgesOf("action-content:owner-a"), [
      "asset-a",
      "asset-b",
    ]);
    assertEquals((await nodesOf("action-content:owner-a")).length, 1);

    // A retry of the same receipt finds it and changes nothing.
    assertEquals((await retain(retentionPlan())).deduplicated, true);
    assertEquals((await edgesOf("action-content:owner-a")).length, 2);

    const refused = async (plan: ActionInputRetention, message: string) => {
      const error = await assertRejects(() => retain(plan));
      assertEquals((error as Error).message, message);
      assertEquals(
        await eventsWith(`${plan.actionRunId}:action:invoked`),
        0,
        "a refused receipt is not written",
      );
      assertEquals((await nodesOf(plan.ownerId)).length, 0);
    };
    const unavailable =
      "Action input Asset is unavailable for durable retention.";
    await refused(
      retentionPlan({
        actionRunId: "run-missing",
        ownerId: "action-content:owner-missing",
        refs: [{ assetId: "asset-nowhere", mediaType: "image/png" }],
        assetIds: ["asset-nowhere"],
        edgeIds: ["action-content-edge:missing"],
      }),
      unavailable,
    );
    await refused(
      retentionPlan({
        actionRunId: "run-pending",
        ownerId: "action-content:owner-pending",
        refs: [{ assetId: "asset-pending", mediaType: "image/png" }],
        assetIds: ["asset-pending"],
        edgeIds: ["action-content-edge:pending"],
      }),
      unavailable,
    );
    await refused(
      retentionPlan({
        actionRunId: "run-type",
        ownerId: "action-content:owner-type",
        refs: [{ assetId: "asset-text", mediaType: "image/png" }],
        assetIds: ["asset-text"],
        edgeIds: ["action-content-edge:type"],
      }),
      unavailable,
    );
    // Two references to one Asset must each match its media type.
    await refused(
      retentionPlan({
        actionRunId: "run-twice",
        ownerId: "action-content:owner-twice",
        refs: [
          { assetId: "asset-a", mediaType: "image/png" },
          { assetId: "asset-a", mediaType: "image/jpeg" },
        ],
        assetIds: ["asset-a"],
        edgeIds: ["action-content-edge:twice"],
      }),
      unavailable,
    );
    // An owner identity that holds something else is a conflict.
    await db.query(
      `INSERT INTO ${tables.nodes} (id, namespace, type, name, data, source_type, source_id)
       VALUES ('action-content:owner-taken', $1, '@copilotz/action-content',
               'test.retention', '{"assetIds":["asset-b"]}'::jsonb, 'action', 'run-taken')`,
      [namespace],
    );
    const conflict = await assertRejects(() =>
      retain(retentionPlan({
        actionRunId: "run-taken",
        ownerId: "action-content:owner-taken",
        refs: [{ assetId: "asset-a", mediaType: "image/png" }],
        assetIds: ["asset-a"],
        edgeIds: ["action-content-edge:taken"],
      }))
    );
    assertEquals(
      (conflict as Error).message,
      "Action content retention identity conflicts with existing data.",
    );
    assertEquals(await eventsWith("run-taken:action:invoked"), 0);

    // The statement writes the same rows as retention in code, which rebuild
    // still uses.
    const legacyPlan = retentionPlan({
      actionRunId: "run-legacy",
      ownerId: "action-content:owner-legacy",
      edgeIds: ["action-content-edge:la", "action-content-edge:lb"],
    });
    await session.transaction((transaction) =>
      retainActionInputContent({ transaction, tables }, legacyPlan)
    );
    const shape = (ownerId: string) =>
      db.query(
        `SELECT n.type, n.name, n.data, n.source_type,
                (SELECT jsonb_agg(jsonb_build_array(e.type, e.data, e.weight, e.target_node_id)
                                  ORDER BY e.target_node_id)
                   FROM ${tables.edges} e WHERE e.source_node_id = n.id) AS edges
           FROM ${tables.nodes} n WHERE n.id = $1`,
        [ownerId],
      ).then((result) => result.rows);
    assertEquals(
      await shape("action-content:owner-legacy"),
      await shape("action-content:owner-a"),
    );
  } finally {
    await app.shutdown();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("PGlite receipts claim runs and retain input Assets in their own statement", () =>
  receiptScenarios(":memory:"));

Deno.test({
  name:
    "PostgreSQL receipts claim runs and retain input Assets in their own statement",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => receiptScenarios(POSTGRES_URL!),
});
