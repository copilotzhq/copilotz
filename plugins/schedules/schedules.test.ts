import { assertEquals, assertExists, assertRejects } from "@std/assert";

import { createCopilotzApplication } from "../../runtime/application/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../../runtime/plugins/index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
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
  scheduleTick,
  updateScheduledJob,
} from "./index.ts";

const BASE = new Date("2026-01-01T00:00:00.000Z");
const NAMESPACE = "tenant-schedules-base";

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("base schedules turn opaque jobs into self-contained durable due events", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
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
    engine: { now: () => BASE },
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

    const tick = await application.send(scheduleTick({
      namespace: NAMESPACE,
      checkedAt: "2026-01-01T00:01:00.000Z",
      deduplicationId: "tick-a",
    }));
    await tick.done;

    const updated = await getScheduledJob({ id: created.id }, context);
    assertExists(updated);
    assertEquals(updated.lastOccurrence, {
      id: "generic-report:1767225660000",
      mode: "scheduled",
      scheduledFor: "2026-01-01T00:01:00.000Z",
    });
    assertEquals(updated.nextRunAt, "2026-01-01T00:02:00.000Z");
    const body = dueData as {
      record: {
        payload: unknown;
        lastOccurrence: unknown;
        content: unknown[];
      };
    };
    assertEquals(body.record.payload, created.payload);
    assertEquals(body.record.lastOccurrence, updated.lastOccurrence);
    assertEquals(body.record.content, [...(created.content ?? [])]);

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
  const application = await createCopilotzApplication({
    database: db,
    databaseSchema: "copilotz_v3_schedules_scope",
    plugins: [schedulesPlugin],
    engine: { now: () => BASE },
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
    const [left, right] = await Promise.all([
      application.send(scheduleTick({
        namespace: "tenant-a",
        checkedAt: "2026-01-01T00:01:00.000Z",
        deduplicationId: "left",
      })),
      application.send(scheduleTick({
        namespace: "tenant-a",
        checkedAt: "2026-01-01T00:01:00.000Z",
        deduplicationId: "right",
      })),
    ]);
    await Promise.all([left.done, right.done]);
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
      "actions.ts",
      "collection.ts",
      "input.ts",
      "lifecycle.ts",
      "model.ts",
      "plugin.ts",
      "types.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(
      /(?:\.\.\/core|collections\.(?:participant|thread|message)|resources\.agents|WorkflowTool)/
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
