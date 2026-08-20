import { assert, assertEquals, assertExists } from "@std/assert";

import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import type { Agent } from "../resources/index.ts";
import { createCopilotzApplication } from "../application/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import { definePlugin, defineProcessor } from "../plugins/index.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "../tools/index.ts";
import { createTestDomainContext } from "../../runtime/testing/domain-context.ts";
import {
  projectLlmAttempts,
  projectMessageById,
  projectMessages,
  projectParticipants,
  projectThreadByExternalId,
  projectThreadById,
  projectThreads,
  projectToolExecutionById,
  projectToolExecutions,
} from "../../runtime/testing/projections.ts";
import { createScheduledJobsPlugin, getNextScheduledRunAt } from "./index.ts";

const NAMESPACE = "tenant-schedules";
const agent: Agent = { id: "support", name: "Support", role: "support" };
const BASE = new Date("2026-01-01T00:00:00.000Z");

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("scheduled due transition atomically advances and dispatches one public job message", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_schedules",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [createScheduledJobsPlugin()],
    resources: { agents: [agent] },
    engine: { now: () => BASE },
  });
  try {
    const created = await application.schedules.create({
      namespace: NAMESPACE,
      id: "morning-brief",
      name: "Morning brief",
      schedule: {
        type: "cron",
        expression: "* * * * *",
        timezone: "UTC",
      },
      run: {
        recipientIds: [agent.id],
        content: [
          "Prepare the brief",
          {
            type: "file",
            bytes: new Uint8Array([1, 2, 3]),
            mediaType: "application/pdf",
            name: "brief.pdf",
          },
        ],
        metadata: { source: "schedule-test" },
      },
      identity: {
        correlationId: "schedule-create-a",
        deduplicationId: "schedule-create-a",
      },
    });
    assertExists(created.value);
    assertEquals(created.value.nextRunAt, "2026-01-01T00:01:00.000Z");
    assertEquals(created.value.run.content.length, 2);

    const tick = await application.schedules.tick({
      namespace: NAMESPACE,
      now: new Date("2026-01-01T00:01:00.000Z"),
      waitForCompletion: true,
    });
    assertEquals(tick.claimed, 1);
    assertEquals(tick.dispatched, 1);
    assertEquals(tick.failed, 0);
    assertEquals(tick.jobs[0].occurrenceId, "morning-brief:1767225660000");

    const updated = await application.schedules.get(
      NAMESPACE,
      "morning-brief",
    );
    assertExists(updated);
    assertEquals(updated.lastRunAt, "2026-01-01T00:01:00.000Z");
    assertEquals(updated.nextRunAt, "2026-01-01T00:02:00.000Z");
    const threads = await projectThreads(application, NAMESPACE);
    assertEquals(threads.length, 1);
    assertEquals(threads[0].externalId, "scheduled-job:morning-brief");
    assertEquals(
      threads[0].participants.map((value) => value.participantType).sort(),
      ["agent", "job"],
    );
    const messages = await projectMessages(
      application,
      NAMESPACE,
      threads[0].id,
    );
    assertEquals(messages.length, 1);
    assertEquals(messages[0].sender.participantType, "job");
    assertEquals(messages[0].recipientIds.length, 1);
    const content = await application.content.resolver.getMany(
      messages[0].content,
      { namespace: NAMESPACE },
    );
    assertEquals(content[0].text, "Prepare the brief");
    assertEquals(content[1].bytes, new Uint8Array([1, 2, 3]));
    assertEquals(content[1].ref.name, "brief.pdf");

    const events = await application.events.list({ namespace: NAMESPACE });
    assertEquals(
      events.filter((event) => event.type === "scheduled_job.due").length,
      1,
    );
    const due = events.find((event) => event.type === "scheduled_job.due");
    assertExists(due);
    const deliveries = await application.deliveries.list({
      namespace: NAMESPACE,
      eventId: due.id,
    });
    assertEquals(deliveries.map((value) => value.status), ["succeeded"]);

    const manual = await application.schedules.runNow({
      namespace: NAMESPACE,
      id: "morning-brief",
      now: new Date("2026-01-01T00:01:30.000Z"),
      waitForCompletion: true,
      identity: {
        correlationId: "manual-run-a",
        deduplicationId: "manual-run-a",
      },
    });
    assertEquals(manual.deduplicated, false);
    assertEquals(manual.dispatchFailures, 0);
    assert(manual.occurrenceId.includes(":manual:"));
    const retriedManual = await application.schedules.runNow({
      namespace: NAMESPACE,
      id: "morning-brief",
      now: new Date("2026-01-01T00:01:45.000Z"),
      waitForCompletion: true,
      identity: {
        correlationId: "manual-run-a",
        deduplicationId: "manual-run-a",
      },
    });
    assertEquals(retriedManual.eventId, manual.eventId);
    assertEquals(retriedManual.occurrenceId, manual.occurrenceId);
    assertEquals(retriedManual.deduplicated, true);
    assertEquals(
      (await projectMessages(application, NAMESPACE, threads[0].id)).length,
      2,
    );

    const retryTick = await application.schedules.tick({
      namespace: NAMESPACE,
      now: new Date("2026-01-01T00:01:00.000Z"),
    });
    assertEquals(retryTick.claimed, 0);
    assertEquals(
      (await projectMessages(application, NAMESPACE, threads[0].id)).length,
      2,
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("scheduled_jobs tool uses scoped capabilities for the complete lifecycle", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const outputs = new Map<string, unknown>();
  const driver = defineProcessor<CopilotzProcessorContext>({
    id: "fixture.scheduled-jobs-tool",
    on: [{ eventType: "fixture.scheduled_jobs.requested" }],
    async handle(event, processor) {
      if (!event.durable) return;
      const tool = processor.resources.require<WorkflowTool>(
        "tools",
        "scheduled_jobs",
      );
      const timestamp = event.createdAt;
      const context: WorkflowToolExecutionContext = {
        namespace: processor.namespace,
        correlationId: event.correlationId,
        idempotencyKey: processor.idempotencyKey,
        processor,
        execution: {
          id: `execution:${event.id}`,
          namespace: processor.namespace,
          threadId: event.threadId!,
          toolCallId: `call:${event.id}`,
          tool: { id: tool.id, key: tool.key },
          status: "running",
          content: [],
          startedAt: timestamp,
          metadata: {},
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        threadId: event.threadId!,
        toolExecutionId: `execution:${event.id}`,
        toolCallId: `call:${event.id}`,
        agents: [],
        tools: [tool],
        collections: processor.collections,
        emitOutput: () => Promise.resolve(),
        cancelled: false,
      };
      outputs.set(event.id, await tool.execute(event.payload, context));
    },
  });
  const fixturePlugin = definePlugin({
    manifest: {
      id: "fixture.scheduled-jobs-tool",
      version: "1.0.0",
      provides: { processors: [driver.id] },
    },
    resources: { processors: [driver] },
  });
  const application = await createCopilotzApplication({
    database: db,
    databaseSchema: "copilotz_v3_schedule_tool",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [createScheduledJobsPlugin(), fixturePlugin],
    resources: { agents: [agent] },
    engine: { now: () => BASE },
  });
  try {
    await createTestDomainContext(application, NAMESPACE).features.thread
      .create({
        id: "thread-tool",
        externalId: "thread-tool",
      });
    const invoke = async (payload: Record<string, unknown>) => {
      const appended = await application.events.append({
        type: "fixture.scheduled_jobs.requested",
        namespace: NAMESPACE,
        threadId: "thread-tool",
        payload,
        correlationId: `fixture:${crypto.randomUUID()}`,
        deduplicationId: `fixture:${crypto.randomUUID()}`,
      });
      await Promise.all(appended.dispatch.handles.map((handle) => handle.done));
      if (!outputs.has(appended.event.id)) {
        const deliveries = await application.deliveries.list({
          namespace: NAMESPACE,
          eventId: appended.event.id,
        });
        throw new Error(
          `Schedule tool produced no output: ${JSON.stringify(deliveries)}`,
        );
      }
      return outputs.get(appended.event.id) as Record<string, unknown>;
    };

    const created = await invoke({
      action: "create",
      jobId: "tool-job",
      name: "Tool Job",
      schedule: { expression: "* * * * *", timezone: "UTC" },
      run: { content: "Run from the lifecycle tool", recipientIds: [agent.id] },
    });
    assertEquals((created.job as { id: string }).id, "tool-job");
    const listed = await invoke({ action: "list", status: "active" });
    assertEquals((listed.jobs as readonly { id: string }[])[0].id, "tool-job");
    const updated = await invoke({
      action: "update",
      jobId: "tool-job",
      name: "Updated Tool Job",
    });
    assertEquals((updated.job as { name: string }).name, "Updated Tool Job");
    assertEquals(
      ((await invoke({ action: "pause", jobId: "tool-job" })).job as {
        status: string;
      }).status,
      "paused",
    );
    assertEquals(
      ((await invoke({ action: "resume", jobId: "tool-job" })).job as {
        status: string;
      }).status,
      "active",
    );
    const manual = await invoke({ action: "run_now", jobId: "tool-job" });
    const manualSettlementScopeId = String(manual.settlementScopeId);
    const expires = Date.now() + 5_000;
    while (
      (await application.events.settlement(NAMESPACE, manualSettlementScopeId))
        .unsettled >
        0
    ) {
      if (Date.now() >= expires) {
        throw new Error("Manual schedule did not settle.");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const messages = await projectMessages(
      application,
      NAMESPACE,
      "thread-tool",
    );
    assertEquals(messages.length, 1);
    assertEquals(messages[0].sender.participantType, "job");
    const fetched = await invoke({ action: "get", jobId: "tool-job" });
    assertEquals(
      (fetched.job as { lastRunAt: string }).lastRunAt,
      BASE.toISOString(),
    );
    assertEquals(
      ((await invoke({ action: "cancel", jobId: "tool-job" })).job as {
        status: string;
      }).status,
      "cancelled",
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("scheduled lifecycle and concurrent ticks remain tenant scoped and lease-free", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    databaseSchema: "copilotz_v3_schedule_lifecycle",
    core: false,
    canonicalCore: [coreCollectionsPlugin],
    plugins: [createScheduledJobsPlugin()],
    resources: { agents: [agent] },
    engine: { now: () => BASE },
  });
  try {
    await application.schedules.create({
      namespace: "tenant-a",
      id: "job-a",
      name: "Job A",
      schedule: { type: "cron", expression: "* * * * *" },
      run: { recipientIds: [agent.id], content: "Run A" },
    });
    await application.schedules.create({
      namespace: "tenant-b",
      id: "job-b",
      name: "Job B",
      schedule: { type: "cron", expression: "* * * * *" },
      run: { recipientIds: [agent.id], content: "Run B" },
    });
    const paused = await application.schedules.pause("tenant-b", "job-b");
    assertEquals(paused.value?.status, "paused");
    assertEquals(
      (await application.schedules.tick({
        namespace: "tenant-b",
        now: new Date("2026-01-01T00:01:00.000Z"),
      })).claimed,
      0,
    );
    const resumed = await application.schedules.resume("tenant-b", "job-b");
    assertEquals(resumed.value?.status, "active");
    assert(
      (resumed.value?.nextRunAtMs ?? 0) > BASE.getTime(),
    );
    const [left, right] = await Promise.all([
      application.schedules.tick({
        namespace: "tenant-a",
        now: new Date("2026-01-01T00:01:00.000Z"),
        waitForCompletion: true,
      }),
      application.schedules.tick({
        namespace: "tenant-a",
        now: new Date("2026-01-01T00:01:00.000Z"),
        waitForCompletion: true,
      }),
    ]);
    assertEquals(left.dispatched + right.dispatched, 1);
    assertEquals(
      (await application.schedules.list("tenant-a")).map((value) => value.id),
      ["job-a"],
    );
    assertEquals(
      (await application.schedules.list("tenant-b")).map((value) => value.id),
      ["job-b"],
    );
    const cancelled = await application.schedules.cancel("tenant-b", "job-b");
    assertEquals(cancelled.value?.status, "cancelled");
    assertEquals(cancelled.value?.nextRunAt, null);
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("cron calculation and scheduled runtime stay portable and factory-first", async () => {
  assertEquals(
    getNextScheduledRunAt(
      { type: "cron", expression: "0 9 * * 1", timezone: "UTC" },
      new Date("2026-01-04T00:00:00.000Z"),
    ).toISOString(),
    "2026-01-05T09:00:00.000Z",
  );
  for (
    const file of [
      "collection.ts",
      "plugin.ts",
      "repository.ts",
      "tool.ts",
      "types.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(/\bclass\s+[A-Za-z_$]/.test(source), false, file);
    assertEquals(source.includes("Deno."), false, file);
    assertEquals(source.includes("node:"), false, file);
    assertEquals(source.includes("queueId"), false, file);
    assertEquals(source.includes("leaseOwner"), false, file);
    assertEquals(source.includes("unsafeGraph"), false, file);
  }
});
