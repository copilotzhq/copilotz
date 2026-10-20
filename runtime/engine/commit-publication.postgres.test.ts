import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/index.ts";
import type { SqlSession } from "../events/session.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  bounded,
  localPostgresUrl,
  until,
} from "../testing/effect-commit-proxy.ts";
import { createOwnerCommands } from "./commands.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");

Deno.test({
  name:
    "PostgreSQL commit-gated publication reenters the owner once and reports callback failure without skipping later publication",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({
      url: localPostgresUrl(url!),
      pgPoolMax: 4,
    });
    const schema = `publication_${crypto.randomUUID().replaceAll("-", "")}`;
    const tables = createCoreTableNames(schema);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    const order: string[] = [];
    const publicationError = new Error("observed publication failure");
    let holdNext = false, outputVisible = false, callbackRuns = 0;
    const session: SqlSession = {
      query: db.query,
      transaction: (run) =>
        db.transaction(async (tx) => {
          const result = await run(tx);
          if (holdNext) {
            holdNext = false;
            entered.resolve();
            await release.promise;
          }
          return result;
        }),
    };
    const request = (id: string) => ({
      input: { id },
      receipt: {
        identity: { domain: "logical" as const, key: id },
        intent: { id },
      },
    });
    let allowed = true;
    let caller: { principal: string; epoch: number };
    const owner = createOwnerCommands<{
      write: { input: { id: string }; output: { id: string } };
    }>({
      session,
      schema,
      onPublicationError(error) {
        errors.push(error);
      },
      handlers: {
        write: {
          authorize() {
            if (!allowed) throw new Error("current authorization denied");
          },
          async execute({ id }, context) {
            await context.transaction.query(
              `INSERT INTO ${tables.nodes}(id,namespace,type,name) VALUES($1,'space','fixture',$1)`,
              [id],
            );
            if (id === "first") {
              context.afterCommit(async () => {
                callbackRuns++;
                order.push("callback-start");
                // These separate-session reads must see the original command's
                // committed mutation and receipt before reentrant admission.
                assertEquals(
                  (await db.query(`SELECT id FROM ${tables.nodes} ORDER BY id`))
                    .rows,
                  [{ id: "first" }],
                );
                assertEquals(
                  (await db.query(
                    `SELECT key FROM ${tables.owner_receipts} ORDER BY key`,
                  )).rows,
                  [{ key: "first" }],
                );
                assertEquals(
                  await owner.execute("write", caller, request("nested")),
                  { id: "nested" },
                );
                order.push("nested-committed");
              });
              context.afterCommit(() => {
                order.push("callback-failure");
                throw publicationError;
              });
              context.afterCommit(() => {
                order.push("later-publication");
                published.resolve();
              });
            }
            return { id };
          },
        },
      },
    });
    let pending: Promise<{ id: string }> | undefined;
    try {
      await provisionCopilotzSchema(db, schema);
      caller = { principal: "fixture", epoch: await owner.acquire(0) };
      holdNext = true;
      pending = owner.execute("write", caller, request("first")).then(
        (value) => {
          outputVisible = true;
          return value;
        },
      );
      await bounded(entered.promise, "outer transaction before COMMIT");
      assertEquals(outputVisible, false);
      assertEquals(callbackRuns, 0);
      assertEquals(order, []);
      assertEquals((await db.query(`SELECT id FROM ${tables.nodes}`)).rows, []);
      assertEquals(
        (await db.query(`SELECT key FROM ${tables.owner_receipts}`)).rows,
        [],
      );
      release.resolve();
      assertEquals(await bounded(pending, "first command output"), {
        id: "first",
      });
      await bounded(
        published.promise,
        "reentrant publication and failure observer",
      );
      await until(
        () =>
          errors.length === 1 && order.includes("nested-committed")
            ? true
            : undefined,
        "publication completion",
      );
      assertEquals(callbackRuns, 1);
      assertEquals(order, [
        "callback-start",
        "callback-failure",
        "later-publication",
        "nested-committed",
      ]);
      assertEquals(errors.length, 1);
      assertStrictEquals(errors[0], publicationError);
      assertEquals(
        (await db.query(`SELECT id FROM ${tables.nodes} ORDER BY id`)).rows,
        [{ id: "first" }, { id: "nested" }],
      );
      const receipts = (await db.query(
        `SELECT key,kind,intent,result,readers FROM ${tables.owner_receipts} ORDER BY key`,
      )).rows;
      assertEquals(
        receipts,
        ["first", "nested"].map((id) => ({
          key: id,
          kind: "write",
          intent: { id },
          result: { id },
          readers: ["fixture"],
        })),
      );
      allowed = false;
      await assertRejects(
        () => owner.execute("write", caller, request("first")),
        Error,
        "current authorization denied",
      );
      allowed = true;
      assertEquals(await owner.execute("write", caller, request("first")), {
        id: "first",
      });
      assertEquals(callbackRuns, 1);
      assertEquals(order.length, 4);
      assertEquals(errors.length, 1);
      assertEquals(
        (await db.query(
          `SELECT key,kind,intent,result,readers FROM ${tables.owner_receipts} ORDER BY key`,
        )).rows,
        receipts,
      );
      assertEquals(owner.state, "acquired");
    } finally {
      release.resolve();
      await pending?.catch(() => undefined);
      owner.stop();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});
