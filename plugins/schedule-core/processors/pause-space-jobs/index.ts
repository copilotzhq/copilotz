/** Pause Space-owned jobs when their target conversation leaves the Space. @module */
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { spaceAttachmentId } from "@copilotz/copilotz/core";
import { CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE } from "../../shared/contracts.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export const pauseSpaceJobsProcessor: Processor = defineProcessor({
  id: "core-schedules.pause-space-jobs",
  on: [
    {
      eventType: "spaceAttachment.updated",
      data: { record: { collection: "thread" } },
    },
    {
      eventType: "spaceAttachment.deleted",
      data: { record: { collection: "thread" } },
    },
  ],
  async handle(event, context) {
    if (!event.durable) return;
    const threadId = record(record(event.data).record).recordId;
    if (typeof threadId !== "string" || !threadId) return;
    const thread = await context.collections.thread.get({ id: threadId });
    let after: string | undefined;
    while (true) {
      const page = await context.collections.spaceAttachment.list({
        where: { collection: "scheduled_job" },
        order: { field: "id", direction: "asc" },
        ...(after ? { after } : {}),
        limit: 200,
      });
      for (const attachment of page) {
        const spaceId = String(attachment.spaceId);
        const jobId = String(attachment.recordId);
        await context.transaction(async (tx) => {
          await tx.collections.space.commands.touch({ id: spaceId });
          const owner = await context.collections.spaceAttachment.get({
            id: attachment.id,
          });
          if (owner?.spaceId !== spaceId) return;
          const job = await context.collections.scheduledJob.get({ id: jobId });
          if (job?.status !== "active") return;
          const payload = record(job.payload);
          if (payload.type !== CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE) return;
          const target = record(payload.thread);
          if (
            target.id
              ? target.id !== threadId
              : !thread?.externalId || target.externalId !== thread.externalId
          ) return;
          const current = await context.collections.spaceAttachment.get({
            id: spaceAttachmentId("thread", threadId),
          });
          if (current?.spaceId === spaceId) return;
          await tx.collections.scheduledJob.update({
            id: jobId,
            set: {
              status: "paused",
              nextRunAt: null,
              nextRunAtMs: null,
              metadata: {
                ...record(job.metadata),
                scheduledPause: {
                  reason: "target_thread_left_space",
                  threadId,
                  fromSpaceId: spaceId,
                  at: context.now().toISOString(),
                },
              },
            },
          });
        }, { operationKey: `pause-space-job:${jobId}` });
      }
      if (page.length < 200) return;
      after = page[page.length - 1].id;
    }
  },
});

export default pauseSpaceJobsProcessor;
