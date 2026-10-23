/** Bounded durable Action ancestry for domain output authorization. */
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
export function createHttpActionOrigins(
  runtime: Pick<InternalCopilotzApplication, "events" | "operations">,
  namespace: string,
) {
  const originCache = new Map<
    string,
    Promise<readonly Readonly<Record<string, unknown>>[]>
  >();
  const actionOrigins = (
    operationId: string,
    runId: string,
  ): Promise<readonly Readonly<Record<string, unknown>>[]> => {
    const key = JSON.stringify([operationId, runId]);
    const existing = originCache.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const result: Readonly<Record<string, unknown>>[] = [];
      const seen = new Set<string>();
      let next: string | undefined = runId;
      while (next) {
        if (seen.has(next) || seen.size >= 64) {
          throw Object.assign(new Error("Action origin is unavailable."), {
            code: "invalid_action_origin",
            status: 403,
          });
        }
        seen.add(next);
        const eventId = await runtime.operations.findEventId({
          namespace,
          operationId,
          subjectId: next,
          typeSuffix: ".invoked",
          deduplicationId: `${next}:action:invoked`,
        });
        if (!eventId) {
          throw Object.assign(new Error("Action origin is unavailable."), {
            code: "invalid_action_origin",
            status: 403,
          });
        }
        const event = await runtime.events.resolve(namespace, eventId);
        const data = event?.data as Record<string, unknown> | undefined;
        if (!data || data.actionRunId !== next) {
          throw Object.assign(new Error("Action origin is unavailable."), {
            code: "invalid_action_origin",
            status: 403,
          });
        }
        result.push(data);
        next = typeof data.parentActionRunId === "string"
          ? data.parentActionRunId
          : undefined;
      }
      return result;
    })();
    if (originCache.size >= 256) {
      originCache.delete(originCache.keys().next().value!);
    }
    originCache.set(key, pending);
    return pending;
  };
  return actionOrigins;
}
