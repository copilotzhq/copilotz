import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotzApplication } from "../application/application.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { wakeOwnerAlarms } from "../testing/owner-alarms.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { createTestDomainContext } from "../../plugins/core/shared/testing/context.ts";
import {
  createScheduledJob,
  scheduledJobDelegationDigest,
  schedulesPlugin,
} from "../../plugins/schedules/index.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../plugins/index.ts";
import { defineAction } from "./define.ts";
import type { RuntimeActionCallers } from "./types.ts";
import { secret } from "./secret.ts";
import type { ProtectedActionSource } from "./protected-action-types.ts";
import { resolveOwnerIngress } from "../application/ingress/authority.ts";
import { withScheduledAlarmAdmission } from "../application/ingress/scheduled.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "actual schedule alarm authorizes protected use while forged due, changed delegation and stale deadline fail closed",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url, pgPoolMax: 1 });
    const schema = `schedule_proof_${crypto.randomUUID().replaceAll("-", "")}`;
    const namespace = "space";
    let now = new Date("2026-01-01T00:00:00Z");
    let uses = 0;
    let denied = 0;
    const sources: ProtectedActionSource[] = [];
    const consume = defineAction({
      id: "fixture.scheduled-credential",
      ownerHooks: { prepareInput: true },
      inputSchema: {
        type: "object",
        properties: { credential: secret({ type: "string" }) },
        additionalProperties: false,
      } as const,
      execute(input: { credential?: string }) {
        assertEquals(input.credential, "owner-only-credential");
        uses++;
        return true;
      },
    });
    const app = await createCopilotzApplication({
      database: db,
      databaseSchema: schema,
      namespace,
      engine: { now: () => now },
      adapters: { secrets: { default: await testSecretAdapter() } },
      plugins: [
        schedulesPlugin,
        definePlugin({
          id: "fixture.schedule-proof",
          version: "1.0.0",
          actions: { consume },
          processors: {
            due: defineProcessor<ProcessorContext>({
              id: "fixture.consume-due",
              on: [{ eventType: "scheduled_job.due" }],
              async handle(_event, ctx) {
                try {
                  await (ctx.actions as RuntimeActionCallers).consume({});
                } catch {
                  denied++;
                }
              },
            }),
          },
        }),
      ],
      protectedActions: {
        [consume.id]: {
          async authorize(_input, ctx) {
            const source = await ctx.resolveSource();
            sources.push(source);
            if (
              source.ingress?.kind !== "scheduled-occurrence"
            ) throw new Error("unproven occurrence");
            const { scheduleId, scheduleVersion } = source.ingress;
            const rows = await ctx.query<{ data: Record<string, unknown> }>(
              `SELECT data FROM "${schema}".nodes WHERE namespace=$1 AND id=$2 AND type='scheduled_job'`,
              [namespace, scheduleId],
            );
            const delegation = await ctx.query<
              { data: { version: string; active: boolean } }
            >(
              `SELECT data FROM "${schema}".nodes WHERE namespace=$1 AND id=$2 AND type='fixture_delegation'`,
              [namespace, `delegation:${scheduleId}`],
            );
            if (
              !rows.rows[0] || !delegation.rows[0]?.data.active ||
              delegation.rows[0].data.version !== scheduleVersion
            ) throw new Error("delegation denied");
            const current = { ...rows.rows[0].data, id: scheduleId, namespace };
            if (
              await scheduledJobDelegationDigest({
                databaseSchema: schema,
                namespace,
                record: current,
              }) !== scheduleVersion
            ) throw new Error("delegation changed");
          },
          prepareInput() {
            return { credential: "owner-only-credential" };
          },
        },
      },
    });
    const context = createTestDomainContext(app, namespace, { now: () => now });
    const run = createSchemaCommandRunner(db, schema);
    const create = async (id: string) => {
      const job = await createScheduledJob({
        id,
        name: id,
        schedule: { type: "cron", expression: "* * * * *" },
        payload: { threadId: "thread", spaceId: "space-a" },
        metadata: { creator: "member" },
        content: [],
      }, context);
      const version = await scheduledJobDelegationDigest({
        databaseSchema: schema,
        namespace,
        record: job,
      });
      await run("fixture.delegation", {}, async (_, ctx) => {
        await ctx.transaction.query(
          `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES($1,$2,'fixture_delegation',$1,$3::jsonb)`,
          [
            `delegation:${id}`,
            namespace,
            JSON.stringify({ version, active: true }),
          ],
        );
      });
      return job;
    };
    try {
      await run("fixture.space", {}, async (_, ctx) => {
        await ctx.transaction.query(
          `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('space-b',$1,'space','space-b','{}')`,
          [namespace],
        );
      });
      await create("real");
      now = new Date("2026-01-01T00:01:00Z");
      await wakeOwnerAlarms(db.session, app.engine, [namespace]);
      assertEquals(uses, 1);
      assertEquals(denied, 0);
      assertEquals(sources[0].ingress?.kind, "scheduled-occurrence");
      await run("fixture.revoke", {}, async (_, ctx) => {
        await ctx.transaction.query(
          `UPDATE "${schema}".nodes SET data=jsonb_set(data,'{active}','false') WHERE id='delegation:real'`,
        );
      });
      now = new Date("2026-01-01T00:02:00Z");
      await wakeOwnerAlarms(db.session, app.engine, [namespace]);
      assertEquals(uses, 1);
      for (let i = 0; i < 500 && denied < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assertEquals(denied, 1);
      await app.collections.get("scheduled_job")!.update({ namespace }, {
        id: "real",
        set: { status: "paused" },
      });
      const forged = await create("forged");
      const due = String(forged.nextRunAt);
      await app.collections.get("scheduled_job")!.commands.due({ namespace }, {
        id: "forged",
        occurrenceId: `forged:${Date.parse(due)}`,
        mode: "scheduled",
        scheduledFor: due,
        checkedAt: due,
      }, {
        operationKey: "forged-direct",
        identity: { metadata: { sourceOwnerAlarm: true, hostIngress: true } },
      });
      for (let i = 0; i < 500 && denied < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assertEquals(uses, 1);
      assertEquals(denied, 2);
      assertEquals(sources.at(-1)!.ingress, undefined);
      await app.collections.get("scheduled_job")!.update({ namespace }, {
        id: "forged",
        set: { status: "paused" },
      });
      const stale = await create("stale");
      const deadline = (await db.query<
        {
          source: string;
          key: string;
          namespace: string;
          due_at: Date;
          payload: unknown;
          revision: string;
        }
      >(`SELECT * FROM "${schema}".owner_deadlines WHERE key=$1`, [
        JSON.stringify([namespace, "stale"]),
      ])).rows[0];
      const call = withScheduledAlarmAdmission({
        operationKey: "stale-proof",
        identity: { deduplicationId: "stale-proof" },
      }, {
        databaseSchema: schema,
        namespace,
        scheduleId: "stale",
        occurrenceId: `stale:${Date.parse(String(stale.nextRunAt))}`,
        scheduledFor: String(stale.nextRunAt),
        scheduleVersion: await scheduledJobDelegationDigest({
          databaseSchema: schema,
          namespace,
          record: stale,
        }),
        deadline: {
          source: deadline.source,
          key: deadline.key,
          namespace,
          payload: deadline.payload,
          revision: String(deadline.revision),
          dueAt: new Date(deadline.due_at).toISOString(),
        },
      });
      await app.collections.get("scheduled_job")!.update({ namespace }, {
        id: "stale",
        set: { name: "renamed" },
      });
      now = new Date(String(stale.nextRunAt));
      await assertRejects(() =>
        app.collections.get("scheduled_job")!.commands.due({ namespace }, {
          id: "stale",
          occurrenceId: `stale:${Date.parse(String(stale.nextRunAt))}`,
          mode: "scheduled",
          scheduledFor: String(stale.nextRunAt),
          checkedAt: String(stale.nextRunAt),
        }, call)
      );
      await app.collections.get("scheduled_job")!.update({ namespace }, {
        id: "stale",
        set: { metadata: { creator: "replacement" } },
      });
      await wakeOwnerAlarms(db.session, app.engine, [namespace]);
      assertEquals(uses, 1);
      for (let i = 0; i < 500 && denied < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assertEquals(denied, 3);
      assertEquals(sources.at(-1)!.ingress?.kind, "scheduled-occurrence");
      assertEquals(
        (sources.at(-1)!.ingress as { scheduleId: string }).scheduleId,
        "stale",
      );
      await app.collections.get("scheduled_job")!.update({ namespace }, {
        id: "stale",
        set: { status: "paused" },
      });
      for (
        const [id, set] of [
          ["changed-payload", {
            payload: { threadId: "other-thread", spaceId: "space-a" },
          }],
          ["changed-space", { spaceId: "space-b" }],
        ] as const
      ) {
        const job = await create(id);
        await app.collections.get("scheduled_job")!.update({ namespace }, {
          id,
          set,
        });
        const previous = denied;
        now = new Date(String(job.nextRunAt));
        await wakeOwnerAlarms(db.session, app.engine, [namespace]);
        for (let i = 0; i < 500 && denied === previous; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assertEquals(uses, 1);
        assertEquals(denied, previous + 1);
        assertEquals(
          (sources.at(-1)!.ingress as { scheduleId: string }).scheduleId,
          id,
        );
        await app.collections.get("scheduled_job")!.update({ namespace }, {
          id,
          set: { status: "paused" },
        });
      }
      const tables = createCoreTableNames(schema);
      const events = (await db.query<
        {
          id: string;
          type: string;
          namespace: string;
          metadata: Record<string, unknown>;
          payload: unknown;
        }
      >(`SELECT id,type,namespace,metadata,payload FROM ${tables.events} WHERE type='scheduled_job.due'`))
        .rows;
      for (const event of events) {
        const body = await readEventBody(
          { transaction: db, tables },
          namespace,
          eventDataRef(event.payload),
        );
        const ingress = await resolveOwnerIngress(
          { transaction: db, tables },
          schema,
          event,
          body,
        );
        if (
          (body as { record: { id: string } }).record.id === "forged"
        ) assertEquals(ingress, undefined);
      }
      const receipts = await db.query(
        `SELECT intent,result FROM ${tables.owner_receipts}`,
      );
      assert(!JSON.stringify(receipts.rows).includes("owner-only-credential"));
    } finally {
      await app.close();
      await db.close();
    }
  },
});
