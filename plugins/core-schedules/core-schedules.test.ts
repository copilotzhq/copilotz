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
  projectMessages,
  projectThreads,
} from "../../runtime/testing/projections.ts";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "@copilotz/copilotz/tools";
import { createScheduledJob, scheduleTick } from "../schedules/index.ts";
import {
  CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE,
  coreSchedulesPlugin,
  scheduledMessageJob,
} from "./index.ts";

const BASE = new Date("2026-01-01T00:00:00.000Z");
const NAMESPACE = "tenant-core-schedules";

async function close(db: TestDatabase): Promise<void> {
  await db.close();
}

Deno.test("Core Schedules composes its dependencies and turns only typed due payloads into messages", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_core_schedules",
    plugins: [coreSchedulesPlugin],
    engine: { now: () => BASE },
  });
  try {
    const context = createTestDomainContext(application, NAMESPACE, {
      now: () => BASE,
    });
    await context.collections.participant.create({
      id: "recipient-a",
      externalId: "recipient-a",
      participantType: "human",
    });
    await context.collections.thread.create({
      id: "thread-a",
      externalId: "thread-a",
      participantIds: ["recipient-a"],
    });
    const prepared = await application.content.preparer.prepare([
      "Prepare the brief",
      {
        type: "file",
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "application/pdf",
        name: "brief.pdf",
      },
    ], {
      namespace: NAMESPACE,
      idempotencyKey: "morning-brief:content",
    });
    const created = await createScheduledJob(
      scheduledMessageJob({
        id: "morning-brief",
        name: "Morning brief",
        schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" },
        message: {
          thread: { id: "thread-a" },
          recipientIds: ["recipient-a"],
          content: prepared,
          metadata: { source: "schedule-test" },
        },
      }),
      context,
    );
    assertEquals(created.payload.type, CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE);
    assertEquals(created.content?.length, 2);

    const sent = await application.send(scheduleTick({
      namespace: NAMESPACE,
      checkedAt: "2026-01-01T00:01:00.000Z",
      deduplicationId: "core-tick-a",
    }));
    await sent.done;

    const threads = await projectThreads(application, NAMESPACE);
    assertEquals(threads.map((thread) => thread.id), ["thread-a"]);
    const messages = await projectMessages(application, NAMESPACE, "thread-a");
    assertEquals(messages.length, 1);
    assertEquals(messages[0].sender.participantType, "job");
    assertEquals(messages[0].recipientIds, ["recipient-a"]);
    assertEquals(
      (messages[0].metadata.scheduledJob as { occurrenceId: string })
        .occurrenceId,
      "morning-brief:1767225660000",
    );
    const resolved = await application.content.resolver.getMany(
      messages[0].content,
      { namespace: NAMESPACE },
    );
    assertEquals(resolved[0].text, "Prepare the brief");
    assertEquals(resolved[1].bytes, new Uint8Array([1, 2, 3]));
  } finally {
    await application.shutdown();
    await close(db);
  }

  const registry = createPluginRegistry({ plugins: [coreSchedulesPlugin] });
  assertEquals(
    registry.plugins.filter((plugin) => plugin.id === "@copilotz/schedules")
      .length,
    1,
  );
  assertEquals(
    registry.plugins.filter((plugin) => plugin.id === "@copilotz/core").length,
    1,
  );
  assertEquals(
    registry.plugins.filter((plugin) =>
      plugin.id === "@copilotz/core-schedules"
    ).length,
    1,
  );
  assertExists(registry.collections.scheduledJob);
  assertExists(registry.collections.message);
  assertExists(registry.actions.createThreadMessage);
  assertExists(registry.actions.dispatchScheduledMessage);
  assertExists(registry.resources.tools?.scheduled_jobs);
});

Deno.test("Core scheduled-message dispatch rolls back every graph mutation when message creation fails", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_core_schedule_atomicity",
    plugins: [coreSchedulesPlugin],
    resources: {
      agents: {
        rollback: {
          id: "rollback",
          externalId: "rollback-agent",
          name: "Rollback Agent",
          role: "assistant",
        },
      },
    },
    engine: { now: () => BASE },
  });
  try {
    const context = createTestDomainContext(application, NAMESPACE, {
      now: () => BASE,
    });
    await context.collections.participant.create({
      id: "collision-sender",
      externalId: "collision-sender",
      participantType: "human",
    });
    await context.collections.thread.create({
      id: "collision-thread",
      externalId: "collision-thread",
      participantIds: ["collision-sender"],
    });
    const occurrenceId = "rollback-job:1767225660000";
    const messageId = `scheduled:${occurrenceId}`;
    await context.collections.message.create({
      id: messageId,
      threadId: "collision-thread",
      senderId: "collision-sender",
      recipientIds: [],
      content: [],
      metadata: { collision: true },
    }, {
      threadId: "collision-thread",
      routing: { senderId: "collision-sender", recipientIds: [] },
    });
    await assertRejects(
      () =>
        context.actions.dispatchScheduledMessage({
          jobId: "rollback-job",
          jobName: "Rollback job",
          occurrenceId,
          mode: "scheduled",
          scheduledFor: "2026-01-01T00:01:00.000Z",
          payload: {
            type: CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE,
            recipientIds: ["rollback"],
          },
          content: [],
          metadata: {},
        }, { operationKey: "rollback-dispatch" }),
      Error,
      "while its mutation was prepared",
    );

    assertEquals(
      await context.collections.participant.queries.byExternalId({
        externalId: "rollback-job",
      }),
      [],
    );
    assertEquals(
      await context.collections.participant.queries.byExternalId({
        externalId: "rollback-agent",
      }),
      [],
    );
    assertEquals(
      await context.collections.thread.queries.byExternalId({
        externalId: "scheduled-job:rollback-job",
      }),
      [],
    );
    assertEquals(
      (await context.collections.message.get({ id: messageId }))?.metadata,
      { collision: true },
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});

Deno.test("the current scheduled_jobs Tool manages only Core scheduled-message jobs", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const outputs = new Map<string, unknown>();
  const driver = defineProcessor<ProcessorContext>({
    id: "fixture.core-scheduled-jobs-tool",
    on: [{ eventType: "fixture.scheduled_jobs.requested" }],
    async handle(event, processor) {
      if (
        !event.durable || !event.payload ||
        typeof event.payload !== "object" || Array.isArray(event.payload)
      ) {
        throw new TypeError("Scheduled Tool fixture input must be an object.");
      }
      const request = event.payload as Readonly<{
        threadId: string;
        tool: Record<string, unknown>;
      }>;
      const tool = processor.resources.tools?.scheduled_jobs as
        | WorkflowTool
        | undefined;
      if (!tool) throw new Error("Unknown Tool 'scheduled_jobs'.");
      const context: WorkflowToolExecutionContext = {
        namespace: processor.namespace,
        correlationId: event.correlationId,
        idempotencyKey: processor.operationKey,
        processor,
        execution: {
          id: `execution:${event.id}`,
          namespace: processor.namespace,
          threadId: request.threadId,
          toolCallId: `call:${event.id}`,
          tool: { id: tool.id, key: tool.key },
          metadata: {},
        },
        threadId: request.threadId,
        toolExecutionId: `execution:${event.id}`,
        toolCallId: `call:${event.id}`,
        agents: [],
        tools: [tool],
        collections: processor.collections,
        emitOutput: () => Promise.resolve(),
        cancelled: false,
      };
      outputs.set(event.id, await tool.execute(request.tool, context));
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    databaseSchema: "copilotz_v3_core_schedule_tool",
    plugins: [
      coreSchedulesPlugin,
      definePlugin({
        id: "fixture.core-schedule-tool",
        version: "1.0.0",
        processors: { driver },
      }),
    ],
    engine: { now: () => BASE },
  });
  try {
    const context = createTestDomainContext(application, NAMESPACE, {
      now: () => BASE,
    });
    await context.collections.participant.create({
      id: "recipient-tool",
      externalId: "recipient-tool",
      participantType: "human",
    });
    await context.collections.thread.create({
      id: "thread-tool",
      externalId: "thread-tool",
      participantIds: ["recipient-tool"],
    });
    const invoke = async (payload: Record<string, unknown>) => {
      const sent = await application.send({
        type: "fixture.scheduled_jobs.requested",
        namespace: NAMESPACE,
        payload: { threadId: "thread-tool", tool: payload },
        correlationId: `fixture:${crypto.randomUUID()}`,
        deduplicationId: `fixture:${crypto.randomUUID()}`,
      });
      await sent.done;
      const output = outputs.get(sent.eventId);
      if (output === undefined) throw new Error("Tool produced no output.");
      return output as Record<string, unknown>;
    };

    const created = await invoke({
      action: "create",
      jobId: "tool-job",
      name: "Tool Job",
      schedule: { expression: "* * * * *", timezone: "UTC" },
      run: {
        content: "Run from the Tool",
        recipientIds: ["recipient-tool"],
      },
    });
    assertEquals(
      (created.job as { payload: { type: string } }).payload.type,
      CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE,
    );
    const listed = await invoke({ action: "list" });
    assertEquals((listed.jobs as readonly { id: string }[])[0].id, "tool-job");
    await invoke({ action: "run_now", jobId: "tool-job" });
    assertEquals(
      (await projectMessages(application, NAMESPACE, "thread-tool")).length,
      1,
    );
  } finally {
    await application.shutdown();
    await close(db);
  }
});
