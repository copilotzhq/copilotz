/** Recovers transient Action context from existing Events, without changing stream storage. @module */
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import type { StreamOutput } from "../runtime/streams/types.ts";

export function createStreamOriginResolver(
  runtime: Pick<InternalCopilotzApplication, "events" | "operations">,
  namespace: string,
  signal: AbortSignal,
) {
  const origins = new Map<string, Record<string, unknown> | undefined>();
  return async (
    operationId: string,
    output: StreamOutput,
  ): Promise<StreamOutput> => {
    const runId = output.metadata.sourceActionRunId;
    if (typeof runId !== "string") return output;
    const key = JSON.stringify([operationId, runId]);
    if (!origins.has(key)) {
      if (origins.size >= 256) {
        throw Object.assign(
          new Error("Observation exceeds 256 stream origins."),
          {
            status: 409,
            code: "operation_replay_capacity_exceeded",
          },
        );
      }
      let afterPosition: string | undefined;
      let origin: Record<string, unknown> | undefined;
      search: while (true) {
        signal.throwIfAborted();
        const entries = await runtime.operations.listEventIds({
          namespace,
          operationId,
          afterPosition,
          limit: 250,
        });
        for (const entry of entries) {
          signal.throwIfAborted();
          const event = await runtime.events.get(namespace, entry.eventId);
          if (event?.subject?.id === runId && event.type.endsWith(".invoked")) {
            // The ordinary resolver returns the public projection of protected
            // Action inputs. Never hydrate secrets for observation.
            const resolved = await runtime.events.resolve(
              namespace,
              entry.eventId,
            );
            const data = resolved?.data as Record<string, unknown> | undefined;
            if (data?.actionRunId === runId) {
              origin = { actionRunId: runId, metadata: data.metadata };
            }
            break search;
          }
        }
        if (entries.length < 250) break;
        afterPosition = entries.at(-1)!.position;
      }
      origins.set(key, origin);
    }
    const sourceAction = origins.get(key);
    return sourceAction
      ? {
        ...output,
        metadata: { ...output.metadata, sourceAction },
      }
      : output;
  };
}
