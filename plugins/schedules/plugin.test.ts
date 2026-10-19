import { wakeOwnerAlarms } from "../../runtime/testing/owner-alarms.ts";
import { assertEquals, assertExists, assertRejects } from "@std/assert";

import { createCopilotzApplication } from "../../runtime/application/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../../runtime/plugins/index.ts";
import { createTestDomainContext } from "../core/shared/testing/context.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../runtime/testing/ominipg.ts";
import {
  createScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  runScheduledJobNow,
  schedulesPlugin,
  updateScheduledJob,
} from "./index.ts";

const BASE = new Date("2026-01-01T00:00:00.000Z");
const NAMESPACE = "tenant-schedules-base";

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("base schedules turn opaque jobs into self-contained durable due events", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  let now = BASE;
  let dueData: unknown;
  const observer = defineProcessor<ProcessorContext>({
    id: "fixture.observe-scheduled-due",
    on: [{ eventType: "scheduled_job.due" }],
    handle(event) {
      dueData = event.data;
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_schedules_base",
    plugins: [
      schedulesPlugin,
      definePlugin({
        id: "fixture.schedule-observer",
        version: "1.0.0",
        processors: { observer },
      }),
    ],
    engine: { now: () => now },
  });
  try {
    const context = createTestDomainContext(application, NAMESPACE, {
      now: () => BASE,
    });
    const prepared = await application.content.preparer.prepare([
      "Prepare the report",
      {
        type: "file",
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "application/pdf",
        name: "report.pdf",
      },
    ], {
      namespace: NAMESPACE,
      idempotencyKey: "generic-report:content",
    });
    const created = await createScheduledJob({
      id: "generic-report",
      name: "Generic report",
      schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" },
      payload: { type: "fixture.report", reportId: "report-a" },
      content: prepared,
    }, context);
    assertEquals(created.nextRunAt, "2026-01-01T00:01:00.000Z");
    assertEquals(created.payload, {
      type: "fixture.report",
      reportId: "report-a",
    });
    assertEquals(created.content?.length, 2);
    const resolved = await application.content.resolver.getMany(
      created.content ?? [],
      { namespace: NAMESPACE },
    );
    assertEquals(resolved[0].text, "Prepare the report");
    assertEquals(resolved[1].bytes, new Uint8Array([1, 2, 3]));

    now = new Date("2026-01-01T00:01:00.000Z");
    await wakeOwnerAlarms(db.session, application.engine, [NAMESPACE]);

    const updated = await getScheduledJob({ id: created.id }, context);
    assertExists(updated);
    assertEquals(updated.lastOccurrence, {
      id: "generic-report:1767225660000",
      mode: "scheduled",
      scheduledFor: "2026-01-01T00:01:00.000Z",
    });
    assertEquals(updated.nextRunAt, "2026-01-01T00:02:00.000Z");
    assertEquals(updated.content, created.content);
    const body = dueData as {
      record: {
        payload: unknown;
        lastOccurrence: unknown;
        content: unknown[];
      };
    };
    assertEquals(body.record.payload, created.payload);
    assertEquals(body.record.lastOccurrence, updated.lastOccurrence);
    assertEquals(body.record.content, [
      { ...created.content![0], value: "Prepare the report" },
      created.content![1],
    ]);

    const manualInput = runScheduledJobNow({
      namespace: NAMESPACE,
      id: created.id,
      scheduledFor: "2026-01-01T00:01:30.000Z",
      correlationId: "manual-a",
      deduplicationId: "manual-a",
    });
    const manual = await application.send(manualInput);
    await manual.done;
    const retry = await application.send(manualInput);
    await retry.done;
    assertEquals(retry.eventId, manual.eventId);
    const events = await application.events.list({ namespace: NAMESPACE });
    assertEquals(
      events.filter((event) => event.type === "scheduled_job.due").length,
      2,
    );
    assertEquals(
      (await getScheduledJob({ id: created.id }, context))?.lastOccurrence,
      {
        id: "generic-report:manual:1767225690000",
        mode: "manual",
        scheduledFor: "2026-01-01T00:01:30.000Z",
      },
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("base schedule claims remain concurrent-safe and tenant scoped", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  let now = BASE;
  const application = await createCopilotzApplication({
    database: db,
    databaseSchema: "copilotz_v3_schedules_scope",
    plugins: [schedulesPlugin],
    engine: { now: () => now },
  });
  try {
    const tenantA = createTestDomainContext(application, "tenant-a", {
      now: () => BASE,
    });
    const tenantB = createTestDomainContext(application, "tenant-b", {
      now: () => BASE,
    });
    for (
      const [id, context] of [
        ["job-a", tenantA],
        ["job-b", tenantB],
      ] as const
    ) {
      await createScheduledJob({
        id,
        name: id,
        schedule: { type: "cron", expression: "* * * * *" },
        payload: { type: "fixture.job", id },
      }, context);
    }
    await updateScheduledJob({
      id: "job-b",
      patch: { status: "paused" },
    }, tenantB);
    now = new Date("2026-01-01T00:01:00.000Z");
    await Promise.all([
      wakeOwnerAlarms(db.session, application.engine, ["tenant-a", "tenant-b"]),
      wakeOwnerAlarms(db.session, application.engine, ["tenant-a", "tenant-b"]),
    ]);
    assertEquals(
      (await application.events.list({ namespace: "tenant-a" })).filter(
        (event) => event.type === "scheduled_job.due",
      ).length,
      1,
    );
    assertEquals(
      (await application.events.list({ namespace: "tenant-b" })).filter(
        (event) => event.type === "scheduled_job.due",
      ).length,
      0,
    );
    assertEquals(
      (await listScheduledJobs({}, tenantA)).map((job) => job.id),
      ["job-a"],
    );
    assertEquals(
      (await listScheduledJobs({}, tenantB)).map((job) => job.id),
      ["job-b"],
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("base schedules compose without Core semantics or runtime ownership", async () => {
  const registry = createPluginRegistry({ plugins: [schedulesPlugin] });
  assertExists(registry.collections.scheduledJob);
  const collections = registry.collections as Readonly<Record<string, unknown>>;
  const resources = registry.resources as Readonly<Record<string, unknown>>;
  assertEquals(collections.participant, undefined);
  assertEquals(collections.thread, undefined);
  assertEquals(collections.message, undefined);
  assertEquals(resources.agents, undefined);
  assertEquals(resources.tools, undefined);

  for (
    const file of [
      "index.ts",
      "plugin.ts",
      "actions/run-scheduled-job-now/index.ts",
      "collections/scheduled-job/index.ts",
      "processors/run-now-input/index.ts",
      "authoring/inputs/index.ts",
      "authoring/scheduled-jobs/index.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(
      /(?:\.\.\/core|copilotz\/tools|collections\.(?:participant|thread|message)|resources\.(?:agents|tools)|defineTool|ToolResource|WorkflowTool)/
        .test(
          source,
        ),
      false,
      file,
    );
  }
  await assertRejects(
    () =>
      Deno.stat(new URL("../../runtime/schedules/plugin.ts", import.meta.url)),
    Deno.errors.NotFound,
  );
});

Deno.test("owner restart coalesces downtime at the retained occurrence and preserves manual paused semantics", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "schedules_restart";
  let now = BASE;
  const timers = new Map<number, () => void>();
  let serial = 0;
  const options = {
    database: db,
    databaseSchema: schema,
    namespace: NAMESPACE,
    plugins: [schedulesPlugin],
    engine: {
      now: () => now,
      alarmScheduler: {
        schedule(callback: () => void) {
          const id = ++serial;
          timers.set(id, callback);
          return id;
        },
        cancel(handle: unknown) {
          timers.delete(handle as number);
        },
      },
    },
  };
  let application = await createCopilotzApplication(options);
  try {
    let context = createTestDomainContext(application, NAMESPACE, {
      now: () => now,
    });
    const created = await createScheduledJob({
      id: "restart-job",
      name: "Restart job",
      schedule: { type: "cron", expression: "* * * * *" },
      payload: { type: "opaque" },
    }, context);
    await application.shutdown();
    assertEquals(timers.size, 0);
    now = new Date("2026-01-01T00:05:30Z");
    application = await createCopilotzApplication(options);
    context = createTestDomainContext(application, NAMESPACE, {
      now: () => now,
    });
    await wakeOwnerAlarms(db.session, application.engine, [NAMESPACE]);
    await wakeOwnerAlarms(db.session, application.engine, [NAMESPACE]);
    const advanced = await getScheduledJob({ id: created.id }, context);
    assertEquals(advanced?.lastOccurrence, {
      id: "restart-job:1767225660000",
      mode: "scheduled",
      scheduledFor: "2026-01-01T00:01:00.000Z",
    });
    assertEquals(advanced?.nextRunAt, "2026-01-01T00:06:00.000Z");
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE })).filter((
        event,
      ) => event.type === "scheduled_job.due").length,
      1,
    );
    await updateScheduledJob(
      { id: created.id, patch: { status: "paused" } },
      context,
    );
    const paused = await getScheduledJob({ id: created.id }, context);
    const manual = await application.send(
      runScheduledJobNow({
        namespace: NAMESPACE,
        id: created.id,
        scheduledFor: now.toISOString(),
        deduplicationId: "paused-manual",
      }),
    );
    await manual.done;
    const manuallyRun = await getScheduledJob({ id: created.id }, context);
    assertEquals(manuallyRun?.status, "paused");
    assertEquals(manuallyRun?.nextRunAt, paused?.nextRunAt);
    assertEquals(manuallyRun?.lastOccurrence?.mode, "manual");
    now = new Date("2026-01-01T00:10:00Z");
    await wakeOwnerAlarms(db.session, application.engine, [NAMESPACE]);
    assertEquals(
      (await application.events.list({ namespace: NAMESPACE })).filter((
        event,
      ) => event.type === "scheduled_job.due").length,
      2,
    );
    assertEquals(
      timers.size,
      0,
      "paused-only owner has no periodic schedule timer",
    );
  } finally {
    await application.shutdown();
    await db.close();
  }
});
