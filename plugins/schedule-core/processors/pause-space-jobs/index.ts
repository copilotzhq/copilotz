/** Pause Space-owned jobs when their target conversation leaves the Space. @module */
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE } from "../../shared/contracts.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function targetsThread(
  payload: Record<string, unknown>,
  threadId: string,
  externalId: string,
): boolean {
  const target = record(payload.thread);
  return target.id === threadId ||
    (!target.id && Boolean(externalId) && target.externalId === externalId);
}

export const pauseSpaceJobsProcessor: Processor = defineProcessor({
  id: "core-schedules.pause-space-jobs",
  on: [
    { eventType: "thread.updated" },
    { eventType: "thread.deleted" },
  ],
  async handle(event, context) {
    if (!event.durable) return;
    if (event.type === "thread.updated") {
      const body = record(event.data);
      const set = record(body.set);
      const unset = Array.isArray(body.unset) ? body.unset : [];
      if (!Object.hasOwn(set, "spaceId") && !unset.includes("spaceId")) {
        return;
      }
    }
    const eventThread = record(record(event.data).record);
    const threadId = text(eventThread.id);
    if (!threadId) return;
    const thread = await context.collections.thread.get({ id: threadId });
    const externalId = text(thread?.externalId) || text(eventThread.externalId);
    let after: string | undefined;
    while (true) {
      const page = await context.collections.scheduledJob.list({
        where: { status: "active" },
        order: { field: "id", direction: "asc" },
        after,
        limit: 200,
      });
      for (const candidate of page) {
        const spaceId = text(candidate.spaceId);
        if (
          !spaceId ||
          record(candidate.payload).type !==
            CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE ||
          !targetsThread(record(candidate.payload), threadId, externalId)
        ) continue;
        await context.transaction(async (tx) => {
          await tx.collections.space.commands.touch({ id: spaceId });
          const job = await context.collections.scheduledJob.get({
            id: candidate.id,
          });
          if (job?.status !== "active" || text(job.spaceId) !== spaceId) {
            return;
          }
          const currentThread = await context.collections.thread.get({
            id: threadId,
          });
          if (
            targetsThread(record(job.payload), threadId, externalId) &&
            text(currentThread?.spaceId) === spaceId
          ) return;
          await tx.collections.scheduledJob.update({
            id: candidate.id,
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
        }, { operationKey: `pause-space-job:${candidate.id}` });
      }
      if (page.length < 200) return;
      after = page[page.length - 1].id;
    }
  },
});

export default pauseSpaceJobsProcessor;
