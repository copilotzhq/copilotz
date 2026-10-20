import { testAuthority } from "../testing/authority.ts";
import { credentialValidity } from "../authorization/authority.ts";
import { defineCollection } from "../collections/definition.ts";
import type { DeliveryDiagnostic } from "../execution/types.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotzApplication } from "../application/application.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { wakeOwnerAlarms } from "../testing/owner-alarms.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { completeOwnerDeadline, type OwnerDeadline } from "../engine/alarms.ts";
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
import { withOwnerCollectionInvocation } from "../authorization/invocation.ts";
import {
  isCollectionAlarmPolicyStale,
  withCollectionAlarmPolicy,
} from "../collections/alarm-authority.ts";
import { defineAction } from "./define.ts";
import { ActionError } from "./errors.ts";
import type { RuntimeActionCallers } from "./types.ts";
import { secret } from "./secret.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "policy-enabled actual schedule occurrence reaches protected credential; revoked, stale, changed and cancelled jobs cannot mint authority",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url: url!, pgPoolMax: 1 });
    const schema = `schedule_policy_${crypto.randomUUID().replaceAll("-", "")}`;
    const namespace = "space";
    let now = new Date("2026-01-01T00:00:00Z");
    const diagnostics: DeliveryDiagnostic[] = [];
    let uses = 0;
    let refused = 0;
    let queryFailure = false;
    const consume = defineAction({
      id: "fixture.policy-schedule-use",
      inputSchema: {
        type: "object",
        properties: { credential: secret({ type: "string" }) },
      } as const,
      execute() {
        uses++;
        return true;
      },
    });
    const deny = () => {
      refused++;
      throw new ActionError("Forbidden", { code: "forbidden", status: 403 });
    };
    const app = await createCopilotzApplication({
      database: db,
      databaseSchema: schema,
      namespace,
      collections: {
        delegation: defineCollection({
          name: "fixture_delegation",
          schema: { type: "object" },
        }),
      },
      engine: {
        now: () => now,
        execution: {
          onDiagnostic(diagnostic) {
            diagnostics.push(diagnostic);
          },
        },
        alarmScheduler: {
          schedule() {
            return undefined;
          },
          cancel() {},
        },
      },
      adapters: { secrets: { default: await testSecretAdapter() } },
      plugins: [
        schedulesPlugin,
        definePlugin({
          id: "fixture.schedule-policy",
          version: "1.0.0",
          actions: { consume },
          processors: {
            due: defineProcessor<ProcessorContext>({
              id: "fixture.policy-due",
              on: [{ eventType: "scheduled_job.due" }],
              async handle(_event, ctx) {
                await (ctx.actions as RuntimeActionCallers).consume({});
              },
            }),
          },
        }),
      ],
      authorization: {
        systemScopes: { [namespace]: testAuthority(schema, namespace).scope },
        policies: {
          fixture: {
            revision: "1",
            sources: ["scheduledJob", "delegation"],
            async evaluate({ authority, intent, read }) {
              const constraints = {
                collections: { scheduledJob: {} },
                collectionMutations: {
                  scheduledJob: {
                    create: {},
                    update: {},
                    delete: {},
                    commands: { due: {} },
                  },
                },
                actions: {
                  consume: {
                    input: { credential: "synthetic-scheduled-credential" },
                  },
                },
              };
              if (
                authority.principal.id === "fixture.setup"
              ) return constraints;
              if (authority.provenance.ingress !== "alarm") return deny();
              if (queryFailure) {
                try {
                  await read.get("undeclared", "none");
                } catch {
                  return deny();
                }
              }
              const id = authority.requestFacts.params.id;
              const record = await read.get("scheduledJob", id);
              const delegation = await read.get(
                "delegation",
                `delegation:${id}`,
              );
              if (
                !record || record.status !== "active" || !delegation?.active ||
                delegation.version !==
                  await scheduledJobDelegationDigest({
                    databaseSchema: schema,
                    namespace,
                    record,
                  })
              ) return deny();
              if (
                intent.kind === "action" &&
                delegation.version !==
                  (authority.requestFacts.input as { scheduleVersion: string })
                    .scheduleVersion
              ) return deny();
              return constraints;
            },
          },
        },
        collections: { scheduledJob: { id: "fixture", revision: "1" } },
        actions: { consume: { id: "fixture", revision: "1" } },
      },
    });
    const run = createSchemaCommandRunner(db, schema);
    const context = createTestDomainContext(app, namespace, { now: () => now });
    const jobs = app.collections.get("scheduled_job")!;
    const selected = async (id: string) => {
      const row = (await db.query<
        {
          source: string;
          key: string;
          namespace: string;
          due_at: Date;
          revision: string;
          payload: unknown;
        }
      >(
        `SELECT * FROM "${schema}".owner_deadlines WHERE source='collection:scheduled_job' AND key=$1`,
        [JSON.stringify([namespace, id])],
      )).rows[0];
      return row &&
        {
          source: row.source,
          key: row.key,
          namespace: row.namespace,
          dueAt: new Date(row.due_at).toISOString(),
          revision: String(row.revision),
          payload: row.payload,
        } satisfies OwnerDeadline;
    };
    try {
      await withOwnerCollectionInvocation({
        authority: {
          ...testAuthority(schema, namespace, "fixture.setup"),
          validity: credentialValidity(new Date("2026-01-01T00:00:00Z")),
        },
        scope: { databaseSchema: schema, namespace },
        signal: new AbortController().signal,
        invocation: { kind: "action", id: "fixture.setup", runId: "setup" },
        check() {},
        resolveSource() {
          return Promise.reject(new Error("fixture setup"));
        },
      }, async () => {
        const create = async (id: string) => {
          const job = await createScheduledJob({
            id,
            name: id,
            schedule: { type: "cron", expression: "* * * * *" },
            payload: { threadId: "thread" },
            metadata: { creator: "member" },
            content: [],
          }, context);
          const version = await scheduledJobDelegationDigest({
            databaseSchema: schema,
            namespace,
            record: job,
          });
          await run("fixture.delegate", {}, (_, ctx) =>
            ctx.transaction.query(
              `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES($1,$2,'fixture_delegation',$1,$3::jsonb)`,
              [
                `delegation:${id}`,
                namespace,
                JSON.stringify({ active: true, version }),
              ],
            ));
          return job;
        };
        await create("allowed");
        now = new Date("2026-01-01T00:01:00Z");
        await wakeOwnerAlarms(db.session, app.engine, [namespace]);
        assertEquals(uses, 1);
        await run("fixture.revoke", {}, (_, ctx) =>
          ctx.transaction.query(
            `UPDATE "${schema}".nodes SET data=jsonb_set(data,'{active}','false') WHERE id='delegation:allowed'`,
          ));
        await create("unrelated");
        now = new Date("2026-01-01T00:02:00Z");
        await wakeOwnerAlarms(db.session, app.engine, [namespace]);
        assertEquals(uses, 2);
        assert(refused > 0);
        assertEquals(await selected("allowed"), undefined);
        await jobs.update({ namespace }, {
          id: "unrelated",
          set: { status: "paused" },
        });
        const stale = await create("stale");
        const before = (await selected("stale"))!;
        await jobs.update({ namespace }, {
          id: "stale",
          set: { name: "renamed" },
        });
        const after = (await selected("stale"))!;
        assert(before.revision !== after.revision);
        const error = await assertRejects(() =>
          withCollectionAlarmPolicy({
            authority: {
              ...testAuthority(schema, namespace),
              validity: credentialValidity(now),
            },
            definition: jobs.definition,
            deadline: before,
            databaseSchema: schema,
            signal: new AbortController().signal,
            method: "get",
            args: { id: "stale" },
          }, () => jobs.get({ namespace }, { id: "stale" }))
        );
        assert(isCollectionAlarmPolicyStale(error));
        await run(
          "fixture.complete-stale",
          {},
          (_, ctx) => completeOwnerDeadline(ctx.transaction, schema, before),
        );
        assertEquals((await selected("stale"))!.revision, after.revision);
        now = new Date(String(stale.nextRunAt));
        await wakeOwnerAlarms(db.session, app.engine, [namespace]);
        assertEquals(uses, 3);
        await jobs.update({ namespace }, {
          id: "stale",
          set: { status: "paused" },
        });
        const changed = await create("changed");
        await jobs.update({ namespace }, {
          id: "changed",
          set: {
            metadata: { creator: "other" },
            payload: { threadId: "other-thread" },
          },
        });
        await create("cancelled");
        await jobs.update({ namespace }, {
          id: "cancelled",
          set: { status: "paused" },
        });
        now = new Date(String(changed.nextRunAt));
        await wakeOwnerAlarms(db.session, app.engine, [namespace]);
        assertEquals(uses, 3);
        assertEquals(await selected("changed"), undefined);
        assertEquals(await selected("cancelled"), undefined);
        const transient = await create("transient");
        const retained = (await selected("transient"))!;
        now = new Date(String(transient.nextRunAt));
        queryFailure = true;
        await assertRejects(
          () => wakeOwnerAlarms(db.session, app.engine, [namespace]),
          Error,
          "could not be completed",
        );
        assertEquals(
          (await selected("transient"))!.revision,
          retained.revision,
        );
        assertEquals(uses, 3);
        queryFailure = false;
        await wakeOwnerAlarms(db.session, app.engine, [namespace]);
        assertEquals(uses, 4);
        const rows = await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "${schema}".events WHERE type='scheduled_job.due'`,
        );
        assertEquals(Number(rows.rows[0].n), 4);
        const refusals = diagnostics.filter((item) =>
          item.phase === "owner_alarm_refused"
        );
        assertEquals(refusals.length, 2);
        for (const item of refusals) {
          assertEquals(Object.keys(item).sort(), [
            "databaseSchema",
            "namespace",
            "phase",
            "status",
            "timestampMs",
          ]);
          assertEquals(item.status, "forbidden");
          assertEquals(item.databaseSchema, schema);
          assertEquals(item.namespace, namespace);
        }
      });
    } finally {
      await app.close();
      await db.close();
    }
  },
});
