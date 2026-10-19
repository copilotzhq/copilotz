import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  type CommandContext,
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "./commands.ts";
import {
  type OwnerCommandAuthorization,
  withOwnerCommandAuthorization,
} from "./command-authorization.ts";
import { withOwnerQueryContext } from "./owner-query-context.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
type PolicyState = { required: number; actual: number };
type Fixture = {
  db: TestDatabase;
  schema: string;
  run: ReturnType<typeof createSchemaCommandRunner>;
  guard: OwnerCommandAuthorization;
  checked: Array<PolicyState & { purpose: "mutation" | "result" }>;
  state(executor?: SqlExecutor): Promise<PolicyState>;
};

async function withFixture(
  test: (fixture: Fixture) => Promise<void>,
  required = 0,
) {
  const db = await createTestDatabase({ url, pgPoolMax: 4 });
  const schema = `alias_guard_${crypto.randomUUID().replaceAll("-", "")}`;
  let owner: Awaited<ReturnType<typeof openDatabaseOwner>> | undefined;
  try {
    await provisionCopilotzSchema(db, schema);
    owner = await openDatabaseOwner(db, schema);
    const run = createSchemaCommandRunner(db, schema);
    await run("alias.setup", {}, async (_input, { transaction }) => {
      await transaction.query(
        `CREATE TABLE "${schema}".policy_state (required integer NOT NULL)`,
      );
      await transaction.query(
        `INSERT INTO "${schema}".policy_state VALUES ($1)`,
        [required],
      );
      await transaction.query(
        `CREATE TABLE "${schema}".peer_writes (id text PRIMARY KEY)`,
      );
    });
    const state = async (executor: SqlExecutor = db) =>
      (await executor.query<PolicyState>(
        `SELECT required, (SELECT count(*)::integer FROM "${schema}".peer_writes) AS actual FROM "${schema}".policy_state`,
      )).rows[0];
    const checked: Fixture["checked"] = [];
    const guard: OwnerCommandAuthorization = async (command, purpose) => {
      const current = await state(command.transaction);
      checked.push({ purpose, ...current });
      if (current.actual < current.required) {
        throw new Error(`Policy refused at ${purpose}.`);
      }
    };
    await test({ db, schema, run, guard, checked, state });
  } finally {
    if (owner) releaseDatabaseOwner(owner);
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}

function withAlias<T>(
  command: CommandContext,
  schema: string,
  run: (
    nested: ReturnType<typeof createSchemaCommandRunner>,
    alias: SqlExecutor,
  ) => T | Promise<T>,
) {
  return withOwnerQueryContext(
    (alias) => run(createSchemaCommandRunner(alias, schema), alias),
    command,
    command.signal,
    () => ({}),
  );
}

Deno.test({
  name:
    "joined alias does not repeat ambient admission between hidden and staged peer writes",
  ignore: !url,
  fn: () =>
    withFixture(async ({ schema, run, guard, checked, state }) => {
      let peerWritten = false;
      await withOwnerCommandAuthorization(guard, () =>
        run("alias.atomic-write", {}, async (_input, command) => {
          await command.transaction.query(
            `UPDATE "${schema}".policy_state SET required=1`,
          );
          await withAlias(command, schema, (nested) =>
            nested("alias.peer", {}, async (_input, { transaction }) => {
              await transaction.query(
                `INSERT INTO "${schema}".peer_writes VALUES ('peer')`,
              );
              peerWritten = true;
            }));
        }));
      assertEquals(peerWritten, true);
      assertEquals(checked, [
        { purpose: "mutation", required: 0, actual: 0 },
        { purpose: "result", required: 1, actual: 1 },
      ]);
      assertEquals(await state(), { required: 1, actual: 1 });
    }),
});

Deno.test({
  name:
    "joined alias contributes its guard to an unguarded outer result and rolls back every write",
  ignore: !url,
  fn: () =>
    withFixture(async ({ schema, run, guard, checked, state }) => {
      let aliasFinished = false;
      let published = false;
      await assertRejects(
        () =>
          run("alias.unguarded-outer", {}, async (_input, command) => {
            await command.transaction.query(
              `INSERT INTO "${schema}".peer_writes VALUES ('outer')`,
            );
            await withAlias(command, schema, (nested) =>
              withOwnerCommandAuthorization(guard, () =>
                nested("alias.guarded-inner", {}, async (_input, context) => {
                  await context.transaction.query(
                    `INSERT INTO "${schema}".peer_writes VALUES ('inner')`,
                  );
                  context.afterCommit(() => {
                    published = true;
                  });
                })));
            aliasFinished = true;
            // The alias and its authorization call have both closed. Its policy
            // must still participate when the outer command finishes.
            await command.transaction.query(
              `UPDATE "${schema}".policy_state SET required=3`,
            );
          }),
        Error,
        "Policy refused at result.",
      );
      assertEquals(aliasFinished, true);
      assertEquals(checked, [
        { purpose: "mutation", required: 0, actual: 1 },
        { purpose: "result", required: 3, actual: 2 },
      ]);
      assertEquals(await state(), { required: 0, actual: 0 });
      assertEquals(published, false);
    }),
});

Deno.test({
  name: "joined alias refuses an initially unauthorized call before mutation",
  ignore: !url,
  fn: () =>
    withFixture(async ({ schema, run, guard, checked, state }) => {
      let executed = false;
      await assertRejects(
        () =>
          run("alias.initially-refused", {}, (_input, command) =>
            withAlias(command, schema, (nested) =>
              withOwnerCommandAuthorization(guard, () =>
                nested("alias.forbidden-write", {}, async (_input, context) => {
                  executed = true;
                  await context.transaction.query(
                    `INSERT INTO "${schema}".peer_writes VALUES ('forbidden')`,
                  );
                })))),
        Error,
        "Policy refused at mutation.",
      );
      assertEquals(executed, false);
      assertEquals(checked, [
        { purpose: "mutation", required: 1, actual: 0 },
      ]);
      assertEquals(await state(), { required: 1, actual: 0 });
    }, 1),
});

Deno.test({
  name:
    "joined alias final combined-state denial rolls back hidden and peer writes",
  ignore: !url,
  fn: () =>
    withFixture(async ({ schema, run, guard, checked, state }) => {
      let peerWritten = false;
      let published = false;
      await assertRejects(
        () =>
          withOwnerCommandAuthorization(guard, () =>
            run("alias.finally-refused", {}, async (_input, command) => {
              await command.transaction.query(
                `UPDATE "${schema}".policy_state SET required=2`,
              );
              await withAlias(command, schema, (nested) =>
                nested(
                  "alias.insufficient-peer",
                  {},
                  async (_input, context) => {
                    await context.transaction.query(
                      `INSERT INTO "${schema}".peer_writes VALUES ('peer')`,
                    );
                    peerWritten = true;
                    context.afterCommit(() => {
                      published = true;
                    });
                  },
                ));
            })),
        Error,
        "Policy refused at result.",
      );
      assertEquals(peerWritten, true);
      assertEquals(checked, [
        { purpose: "mutation", required: 0, actual: 0 },
        { purpose: "result", required: 2, actual: 1 },
      ]);
      assertEquals(await state(), { required: 0, actual: 0 });
      assertEquals(published, false);
    }),
});

Deno.test({
  name:
    "joined alias runner, query and afterCommit revoke before the outer command ends",
  ignore: !url,
  fn: () =>
    withFixture(async ({ schema, run, state }) => {
      let retainedRun!: ReturnType<typeof createSchemaCommandRunner>;
      let retainedContext!: CommandContext;
      let published = false;
      const assertClosed = async () => {
        await assertRejects(
          async () =>
            await retainedRun("alias.late", {}, () => {
              throw new Error("Closed alias executed.");
            }),
          Error,
          "Owner query handle is closed.",
        );
        await assertRejects(
          () =>
            retainedContext.transaction.query(
              `INSERT INTO "${schema}".peer_writes VALUES ('late')`,
            ),
          Error,
          "Owner query handle is closed.",
        );
        assertThrows(
          () =>
            retainedContext.afterCommit(() => {
              published = true;
            }),
          Error,
          "Owner query handle is closed.",
        );
      };
      await run("alias.lifetime", {}, async (_input, command) => {
        await withAlias(command, schema, async (nested, alias) => {
          retainedRun = nested;
          await nested("alias.capture", {}, async (_input, context) => {
            retainedContext = context;
            assertStrictEquals(context.transaction, alias);
            await context.transaction.query("SELECT 1");
          });
          const wrongSchema = createSchemaCommandRunner(
            alias,
            `${schema}_other`,
          );
          assertThrows(
            () => wrongSchema("alias.wrong-schema", {}, () => {}),
            Error,
            "current transaction from this database owner",
          );
        });
        await assertClosed();
        await command.transaction.query("SELECT 1");
      });
      await assertClosed();
      assertEquals(await state(), { required: 0, actual: 0 });
      assertEquals(published, false);
    }),
});
