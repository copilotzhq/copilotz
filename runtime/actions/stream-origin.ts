/** Recovers transient Action context from existing Events, without changing stream storage. @module */
import type { CopilotzEngineDatabaseScope } from "../engine/types.ts";
import type { StreamOutput } from "../streams/types.ts";

export function createStreamOriginResolver(
  runtime: Pick<CopilotzEngineDatabaseScope, "events" | "operations">,
  namespace: string,
  signal: AbortSignal,
) {
  const origins = new Map<string, Record<string, unknown> | undefined>();
  return async (
    operationId: string,
    output: StreamOutput,
  ): Promise<StreamOutput> => {
    const runId = output.metadata.sourceActionRunId;
    if (typeof runId !== "string" || runId.trim().length === 0) return output;
    const key = JSON.stringify([operationId, runId]);
    if (!origins.has(key)) {
      // Bound cache memory, not the lifetime number of Actions in a long run.
      if (origins.size >= 256) origins.delete(origins.keys().next().value!);
      signal.throwIfAborted();
      // Action receipts use this durable identity for invocation and retries.
      // Keep operation membership authoritative and use a scoped fallback for
      // older Events without the canonical receipt identity.
      const eventId = await runtime.operations.findEventId({
        namespace,
        operationId,
        subjectId: runId,
        typeSuffix: ".invoked",
        deduplicationId: `${runId}:action:invoked`,
      });
      let origin: Record<string, unknown> | undefined;
      if (eventId) {
        signal.throwIfAborted();
        // The ordinary resolver returns the public projection of protected
        // Action inputs. Never hydrate secrets for observation.
        const resolved = await runtime.events.resolve(namespace, eventId);
        const data = resolved?.data as Record<string, unknown> | undefined;
        if (data?.actionRunId === runId) {
          origin = { actionRunId: runId, metadata: data.metadata };
        }
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
