import { parseActionLifecycleEvent } from "../../actions/event.ts";
import { standardActionError } from "../../actions/errors.ts";
/** Restores admitted outcomes from lifecycle Events and retained mutation failures. @module */
import type { DurableEvent } from "../../events/index.ts";
import type {
  ActionEventData,
  SerializedActionError,
} from "../../actions/index.ts";
import type {
  ApplicationScope,
  InternalCopilotzApplication,
} from "../types.ts";
// Retained pre-consolidation receipts remain readable after an upgrade.
const SERVER_INVOKE_ACTION_ID = "copilotz.server.internal.invoke";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
  serverActionRunId,
  type ServerCollectionMutationRequest,
} from "./contracts.ts";
export type RecordedOperationResult = Readonly<
  { kind: "action" | "collection" | "event"; pending: boolean; value: unknown }
>;
function appError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
type TargetIdentity = Readonly<
  { wrapperActionRunId: string; targetActionRunId: string }
>;
type ServerInvokeTerminal =
  & TargetIdentity
  & (
    | Readonly<{
      status: "completed";
    }>
    | Readonly<{
      status: "failed" | "cancelled";
      error: SerializedActionError;
    }>
  );
function actionTerminal(
  output: unknown,
  requestEvent: DurableEvent,
  requestId: string,
  actionAlias: string,
  targetActionId: string,
): ServerInvokeTerminal | undefined {
  if (!output || typeof output !== "object") return undefined;
  const event = output as DurableEvent & { data?: unknown };
  const data = parseActionLifecycleEvent(event, {
    actionId: SERVER_INVOKE_ACTION_ID,
    statuses: ["completed", "failed", "cancelled"],
    requireRoot: true,
  });
  if (
    !data || event.namespace !== requestEvent.namespace ||
    event.correlationId !== requestEvent.correlationId ||
    event.metadata.sourceEventId !== requestEvent.id ||
    event.causationId !== requestEvent.id
  ) return undefined;
  const input = record(data.input);
  if (
    Object.keys(input).length !== 2 || input.requestId !== requestId ||
    input.actionAlias !== actionAlias
  ) return undefined;
  if (data.status === "failed" || data.status === "cancelled") {
    return {
      status: data.status,
      wrapperActionRunId: data.actionRunId,
      targetActionRunId: `${data.actionRunId}/action:${targetActionId}:target`,
      error: data.error,
    };
  }
  if (data.status !== "completed") return undefined;
  const result = record(data.output);
  if (result.status === "completed") {
    const targetActionRunId = text(result.targetActionRunId);
    const wrapperActionRunId = text(data.actionRunId);
    if (
      !targetActionRunId || !wrapperActionRunId ||
      targetActionRunId !==
        `${wrapperActionRunId}/action:${targetActionId}:target`
    ) {
      return undefined;
    }
    return ({
      status: "completed",
      wrapperActionRunId,
      targetActionRunId,
    } as const);
  }
  if (result.status === "failed") {
    const wrapperActionRunId = text(data.actionRunId);
    if (!wrapperActionRunId) return undefined;
    const error = record(result.error);
    const safe = error.callerSafe === true
      ? standardActionError(error)
      : undefined;
    return ({
      status: "failed",
      wrapperActionRunId,
      targetActionRunId:
        `${wrapperActionRunId}/action:${targetActionId}:target`,
      error: {
        name: text(error.name) ?? "Error",
        message: safe?.message ?? text(error.message) ??
          "Action execution failed.",
        ...(safe
          ? { code: safe.code, status: safe.status, callerSafe: true as const }
          : {}),
      } as const,
    } as const);
  }
  return undefined;
}
async function recoverActionTerminal(
  application: InternalCopilotzApplication,
  context: ApplicationScope,
  requestEvent: DurableEvent,
  requestId: string,
  actionAlias: string,
  targetActionId: string,
): Promise<ServerInvokeTerminal | undefined> {
  const namespace = context.namespace ?? application.config.namespace;
  if (!namespace) {
    return undefined;
  }
  const databaseSchema = context.databaseSchema ??
    application.config.databaseSchema;
  const scope = databaseSchema === application.config.databaseSchema
    ? application
    : await application.databaseScope(databaseSchema);
  let afterPosition: string | undefined = requestEvent.position;
  while (true) {
    const events = await scope.events.list({
      namespace,
      correlationId: requestEvent.correlationId,
      metadata: { actionId: SERVER_INVOKE_ACTION_ID },
      ...(afterPosition ? { afterPosition } : {}),
      limit: 1000,
    });
    for (const event of events) {
      const resolved = await scope.events.resolve(namespace, event.id);
      const terminal = resolved &&
        actionTerminal(
          resolved,
          requestEvent,
          requestId,
          actionAlias,
          targetActionId,
        );
      if (terminal) {
        return terminal;
      }
    }
    if (events.length < 1000) {
      return undefined;
    }
    const next = events.at(-1)?.position;
    if (!next || next === afterPosition) {
      return undefined;
    }
    afterPosition = next;
  }
}
async function recoverTargetActionTerminal(
  application: InternalCopilotzApplication,
  context: ApplicationScope,
  requestEvent: DurableEvent,
  targetActionId: string,
  terminal: TargetIdentity,
): Promise<ActionEventData | undefined> {
  const namespace = context.namespace ?? application.config.namespace;
  if (!namespace) {
    return undefined;
  }
  const databaseSchema = context.databaseSchema ??
    application.config.databaseSchema;
  const scope = databaseSchema === application.config.databaseSchema
    ? application
    : await application.databaseScope(databaseSchema);
  let afterPosition: string | undefined = requestEvent.position;
  while (true) {
    const events = await scope.events.list({
      namespace,
      correlationId: requestEvent.correlationId,
      metadata: { actionId: targetActionId },
      ...(afterPosition ? { afterPosition } : {}),
      limit: 1000,
    });
    for (const event of events) {
      if (
        event.subject?.id !== terminal.targetActionRunId ||
        event.subject.type !== targetActionId ||
        !["completed", "failed", "cancelled"].some((status) =>
          event.type === `${targetActionId}.${status}`
        )
      ) {
        continue;
      }
      const data = await scope.events.resolveActionLifecycle(
        namespace,
        event.id,
      );
      if (
        !data || data.actionRunId !== terminal.targetActionRunId ||
        data.actionId !== targetActionId ||
        data.parentActionRunId !== terminal.wrapperActionRunId
      ) {
        continue;
      }
      if (
        data.status === "completed" || data.status === "failed" ||
        data.status === "cancelled"
      ) {
        return data;
      }
    }
    if (events.length < 1000) {
      return undefined;
    }
    const next = events.at(-1)?.position;
    if (!next || next === afterPosition) {
      return undefined;
    }
    afterPosition = next;
  }
}
export async function collectionMutationResult(
  application: InternalCopilotzApplication,
  context: ApplicationScope,
  operationId: string,
  audience: "http" | "host" = "http",
): Promise<RecordedOperationResult | undefined> {
  const status = await application.operationStatus({
    operationId,
    namespace: context.namespace,
    databaseSchema: context.databaseSchema,
  });
  if (!status) {
    throw appError(404, "operation_not_found", "Operation was not found.");
  }
  const scope = context.databaseSchema &&
      context.databaseSchema !== application.config.databaseSchema
    ? await application.databaseScope(context.databaseSchema)
    : application;
  const root = await scope.events.resolve(status.namespace, operationId);
  if (root?.type !== SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE) {
    return undefined;
  }
  const request = root.data as ServerCollectionMutationRequest;
  if (status.state === "accepted" || status.state === "running") {
    await scope.events.outstanding(status.namespace, operationId);
    return {
      kind: "collection",
      pending: true,
      value: { status: status.state },
    };
  }
  if (status.state !== "completed") {
    // Dead letters are retained by delivery compaction. Read only the target
    // mutation delivery, never a descendant or another correlated request.
    const [delivery] = await scope.deliveries.list({
      namespace: status.namespace,
      eventId: operationId,
      consumerId: "processor:copilotz.server.collection-mutation-request",
      status: "dead_letter",
      limit: 1,
    });
    const error = delivery?.lastError;
    if (error && typeof error.message === "string") {
      if (
        error.code === "collection_validation_failed" &&
        error.name === "CollectionValidationError"
      ) {
        throw Object.assign(new TypeError(error.message), {
          name: error.name,
          code: error.code,
          status: 422,
        });
      }
      if (audience === "host") {
        throw Object.assign(new Error(error.message), {
          name: text(error.name) ?? "Error",
          ...(typeof error.code === "string" ? { code: error.code } : {}),
        });
      }
    }
    throw appError(
      422,
      "collection_mutation_failed",
      "Collection mutation did not complete.",
    );
  }
  const definition = application.plugins.collections[request.collectionAlias];
  if (!definition) {
    throw appError(
      500,
      "collection_mutation_missing",
      "Collection mutation target is unavailable.",
    );
  }
  let afterPosition: string | undefined;
  while (true) {
    const events = await scope.events.list({
      namespace: status.namespace,
      correlationId: root.correlationId,
      ...(afterPosition ? { afterPosition } : {}),
      limit: 1000,
    });
    for (const event of events) {
      const metadata = event.metadata.copilotzServer;
      if (
        event.subject?.type !== definition.name || !metadata ||
        typeof metadata !== "object" ||
        (metadata as Record<string, unknown>).requestId !== request.requestId
      ) continue;
      const body = record(
        (await scope.events.resolve(status.namespace, event.id))?.data,
      );
      if (request.operation === "delete") {
        return {
          kind: "collection",
          pending: false,
          value: { id: request.id, deleted: true },
        };
      }
      return { kind: "collection", pending: false, value: body.record };
    }
    if (events.length < 1000) break;
    afterPosition = events.at(-1)?.position;
  }
  throw appError(
    409,
    "collection_mutation_not_completed",
    "Collection mutation result is unavailable.",
  );
}
export async function recordedOperationResult(
  application: InternalCopilotzApplication,
  context: ApplicationScope,
  operationId: string,
  audience: "http" | "host" = "http",
): Promise<RecordedOperationResult> {
  let refusal: unknown;
  try {
    return await readRecordedOperationResult(
      application,
      context,
      operationId,
      audience,
      (error) => {
        refusal = error;
      },
    );
  } catch (error) {
    if (refusal === undefined || error !== refusal) throw error;
  }
  // An accepted Action result can race the pending lookup while a different
  // joined obligation remains open. Re-read once through the same authority;
  // this never retries execution, changes identity, or settles an obligation.
  let repeatedRefusal: unknown;
  try {
    return await readRecordedOperationResult(
      application,
      context,
      operationId,
      audience,
      (error) => {
        repeatedRefusal = error;
      },
    );
  } catch (error) {
    throw repeatedRefusal !== undefined && error === repeatedRefusal
      ? refusal
      : error;
  }
}

async function readRecordedOperationResult(
  application: InternalCopilotzApplication,
  context: ApplicationScope,
  operationId: string,
  audience: "http" | "host",
  onPendingRefusal: (error: unknown) => void,
): Promise<RecordedOperationResult> {
  const notePendingRefusal = (error: unknown) => {
    const typed = error as { code?: unknown; status?: unknown } | null;
    if (
      error instanceof Error &&
      typed?.code === "operation_result_unavailable" &&
      typed.status === 409 &&
      error.message === "Operation result is unavailable."
    ) {
      onPendingRefusal(error);
    }
    throw error;
  };
  const status = await application.operationStatus({
    operationId,
    namespace: context.namespace,
    databaseSchema: context.databaseSchema,
  });
  if (!status) {
    throw appError(404, "operation_not_found", "Operation was not found.");
  }
  const scoped = context.databaseSchema &&
      context.databaseSchema !== application.config.databaseSchema
    ? await application.databaseScope(context.databaseSchema)
    : application;
  const pending = async (): Promise<RecordedOperationResult> => {
    await scoped.events.outstanding(status.namespace, operationId).catch(
      notePendingRefusal,
    );
    return {
      kind: event?.type === SERVER_ACTION_REQUEST_EVENT_TYPE
        ? "action"
        : "event",
      pending: true,
      value: { status: status.state },
    };
  };
  const event = await scoped.events.resolve(status.namespace, operationId);
  if (event?.type === SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE) {
    const collectionResult = await collectionMutationResult(
      application,
      context,
      operationId,
      audience,
    ).catch(notePendingRefusal);
    if (collectionResult) return collectionResult;
  }
  if (event?.type !== SERVER_ACTION_REQUEST_EVENT_TYPE || !event.durable) {
    if (status.state === "accepted" || status.state === "running") {
      return pending();
    }
    return {
      kind: "event",
      pending: false,
      value: { status: status.state },
    };
  }
  const request = record(event.data);
  const action = application.plugins.actions[String(request.actionAlias)];
  if (!action || typeof request.requestId !== "string") {
    throw appError(
      500,
      "action_result_missing",
      "Action request is unavailable.",
    );
  }
  const direct = await recoverDirectActionTerminal(
    application,
    context,
    event,
    action.id,
  );
  if (direct) {
    if (direct.status === "failed" || direct.status === "cancelled") {
      throw actionFailure(direct.error, audience);
    }
    if (direct.status === "completed") {
      return { kind: "action", pending: false, value: direct.output };
    }
  }
  const terminal = await recoverActionTerminal(
    application,
    context,
    event,
    request.requestId,
    String(request.actionAlias),
    action.id,
  );
  if (!terminal) {
    if (status.state === "accepted" || status.state === "running") {
      return pending();
    }
    const [delivery] = await scoped.deliveries.list({
      namespace: status.namespace,
      eventId: event.id,
      consumerId: "processor:copilotz.server.action-request",
      status: "dead_letter",
      limit: 1,
    });
    const refusal = delivery?.lastError;
    if (refusal?.callerSafe === true) {
      const safe = standardActionError(refusal);
      if (safe) {
        throw actionFailure({
          name: safe.name,
          message: safe.message,
          code: safe.code,
          status: safe.status,
          callerSafe: true,
        }, audience);
      }
    }

    if (delivery) {
      throw appError(422, "action_failed", "Action execution failed.");
    }
    throw appError(409, "action_not_completed", "Action did not complete.");
  }
  const target = await recoverTargetActionTerminal(
    application,
    context,
    event,
    action.id,
    terminal,
  );
  if (target?.status === "failed" || target?.status === "cancelled") {
    throw actionFailure(target.error, audience);
  }
  if (terminal.status !== "completed") {
    // The current invocation bridge can fail admission before a target lifecycle
    // exists; its retained standard failure is the authoritative result.
    throw actionFailure(terminal.error, audience);
  }
  if (!target || target.status !== "completed") {
    if (status.state === "accepted" || status.state === "running") {
      return pending();
    }
    throw appError(409, "action_not_completed", "Action did not complete.");
  }
  return {
    kind: "action",
    pending: false,
    value: target.output,
  };
}

function actionFailure(
  error: SerializedActionError,
  audience: "http" | "host",
): Error {
  if (audience === "host") {
    return Object.assign(new Error(error.message), {
      name: error.name,
      ...(error.code === undefined ? {} : { code: error.code }),
    });
  }
  if (error.callerSafe === true) {
    return Object.assign(
      appError(error.status ?? 422, error.code!, error.message),
      {
        name: error.name,
      },
    );
  }
  return appError(422, "action_failed", "Action execution failed.");
}

/** Direct roots are fixed by source and parent identity, never caller metadata. */
async function recoverDirectActionTerminal(
  application: InternalCopilotzApplication,
  context: ApplicationScope,
  request: DurableEvent,
  actionId: string,
): Promise<ActionEventData | undefined> {
  const scope = context.databaseSchema &&
      context.databaseSchema !== application.config.databaseSchema
    ? await application.databaseScope(context.databaseSchema)
    : application;
  let afterPosition = request.position;
  let runId: string | undefined;
  for (;;) {
    const events = await scope.events.list({
      namespace: request.namespace,
      correlationId: request.correlationId,
      metadata: { actionId },
      afterPosition,
      limit: 1000,
    });
    for (const event of events) {
      const directSource = event.namespace === request.namespace &&
        event.correlationId === request.correlationId &&
        event.subject?.type === actionId &&
        event.causationId === request.id &&
        event.metadata.sourceEventId === request.id &&
        event.subject?.id ===
          serverActionRunId(
            String(event.metadata.sourceDeliveryId),
            actionId,
            String(
              record((request as DurableEvent & { data?: unknown }).data)
                .requestId,
            ),
          );
      if (event.type === `${actionId}.invoked` && directSource) {
        runId = event.subject?.id;
      }
      if (!runId && directSource && event.type === `${actionId}.failed`) {
        // A current-policy refusal can precede input capture. Only its exact
        // source-bound root run and sanitized, input-free refusal are readable
        // without an invoked event; this cannot grant a successful result.
        const resolved = await scope.events.resolve(
          request.namespace,
          event.id,
        );
        const refusal = resolved && parseActionLifecycleEvent(resolved, {
          actionId,
          statuses: ["failed"],
          requireRoot: true,
        });
        if (
          refusal?.status === "failed" && !refusal.parentActionRunId &&
          refusal.actionRunId === event.subject?.id &&
          refusal.actionId === actionId && refusal.input === null &&
          refusal.error.code === "forbidden" &&
          refusal.error.status === 403 && refusal.error.callerSafe === true &&
          refusal.error.message === "Forbidden"
        ) return refusal;
      }
      if (
        !runId || event.subject?.id !== runId ||
        !["completed", "failed", "cancelled"].some((status) =>
          event.type === `${actionId}.${status}`
        )
      ) continue;
      const data = await scope.events.resolveActionLifecycle(
        request.namespace,
        event.id,
      );
      if (
        data && !data.parentActionRunId && data.actionId === actionId &&
        ["completed", "failed", "cancelled"].includes(data.status)
      ) return data;
    }
    if (events.length < 1000) return;
    afterPosition = events.at(-1)!.position;
  }
}
