import type {
  ActionEventData,
  ActionInvokedData,
  ActionLifecycleAppender,
  ActionLifecycleEmitter,
  ActionLifecycleInput,
  ActionLifecycleLoader,
  ActionStatus,
  SerializedActionError,
} from "./types.ts";
import { durableActionMetadata, durableActionValue } from "./value.ts";

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
  return ({ name, message } as const);
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
    metadata: durableActionMetadata(input.metadata),
    input: durableActionValue(input.input),
  };
  switch (input.status) {
    case "invoked":
      return ({ ...base, status: "invoked" } as const);
    case "progress": {
      if (
        !Number.isSafeInteger(input.progressIndex) || input.progressIndex < 1
      ) {
        throw new TypeError(
          "Action progress index must be a positive safe integer.",
        );
      }
      return ({
        ...base,
        status: "progress",
        progressIndex: input.progressIndex,
        progress: durableActionValue(input.progress),
      } as const);
    }
    case "completed":
      return ({
        ...base,
        status: "completed",
        output: durableActionValue(input.output),
      } as const);
    case "failed":
    case "cancelled":
      return ({
        ...base,
        status: input.status,
        error: safeError(input.error),
      } as const);
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
  const originMetadata = structuredClone(input.metadata ?? {});
  const load = async (
    actionRunId: string,
    suffix: "invoked" | "terminal",
  ): Promise<ActionEventData | null> => {
    const id = requireText(actionRunId, "Action run id");
    if (!input.load) return null;
    const data = await input.load(namespace, `${id}:action:${suffix}`);
    if (!data) return null;
    if (data.actionRunId !== id || data.actionId.trim().length === 0) {
      throw new Error(`Action ${suffix} event '${id}' is inconsistent.`);
    }
    return data;
  };
  return ({
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
    async invoked(actionRunId): Promise<ActionInvokedData | null> {
      const data = await load(actionRunId, "invoked");
      if (!data) return null;
      if (data.status !== "invoked") {
        throw new Error(
          `Action invoked event '${data.actionRunId}' is inconsistent.`,
        );
      }
      return data;
    },
    async terminal(actionRunId) {
      const data = await load(actionRunId, "terminal");
      if (!data) return null;
      if (
        (data.status !== "completed" && data.status !== "failed" &&
          data.status !== "cancelled")
      ) {
        throw new Error(
          `Action terminal event '${data.actionRunId}' is inconsistent.`,
        );
      }
      return data;
    },
  } as const);
}
