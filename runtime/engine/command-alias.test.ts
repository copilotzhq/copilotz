import { assertEquals, assertThrows } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  bindCommandExecutorAlias,
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
  schemaCommandContext,
} from "./commands.ts";

Deno.test("owner command context resolves only live schema-bound query aliases", async () => {
  const db = await createTestDatabase();
  const schema = `alias_${crypto.randomUUID().replaceAll("-", "")}`;
  let retained: SqlExecutor | undefined;
  let close = () => {};
  let owner: Awaited<ReturnType<typeof openDatabaseOwner>> | undefined;
  try {
    await provisionCopilotzSchema(db, schema);
    owner = await openDatabaseOwner(db, schema);
    const run = createSchemaCommandRunner(db, schema);
    await run("alias.proof", {}, async (_input, command) => {
      let active = true;
      close = () => {
        active = false;
      };
      const alias = {
        query: command.transaction.query.bind(command.transaction),
      };
      retained = alias;
      bindCommandExecutorAlias(alias, command.transaction, () => {
        if (!active) throw new Error("Alias scope closed.");
      });
      assertEquals(schemaCommandContext(alias, schema), command);
      assertEquals(
        schemaCommandContext(alias, schema).commandTime,
        command.commandTime,
      );
      assertThrows(
        () => schemaCommandContext(alias, `${schema}_other`),
        Error,
        "current transaction from this database owner",
      );
      assertThrows(
        () => schemaCommandContext({ query: alias.query }, schema),
        Error,
        "current transaction from this database owner",
      );
      assertEquals((await alias.query("SELECT 1 AS value")).rows, [{
        value: 1,
      }]);
    });
    assertThrows(
      () => schemaCommandContext(retained!, schema),
      Error,
      "active SQL transaction",
    );
    close();
    assertThrows(
      () => schemaCommandContext(retained!, schema),
      Error,
      "Alias scope closed",
    );
  } finally {
    if (owner) await releaseDatabaseOwner(owner);
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});
