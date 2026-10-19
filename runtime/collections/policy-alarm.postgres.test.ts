import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ActionError } from "../actions/errors.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import {
  completeOwnerDeadline,
  type OwnerDeadline,
  writeOwnerDeadline,
} from "../engine/alarms.ts";
import { isOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
import { captureCollectionPolicy } from "./policy-authorization.ts";
import { captureCollectionInvocation } from "./policy-invocation.ts";
import {
  isCollectionAlarmPolicyStale,
  withCollectionAlarmPolicy,
} from "./policy-alarm.ts";
import { defineCollection } from "./definition.ts";
import type { CollectionPolicyContext } from "./policy-types.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "Collection alarm policy preserves infrastructure failures and exact owner deadline authority",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url, pgPoolMax: 4 });
    const schema = `policy_alarm_${crypto.randomUUID().replaceAll("-", "")}`;
    await provisionCopilotzSchema(db, schema);
    const owner = await openDatabaseOwner(db, schema);
    const run = createSchemaCommandRunner(db, schema);
    const definition = defineCollection({
      name: "policyAlarm",
      ownerPolicy: "required",
      schema: {
        type: "object",
        properties: { id: { type: "string" } },
      } as const,
      alarm: {
        deadline: () => "2026-01-01T00:00:00.000Z",
        command: () => ({ name: "due", key: "fixture", input: {} }),
      },
    });
    const selected = {
      source: "collection:policyAlarm",
      key: JSON.stringify(["space", "one"]),
      namespace: "space",
      dueAt: "2026-01-01T00:00:00.000Z",
      payload: { id: "one" },
    };
    const schedule = () =>
      run("schedule", {}, async (_input, command) => {
        await writeOwnerDeadline(command.transaction, schema, selected);
        const row = (await command.transaction.query<{ revision: string }>(
          `SELECT revision::text FROM "${schema}".owner_deadlines WHERE source=$1 AND key=$2`,
          [selected.source, selected.key],
        )).rows[0];
        return { ...selected, revision: row.revision } satisfies OwnerDeadline;
      });
    let deadline = await schedule();
    let retained: ReturnType<typeof captureCollectionInvocation>;
    const check = (
      authorize: (context: CollectionPolicyContext) => void | Promise<void>,
      id = "one",
      selectedDeadline = deadline,
    ) =>
      withCollectionAlarmPolicy({
        definition,
        deadline: selectedDeadline,
        databaseSchema: schema,
        signal: new AbortController().signal,
        method: "get",
        args: { id: "one" },
      }, () => {
        retained = captureCollectionInvocation();
        const policy = captureCollectionPolicy({
          registration: {
            alias: "entry",
            name: definition.name,
            policy: { authorize: (_intent, context) => authorize(context) },
          },
          databaseSchema: schema,
          namespace: "space",
          method: "get",
          args: { id },
        });
        return run("policy", {}, async (_input, command) => {
          await policy.authorize(command, "read");
          command.afterCommit(() =>
            assertEquals(captureCollectionInvocation(), undefined)
          );
        });
      });
    const denied = () => {
      throw new ActionError("private denial", {
        code: "forbidden",
        status: 403,
      });
    };
    const count = async () =>
      (await db.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM "${schema}".owner_deadlines WHERE source=$1`,
        [selected.source],
      )).rows[0].count;
    try {
      await check(async (context) => {
        assertEquals(context.invocation.kind, "alarm");
        await context.query("SELECT 1");
        await assertRejects(
          async () => await run("recursive", {}, () => {}),
          Error,
          "authorization cannot submit",
        );
      });
      const ended = retained!;
      assertThrows(() => ended.check(), Error, "ended");
      for (
        const query of [
          "SELECT 1 / 0",
          `SELECT * FROM "${schema}".missing_private_table`,
        ]
      ) {
        const failure = await assertRejects(
          () =>
            check(async (context) => {
              try {
                await context.query(query);
              } catch {
                denied();
              }
            }),
          Error,
          "authorization could not be completed",
        );
        assertEquals(isOwnerAuthorizationRefusal(failure), false);
        assertEquals(await count(), 1);
        // A failed transaction has not stopped the real schema owner.
        await run("still-operational", {}, async (_input, command) => {
          await command.transaction.query("SELECT 1");
        });
      }
      const sourceFailure = await assertRejects(
        () =>
          check(async (context) => {
            try {
              await context.resolveSource();
            } catch {
              denied();
            }
          }),
        Error,
        "authorization could not be completed",
      );
      assertEquals(isOwnerAuthorizationRefusal(sourceFailure), false);
      const unknown = await assertRejects(() =>
        check(() => {
          throw new Error("private internal failure");
        })
      );
      assertEquals(isOwnerAuthorizationRefusal(unknown), false);
      const forged = await assertRejects(() => check(() => {}, "other"));
      assert(isOwnerAuthorizationRefusal(forged));
      const old = deadline;
      deadline = await schedule();
      const stale = await assertRejects(() => check(() => {}, "one", old));
      assert(isCollectionAlarmPolicyStale(stale));
      await run(
        "complete-stale",
        {},
        (_input, command) =>
          completeOwnerDeadline(command.transaction, schema, old),
      );
      assertEquals(await count(), 1);
      const refusal = await assertRejects(
        () => check(denied),
        ActionError,
        "Forbidden",
      );
      assertEquals((refusal as ActionError).status, 403);
      assert(isOwnerAuthorizationRefusal(refusal));
      // Mirrors the scheduler's permitted exact selected-revision cleanup.
      await run(
        "complete-refused",
        {},
        (_input, command) =>
          completeOwnerDeadline(command.transaction, schema, deadline),
      );
      assertEquals(await count(), 0);
      await run("still-operational", {}, async (_input, command) => {
        await command.transaction.query("SELECT 1");
      });
    } finally {
      releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});
