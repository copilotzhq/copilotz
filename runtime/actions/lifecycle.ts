import type {
  ActionEventData,
  ActionLifecycleAppender,
  ActionLifecycleEmitter,
  ActionLifecycleInput,
  ActionLifecycleLoader,
  ActionStatus,
  SerializedActionError,
} from "./types.ts";
import { durableActionValue } from "./value.ts";

const ACTION_STATUSES = new Set<ActionStatus>([
  "invoked",
  "completed",
  "failed",
  "cancelled",
]);

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function safeError(error: SerializedActionError): SerializedActionError {
  const name = requireText(error.name, "Action error name");
  const message = requireText(error.message, "Action error message");
  const stack = optionalText(error.stack);
  return Object.freeze({ name, message, ...(stack ? { stack } : {}) });
}

function eventData(input: ActionLifecycleInput): ActionEventData {
  if (!ACTION_STATUSES.has(input.status)) {
    throw new TypeError(`Unsupported Action status '${input.status}'.`);
  }
  const base = {
    actionRunId: requireText(input.actionRunId, "Action run id"),
    actionId: requireText(input.actionId, "Action id"),
    ...(optionalText(input.parentActionRunId)
      ? { parentActionRunId: input.parentActionRunId!.trim() }
      : {}),
    input: durableActionValue(input.input),
  };
  switch (input.status) {
    case "invoked":
      return Object.freeze({ ...base, status: "invoked" });
    case "completed":
      return Object.freeze({
        ...base,
        status: "completed",
        output: durableActionValue(input.output),
      });
    case "failed":
    case "cancelled":
      return Object.freeze({
        ...base,
        status: input.status,
        error: safeError(input.error),
      });
  }
}

export function createActionLifecycleEmitter(
  input: Readonly<{
    namespace: string;
    append: ActionLifecycleAppender;
    load?: ActionLifecycleLoader;
    metadata?: Readonly<Record<string, unknown>>;
  }>,
): ActionLifecycleEmitter {
  const namespace = requireText(input.namespace, "Action namespace");
  const originMetadata = Object.freeze(structuredClone(input.metadata ?? {}));
  return Object.freeze({
    emit(event) {
      const data = eventData(event);
      return input.append({
        draft: {
          type: `${data.actionId}.${data.status}`,
          namespace,
          subject: { type: data.actionId, id: data.actionRunId },
          metadata: {
            ...structuredClone(originMetadata),
            actionId: data.actionId,
            actionStatus: data.status,
          },
          ...(optionalText(event.causationId)
            ? { causationId: event.causationId!.trim() }
            : {}),
          ...(optionalText(event.correlationId)
            ? { correlationId: event.correlationId!.trim() }
            : {}),
          deduplicationId: requireText(
            event.deduplicationId,
            "Action event deduplication id",
          ),
          ...(optionalText(event.settlementScopeId)
            ? { settlementScopeId: event.settlementScopeId!.trim() }
            : {}),
        },
        data,
      });
    },
    async terminal(actionRunId) {
      const id = requireText(actionRunId, "Action run id");
      if (!input.load) return null;
      for (const status of ["completed", "failed", "cancelled"] as const) {
        const data = await input.load(namespace, `${id}:action:${status}`);
        if (!data) continue;
        if (
          data.actionRunId !== id || data.status !== status ||
          data.actionId.trim().length === 0
        ) {
          throw new Error(`Action terminal event '${id}' is inconsistent.`);
        }
        return data;
      }
      return null;
    },
  });
}
