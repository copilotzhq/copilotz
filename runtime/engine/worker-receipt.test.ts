import { assertEquals } from "@std/assert";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createOwnerCommands, readSchemaReceipt } from "./commands.ts";

Deno.test("worker receipt lookup binds principal, kind and full intent across mutation epoch replacement without writes", async () => {
  const db = await createOwnerTestDatabase();
  const schema = "worker_receipt";
  try {
    await provisionCopilotzSchema(db, schema);
    const owner = createOwnerCommands<{
      "collections.commit": { input: null; output: null };
      other: { input: null; output: null };
    }>({
      session: db,
      schema,
      handlers: {
        "collections.commit": { authorize() {}, execute: () => null },
        other: { authorize() {}, execute: () => null },
      },
    });
    const epoch = await owner.acquire(0);
    const intent = {
      plan: [{
        path: ["collections", "notes", "create"],
        args: [{ id: "one" }],
      }],
      options: { operationKey: "commit" },
    };
    const request = {
      key: "scope/operation/commit",
      databaseSchema: schema,
      intent,
    };
    await owner.execute("collections.commit", {
      principal: "worker:one",
      epoch,
    }, {
      input: null,
      receipt: { identity: { domain: "logical", key: request.key }, intent },
    });
    await owner.execute("other", { principal: "worker:one", epoch }, {
      input: null,
      receipt: { identity: { domain: "logical", key: "wrong-kind" }, intent },
    });
    owner.stop();
    await db.query(
      `UPDATE "${schema}".owner_epochs SET epoch=epoch+1, holder='replacement'`,
    );
    const queries: string[] = [];
    const readOnly = {
      transaction: db.transaction,
      query<T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) {
        queries.push(sql);
        return db.query<T>(sql, params);
      },
    };
    assertEquals(
      await readSchemaReceipt(readOnly, schema, "worker:one", request),
      true,
    );
    assertEquals(
      await readSchemaReceipt(readOnly, schema, "worker:other", request),
      false,
    );
    assertEquals(
      await readSchemaReceipt(readOnly, schema, "worker:one", {
        ...request,
        databaseSchema: "foreign",
      }),
      false,
    );
    assertEquals(
      await readSchemaReceipt(readOnly, schema, "worker:one", {
        ...request,
        intent: { ...intent, options: { operationKey: "changed" } },
      }),
      false,
    );
    assertEquals(
      await readSchemaReceipt(readOnly, schema, "worker:one", {
        ...request,
        key: "wrong-kind",
      }),
      false,
    );
    assertEquals(
      queries.every((sql) => sql.startsWith("SELECT kind,intent FROM")),
      true,
    );
    assertEquals(
      Number(
        (await db.query(`SELECT epoch FROM "${schema}".owner_epochs`)).rows[0]
          .epoch,
      ),
      epoch + 1,
    );
  } finally {
    await db.close();
  }
});
