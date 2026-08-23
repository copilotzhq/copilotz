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
  "progress",
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
  return Object.freeze({ name, message });
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
    case "progress": {
      if (
        !Number.isSafeInteger(input.progressIndex) || input.progressIndex < 1
      ) {
        throw new TypeError(
          "Action progress index must be a positive safe integer.",
        );
      }
      return Object.freeze({
        ...base,
        status: "progress",
        progressIndex: input.progressIndex,
        progress: durableActionValue(input.progress),
      });
    }
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
      const data = await input.load(namespace, `${id}:action:terminal`);
      if (!data) return null;
      if (
        data.actionRunId !== id ||
        (data.status !== "completed" && data.status !== "failed" &&
          data.status !== "cancelled") ||
        data.actionId.trim().length === 0
      ) {
        throw new Error(`Action terminal event '${id}' is inconsistent.`);
      }
      return data;
    },
  });
}
