import { assert, assertEquals } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "../application/application.ts";
import { createCoreTableNames, type SqlExecutor } from "../events/index.ts";
import { definePlugin, defineProcessor } from "../plugins/index.ts";
import { defineAction } from "./define.ts";
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

      // Inline content records only execution history; it creates no domain records.
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
      const records = await db.query(
        `SELECT id FROM ${tables.nodes}`,
      );
      assertEquals(records.rows, []);
      const edges = await db.query(`SELECT id FROM ${tables.edges}`);
      assertEquals(edges.rows, []);
      const receipts = await db.query<
        { body: { actionId?: string; input?: unknown } }
      >(
        `SELECT body FROM ${tables.event_bodies}`,
      );
      const contentReceipts = receipts.rows.filter(({ body }) =>
        body.actionId === withContent.id
      );
      assertEquals(contentReceipts.length, 2);
      for (const { body } of contentReceipts) {
        assertEquals(body.input, {
          content: [{
            kind: "image",
            role: "body",
            mediaType: "image/png",
            value: Array.from(bytes),
          }],
        });
      }
    }
  } finally {
    await app.shutdown();
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

Deno.test("PGlite receipts claim runs without writing domain records", () =>
  receiptScenarios(":memory:"));

Deno.test({
  name: "PostgreSQL receipts claim runs without writing domain records",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => receiptScenarios(POSTGRES_URL!),
});
