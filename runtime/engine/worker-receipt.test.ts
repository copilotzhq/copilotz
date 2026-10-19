import { assertEquals, assertRejects } from "@std/assert";
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

Deno.test("replacement receipt readership requires exact current authorized replay and rolls back with the outer transaction", async () => {
  const db = await createOwnerTestDatabase();
  const schema = "receipt_replacement";
  let failCommit = false, allowed = true, disclose = true, writes = 0;
  const session = {
    query: db.query,
    transaction<T>(
      run: (tx: import("../events/session.ts").SqlExecutor) => T | Promise<T>,
    ) {
      return db.transaction(async (tx) => {
        const result = await run(tx);
        if (failCommit) throw new Error("definitive outer rollback");
        return result;
      });
    },
  };
  const handlers = {
    "collections.commit": {
      authorize() {
        if (!allowed) throw new Error("current authorization denied");
      },
      authorizeResult() {
        if (!disclose) throw new Error("current disclosure denied");
      },
      execute() {
        writes++;
        return null;
      },
    },
  };
  const intent = { operation: "same" };
  const request = {
    key: "stable-operation/step",
    databaseSchema: schema,
    intent,
  };
  const command = {
    input: null,
    receipt: {
      identity: { domain: "logical" as const, key: request.key },
      intent,
    },
  };
  let owner: ReturnType<typeof createOwnerCommands> | undefined;
  try {
    await provisionCopilotzSchema(db, schema);
    owner = createOwnerCommands({ session, schema, handlers });
    const epoch = await owner.acquire(0);
    const caller = { epoch, principal: "invocation:original-authority" };
    await owner.execute("collections.commit", {
      ...caller,
      receiptReader: "worker:original",
    }, command);
    const recover = (reader: string) =>
      readSchemaReceipt(db, schema, `worker:${reader}`, request);
    assertEquals(await recover("original"), true);
    assertEquals(await recover("replacement"), false);
    await assertRejects(
      () =>
        owner!.execute("collections.commit", {
          ...caller,
          principal: "invocation:unrelated",
          receiptReader: "worker:replacement",
        }, command),
      Error,
      "another principal",
    );
    await assertRejects(
      () =>
        owner!.execute("collections.commit", {
          ...caller,
          receiptReader: "worker:replacement",
        }, {
          ...command,
          receipt: { ...command.receipt, intent: { operation: "changed" } },
        }),
      Error,
      "another principal",
    );
    allowed = false;
    await assertRejects(
      () =>
        owner!.execute("collections.commit", {
          ...caller,
          receiptReader: "worker:replacement",
        }, command),
      Error,
      "current authorization denied",
    );
    allowed = true;
    disclose = false;
    await assertRejects(
      () =>
        owner!.execute("collections.commit", {
          ...caller,
          receiptReader: "worker:replacement",
        }, command),
      Error,
      "current disclosure denied",
    );
    disclose = true;
    assertEquals(await recover("replacement"), false);
    failCommit = true;
    const failed = await assertRejects(() =>
      owner!.execute("collections.commit", {
        ...caller,
        receiptReader: "worker:replacement",
      }, command)
    );
    assertEquals(
      (failed as Error & { code: string }).code,
      "owner_commit_unknown",
    );
    assertEquals(await recover("replacement"), false);
    assertEquals(
      (await db.query(`SELECT readers FROM "${schema}".owner_receipts`)).rows,
      [{ readers: ["worker:original"] }],
    );
    failCommit = false;
    owner = createOwnerCommands({ session, schema, handlers });
    const nextEpoch = await owner.acquire(epoch);
    await owner.execute("collections.commit", {
      ...caller,
      epoch: nextEpoch,
      receiptReader: "worker:replacement",
    }, command);
    await owner.execute("collections.commit", {
      ...caller,
      epoch: nextEpoch,
      receiptReader: "worker:replacement",
    }, command);
    assertEquals(await recover("replacement"), true);
    assertEquals(await recover("unrelated"), false);
    assertEquals(writes, 1);
    assertEquals(
      (await db.query(`SELECT readers FROM "${schema}".owner_receipts`)).rows,
      [{ readers: ["worker:original", "worker:replacement"] }],
    );
    assertEquals(
      await owner.readReceipt({
        ...caller,
        epoch: nextEpoch,
        principal: "host:other",
      }, command.receipt.identity),
      undefined,
    );
  } finally {
    owner?.stop();
    await db.close();
  }
});
