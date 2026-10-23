import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "./commands.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import {
  captureOwnerCommandAuthorization,
  type OwnerCommandAuthorization,
  withOwnerCommandAuthorization,
} from "./command-authorization.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "owner Action guards bind cached runners, duplicates, rollback, joined work and publication",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url, pgPoolMax: 4 });
    const schema = `guard_${crypto.randomUUID().replaceAll("-", "")}`;
    await provisionCopilotzSchema(db, schema);
    const owner = await openDatabaseOwner(db, schema);
    const run = createSchemaCommandRunner(db, schema);
    await run("setup", {}, async (_input, { transaction }) => {
      await transaction.query(
        `CREATE TABLE "${schema}".proof (id text PRIMARY KEY, value text)`,
      );
    });
    let allowed = true;
    const checked: string[] = [];
    const guard: OwnerCommandAuthorization = async (
      { transaction },
      purpose,
    ) => {
      checked.push(purpose);
      await transaction.query("SELECT 1");
      if (!allowed) throw new Error("current policy refused");
      // Public mutation admission inside a policy callback is never permitted.
      await assertRejects(
        async () => await run("reentrant", {}, () => {}),
        Error,
        "authorization cannot submit",
      );
    };
    try {
      await withOwnerCommandAuthorization(
        guard,
        () =>
          run("write", {}, async (_input, command) => {
            await command.transaction.query(
              `INSERT INTO "${schema}".proof VALUES ('first','kept')`,
            );
            const nested = createSchemaCommandRunner(
              command.transaction,
              schema,
            );
            await nested("joined", {}, () => {});
            command.afterCommit(() => {
              assertEquals(captureOwnerCommandAuthorization(), undefined);
            });
          }),
      );
      assertEquals(checked[0], "mutation");
      assertEquals(checked.at(-1), "result");
      assertEquals(checked, ["mutation", "result"]);
      const binding = {
        principal: "runtime",
        signal: new AbortController().signal,
        receipt: {
          identity: { domain: "logical" as const, key: "one" },
          intent: { value: "same" },
        },
      };
      const receipt = () =>
        withOwnerCommandAuthorization(
          guard,
          () => run("duplicate", {}, () => "original", binding),
        );
      assertEquals(await receipt(), "original");
      allowed = false;
      await assertRejects(receipt, Error, "current policy refused");
      allowed = true;
      await assertRejects(
        () =>
          withOwnerCommandAuthorization(
            guard,
            () =>
              run("rollback", {}, async (_input, { transaction }) => {
                await transaction.query(
                  `INSERT INTO "${schema}".proof VALUES ('second','rollback')`,
                );
                allowed = false;
              }),
          ),
        Error,
        "current policy refused",
      );
      assertEquals(
        (await db.query(`SELECT id FROM "${schema}".proof ORDER BY id`)).rows,
        [{ id: "first" }],
      );
      allowed = true;
      // A short inner capability call contributes policy until the outer commit.
      checked.length = 0;
      await run("outer", {}, async (_input, command) => {
        const nested = createSchemaCommandRunner(command.transaction, schema);
        await withOwnerCommandAuthorization(
          guard,
          () => nested("inner", {}, () => {}),
        );
      });
      assertEquals(checked, ["mutation", "result"]);
      await assertRejects(
        () =>
          run("outer-refused", {}, async (_input, command) => {
            const nested = createSchemaCommandRunner(
              command.transaction,
              schema,
            );
            await withOwnerCommandAuthorization(guard, () =>
              nested("inner-refused", {}, async () => {
                await command.transaction.query(
                  `INSERT INTO "${schema}".proof VALUES ('nested','rollback')`,
                );
              }));
            allowed = false;
          }),
        Error,
        "current policy refused",
      );
      assertEquals(
        (await db.query(`SELECT id FROM "${schema}".proof ORDER BY id`)).rows,
        [{ id: "first" }],
      );
      allowed = true;
      let detached!: () => Promise<unknown>;
      await withOwnerCommandAuthorization(guard, () => {
        const captured = captureOwnerCommandAuthorization()!;
        detached = () =>
          withOwnerCommandAuthorization(
            captured,
            () => run("late", {}, () => {}),
          );
        return Promise.resolve();
      });
      await assertRejects(detached, Error, "lifetime has ended");
      const first = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const seen: string[] = [];
      const a: OwnerCommandAuthorization = () => {
        seen.push("a");
      };
      const b: OwnerCommandAuthorization = () => {
        seen.push("b");
      };
      const one = withOwnerCommandAuthorization(
        a,
        () =>
          run("a", {}, async () => {
            first.resolve();
            await release.promise;
            return "a";
          }),
      );
      await first.promise;
      const two = withOwnerCommandAuthorization(
        b,
        () => run("b", {}, () => "b"),
      );
      release.resolve();
      assertEquals(await Promise.all([one, two]), ["a", "b"]);
      assertEquals(seen, ["a", "a", "b", "b"]);
    } finally {
      await releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});
