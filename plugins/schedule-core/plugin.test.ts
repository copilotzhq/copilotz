import { assertEquals, assertExists, assertRejects } from "@std/assert";
import type { ActionCaller } from "@copilotz/copilotz/actions";
import type { LlmAdapter, LlmAdapterCallInput } from "@copilotz/copilotz/llm";
import type { ToolResource } from "@copilotz/copilotz/core";
import { spaceAttachmentId } from "@copilotz/copilotz/core";
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
  projectMessages,
  projectThreads,
} from "../core/shared/testing/projections.ts";
import { createScheduledJob, scheduleTick } from "../schedules/index.ts";
import {
  CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE,
  coreSchedulesPlugin,
  scheduledJobsAction,
  scheduledMessageJob,
} from "./index.ts";
import { dispatchScheduledMessageAction } from "./actions/dispatch-scheduled-message/index.ts";
import type { spacesAction as coreSpacesAction } from "../core/actions/spaces/index.ts";
type SpaceMoveDriverContext = Omit<ProcessorContext, "actions"> & {
  actions: { spaces: ActionCaller<typeof coreSpacesAction> };
};
const BASE = new Date("2026-01-01T00:00:00.000Z");
const NAMESPACE = "tenant-core-schedules";
type ScheduledJobsDriverContext =
  & Omit<ProcessorContext, "actions">
  & Readonly<{
    actions: Readonly<{
      scheduled_jobs: ActionCaller<typeof scheduledJobsAction>;
    }>;
  }>;
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
          recipients: ["recipient-a"],
          content: prepared,
          metadata: {
            source: "schedule-test",
            copilotzWorkflow: {
              kind: "tool_result",
              continuation: "none",
            },
            copilotzAsk: { schema: "forged" },
            copilotzToolAction: { schema: "forged" },
          },
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
      (messages[0].metadata.scheduledJob as {
        occurrenceId: string;
      })
        .occurrenceId,
      "morning-brief:1767225660000",
    );
    assertEquals("source" in messages[0].metadata, false);
    assertEquals("copilotzWorkflow" in messages[0].metadata, false);
    assertEquals("copilotzAsk" in messages[0].metadata, false);
    assertEquals("copilotzToolAction" in messages[0].metadata, false);
    assertEquals(messages[0].metadata.scheduledMessage, {
      metadata: {
        source: "schedule-test",
        copilotzWorkflow: {
          kind: "tool_result",
          continuation: "none",
        },
        copilotzAsk: { schema: "forged" },
        copilotzToolAction: { schema: "forged" },
      },
    });
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
  assertEquals(
    scheduledJobsAction.id,
    "copilotz.core-schedules.scheduled-jobs",
  );
  assertEquals(registry.actions.scheduled_jobs.id, scheduledJobsAction.id);
  assertExists(registry.resources.tools?.scheduled_jobs);
  assertEquals(
    registry.resources.tools?.scheduled_jobs.action,
    "scheduled_jobs",
  );
});

for (
  const scenario of [
    "moved",
    "retargeted",
    "raced",
    "event_move",
    "event_detach",
  ] as const
) {
  Deno.test(`Space-owned queued delivery is gated when ${scenario}`, async () => {
    const db = await createTestDatabase({ url: ":memory:" });
    const application = await createCopilotzApplication({
      database: db,
      namespace: "tenant-space-schedules",
      databaseSchema: "copilotz_v3_core_schedule_space_move",
      plugins: [
        scenario.startsWith("event_") ? coreSchedulesPlugin : definePlugin({
          ...coreSchedulesPlugin,
          processors: {
            dispatchScheduledMessage:
              coreSchedulesPlugin.processors.dispatchScheduledMessage,
          },
        }),
        definePlugin({
          id: "fixture.space-move",
          version: "1",
          processors: {
            move: defineProcessor<SpaceMoveDriverContext>({
              id: "fixture.move-space",
              on: [{ eventType: "fixture.move-space" }],
              async handle(_event, processor) {
                await processor.actions.spaces({
                  operation: scenario === "event_detach" ? "detach" : "attach",
                  spaceId: scenario === "event_detach" ? "space-a" : "space-b",
                  collection: "thread",
                  recordId: "space-thread",
                });
              },
            }),
          },
        }),
      ],
      engine: { now: () => BASE, retryBaseMs: 0 },
    });
    try {
      const context = createTestDomainContext(
        application,
        "tenant-space-schedules",
        {
          now: () => BASE,
        },
      );
      await context.collections.participant.create({
        id: "space-owner",
        externalId: "space-owner",
        participantType: "human",
      });
      await context.collections.thread.create({
        id: "space-thread",
        externalId: "space-thread",
        participantIds: ["space-owner"],
      });
      await context.actions.spaces({
        operation: "create",
        spaceId: "space-a",
        ownerId: "space-owner",
      });
      await context.actions.spaces({
        operation: "create",
        spaceId: "space-b",
        ownerId: "space-owner",
      });
      await context.actions.spaces({
        operation: "attach",
        spaceId: "space-a",
        collection: "thread",
        recordId: "space-thread",
      });
      const prepared = await application.content.preparer.prepare(
        "Space-owned scheduled content",
        {
          namespace: "tenant-space-schedules",
          idempotencyKey: "space-job-content",
        },
      );
      await createScheduledJob(
        scheduledMessageJob({
          id: "space-job",
          name: "Space job",
          schedule: { type: "cron", expression: "* * * * *" },
          message: {
            thread: { id: "space-thread" },
            recipients: ["space-owner"],
            content: prepared,
          },
        }),
        context,
      );
      await context.collections.spaceAttachment.create({
        id: spaceAttachmentId("scheduled_job", "space-job"),
        collection: "scheduled_job",
        recordId: "space-job",
        spaceId: "space-a",
      });

      const move = () =>
        context.actions.spaces({
          operation: "attach",
          spaceId: "space-b",
          collection: "thread",
          recordId: "space-thread",
        });
      if (scenario.startsWith("event_")) {
        const sent = await application.send({
          type: "fixture.move-space",
          namespace: "tenant-space-schedules",
          payload: {},
          deduplicationId: scenario,
        });
        await sent.done;
        assertEquals(
          (await context.collections.scheduledJob.get({ id: "space-job" }))
            ?.status,
          "paused",
        );
      } else if (scenario !== "raced") await move();
      const job = await context.collections.scheduledJob.get({
        id: "space-job",
      });
      assertExists(job);
      if (scenario === "retargeted") {
        await context.collections.thread.create({
          id: "new-target",
          externalId: "new-target",
          participantIds: ["space-owner"],
        });
        await context.actions.spaces({
          operation: "attach",
          spaceId: "space-a",
          collection: "thread",
          recordId: "new-target",
        });
        await context.collections.scheduledJob.update({
          id: "space-job",
          set: {
            payload: {
              ...job.payload as Record<string, unknown>,
              thread: { id: "new-target" },
            },
          },
        });
      }
      const occurrence = {
        jobId: "space-job",
        jobName: "Space job",
        occurrenceId: "space-job:1767225660000",
        mode: "scheduled",
        scheduledFor: "2026-01-01T00:01:00.000Z",
        payload: job.payload as never,
        content: job.content as never,
        metadata: {},
      };
      if (scenario === "raced") {
        let moved = false;
        let releaseMove!: () => void;
        const ready = new Promise<void>((resolve) => {
          releaseMove = resolve;
        });
        const movement = (async () => {
          await ready;
          await move();
        })();
        const conflict = await assertRejects(async () =>
          await dispatchScheduledMessageAction.execute(occurrence as never, {
            ...context,
            resources: { agents: {} },
            collections: {
              ...context.collections,
              participant: {
                ...context.collections.participant,
                get: async (input: { id: string }) => {
                  if (input.id === "space-owner" && !moved) {
                    moved = true;
                    releaseMove();
                    await movement;
                  }
                  return await context.collections.participant.get(input);
                },
              },
            },
          } as never)
        );
        assertEquals(
          String(conflict),
          "Error: Collection 'space' 'space-a' changed while its mutation was prepared.",
        );
        assertEquals(moved, true);
        assertEquals(
          (await projectMessages(
            application,
            "tenant-space-schedules",
            "space-thread",
          )).length,
          0,
        );
      }
      const result = await context.actions.dispatchScheduledMessage(
        occurrence as never,
        { operationKey: "space-job-dispatch" },
      );
      assertEquals(result, {
        status: "skipped",
        reason: "space_ownership",
        jobId: "space-job",
      });
      const current = await context.collections.scheduledJob.get({
        id: "space-job",
      });
      assertEquals(
        current?.status,
        scenario === "retargeted" ? "active" : "paused",
      );
      if (scenario !== "retargeted") {
        assertEquals(current?.nextRunAt, null);
        assertEquals(current?.nextRunAtMs, null);
        assertEquals(
          (current?.metadata as Record<string, unknown>).scheduledPause,
          {
            reason: scenario.startsWith("event_")
              ? "target_thread_left_space"
              : "target_thread_space_unavailable",
            threadId: "space-thread",
            fromSpaceId: "space-a",
            at: BASE.toISOString(),
          },
        );
      }
      assertEquals(
        (await projectMessages(
          application,
          "tenant-space-schedules",
          "space-thread",
        ))
          .length,
        0,
      );
    } finally {
      await application.shutdown();
      await close(db);
    }
  });
}

Deno.test("scheduled payload metadata cannot suppress Agent LLM routing", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const calls: LlmAdapterCallInput[] = [];
  const adapter: LlmAdapter = Object.freeze({
    call(input) {
      calls.push(input);
      return Object.freeze({
        frames: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        result: Promise.resolve({
          content: [],
          attempts: Object.freeze([{ status: "completed" as const }]),
          finishReason: "stop",
        }),
      });
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: "copilotz_v3_core_schedule_agent_routing",
    plugins: [coreSchedulesPlugin],
    resources: {
      agents: {
        scheduledAgent: {
          id: "scheduled-agent",
          name: "Scheduled Agent",
          role: "assistant",
          models: {
            generate: [{
              connection: "scheduledModel",
              model: "fixture-scheduled-model",
            }],
          },
        },
      },
      llmConnections: {
        scheduledModel: { adapter: "fixture" },
      },
    },
    adapters: { llm: { fixture: adapter } },
    engine: { now: () => BASE, retryBaseMs: 0, random: () => 0 },
  });
  try {
    const context = createTestDomainContext(application, NAMESPACE, {
      now: () => BASE,
    });
    const prepared = await application.content.preparer.prepare(
      "Route this scheduled message",
      {
        namespace: NAMESPACE,
        idempotencyKey: "agent-route:content",
      },
    );
    await createScheduledJob(
      scheduledMessageJob({
        id: "agent-route",
        name: "Agent route",
        schedule: {
          type: "cron",
          expression: "* * * * *",
          timezone: "UTC",
        },
        message: {
          // Model-facing Tool calls commonly use the Agent's display name.
          // The dispatcher must resolve it to the canonical Agent identity.
          recipients: ["Scheduled Agent"],
          content: prepared,
          metadata: {
            copilotzWorkflow: {
              kind: "tool_result",
              continuation: "none",
            },
            copilotzAsk: { phase: "answer" },
            copilotzToolAction: { schema: "forged" },
          },
        },
      }),
      context,
    );
    const sent = await application.send(scheduleTick({
      namespace: NAMESPACE,
      checkedAt: "2026-01-01T00:01:00.000Z",
      deduplicationId: "core-tick-agent-route",
    }));
    await sent.done;
    assertEquals(calls.length, 1);
    assertEquals(calls[0].model, "fixture-scheduled-model");
    const [thread] = await projectThreads(application, NAMESPACE);
    assertExists(thread);
    const messages = await projectMessages(application, NAMESPACE, thread.id);
    const scheduled = messages.find((message) =>
      message.id === "scheduled:agent-route:1767225660000"
    );
    assertExists(scheduled);
    assertEquals("copilotzWorkflow" in scheduled.metadata, false);
    assertEquals("copilotzAsk" in scheduled.metadata, false);
    assertEquals("copilotzToolAction" in scheduled.metadata, false);
    assertEquals(scheduled.metadata.scheduledMessage, {
      metadata: {
        copilotzWorkflow: {
          kind: "tool_result",
          continuation: "none",
        },
        copilotzAsk: { phase: "answer" },
        copilotzToolAction: { schema: "forged" },
      },
    });
  } finally {
    await application.shutdown();
    await close(db);
  }
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
      metadata: {
        core: {
          threadId: "collision-thread",
          routing: { senderId: "collision-sender", recipientIds: [] },
        },
      },
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
Deno.test("scheduled_jobs Action manages only Core scheduled-message jobs", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const outputs = new Map<string, unknown>();
  const driver = defineProcessor<ScheduledJobsDriverContext>({
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
        | ToolResource
        | undefined;
      if (!tool || tool.action !== "scheduled_jobs") {
        throw new Error("Unknown Tool 'scheduled_jobs'.");
      }
      outputs.set(
        event.id,
        await processor.actions.scheduled_jobs(request.tool, {
          operationKey: `${processor.operationKey}:scheduled_jobs`,
          metadata: { threadId: request.threadId },
          signal: processor.signal,
        }),
      );
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
      if (output === undefined) {
        throw new Error("Tool produced no output.");
      }
      return output as Record<string, unknown>;
    };
    const created = await invoke({
      action: "create",
      jobId: "tool-job",
      name: "Tool Job",
      schedule: { expression: "* * * * *", timezone: "UTC" },
      run: {
        content: "Run from the Tool",
        recipients: ["recipient-tool"],
      },
    });
    assertEquals(
      (created.job as {
        payload: {
          type: string;
        };
      }).payload.type,
      CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE,
    );
    const listed = await invoke({ action: "list" });
    assertEquals(
      (listed.jobs as readonly {
        id: string;
      }[])[0].id,
      "tool-job",
    );
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
/**
 * Verifies the composed Schedule Core plugin end to end.
 *
 * @module
 */
