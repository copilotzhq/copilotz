/** Restores admitted outcomes from lifecycle Events and retained mutation failures. @module */
import type {
  ActionEventData,
  SerializedActionError,
} from "../../actions/index.ts";
import type {
  ApplicationScope,
  InternalCopilotzApplication,
} from "../types.ts";
import { SERVER_INVOKE_ACTION_ID } from "./invoke-action.ts";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
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
      status: "failed";
      error: Readonly<{
        name: string;
        message: string;
      }>;
    }>
  );
function actionTerminal(
  output: unknown,
  requestId: string,
  targetActionId: string,
): ServerInvokeTerminal | undefined {
  if (!output || typeof output !== "object") {
    return undefined;
  }
  const event = output as Record<string, unknown>;
  if (event.type !== `${SERVER_INVOKE_ACTION_ID}.completed`) {
    return undefined;
  }
  const data = record(event.data) as Partial<ActionEventData>;
  if (data.status !== "completed") {
    return undefined;
  }
  const input = record(data.input);
  if (input.requestId !== requestId) {
    return undefined;
  }
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
    return ({
      status: "failed",
      wrapperActionRunId,
      targetActionRunId:
        `${wrapperActionRunId}/action:${targetActionId}:target`,
      error: {
        name: text(error.name) ?? "Error",
        message: text(error.message) ?? "Action execution failed.",
      } as const,
    } as const);
  }
  return undefined;
}
async function recoverActionTerminal(
  application: InternalCopilotzApplication,
  context: ApplicationScope,
  eventId: string,
  requestId: string,
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
  const requestEvent = await scope.events.get(namespace, eventId);
  if (!requestEvent) {
    return undefined;
  }
  let afterPosition: string | undefined;
  while (true) {
    const events = await scope.events.list({
      namespace,
      correlationId: requestEvent.correlationId,
      ...(afterPosition ? { afterPosition } : {}),
      limit: 1000,
    });
    for (const event of events) {
      if (event.type !== `${SERVER_INVOKE_ACTION_ID}.completed`) {
        continue;
      }
      const resolved = await scope.events.resolve(namespace, event.id);
      const terminal = resolved &&
        actionTerminal(resolved, requestId, targetActionId);
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
  requestEventId: string,
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
  const requestEvent = await scope.events.get(namespace, requestEventId);
  if (!requestEvent) {
    return undefined;
  }
  let afterPosition: string | undefined;
  while (true) {
    const events = await scope.events.list({
      namespace,
      correlationId: requestEvent.correlationId,
      ...(afterPosition ? { afterPosition } : {}),
      limit: 1000,
    });
    for (const event of events) {
      if (
        event.subject?.id !== terminal.targetActionRunId ||
        event.subject.type !== targetActionId
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
  const status = await application.operationStatus({
    operationId,
    namespace: context.namespace,
    databaseSchema: context.databaseSchema,
  });
  if (!status) {
    throw appError(404, "operation_not_found", "Operation was not found.");
  }
  const pending = (): RecordedOperationResult => ({
    kind: event?.type === SERVER_ACTION_REQUEST_EVENT_TYPE ? "action" : "event",
    pending: true,
    value: { status: status.state },
  });
  const scoped = context.databaseSchema &&
      context.databaseSchema !== application.config.databaseSchema
    ? await application.databaseScope(context.databaseSchema)
    : application;
  const event = await scoped.events.resolve(status.namespace, operationId);
  const collectionResult = await collectionMutationResult(
    application,
    context,
    operationId,
    audience,
  );
  if (collectionResult) return collectionResult;
  if (event?.type !== SERVER_ACTION_REQUEST_EVENT_TYPE) {
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
  const terminal = await recoverActionTerminal(
    application,
    context,
    operationId,
    request.requestId,
    action.id,
  );
  if (!terminal) {
    if (status.state === "accepted" || status.state === "running") {
      return pending();
    }
    throw appError(409, "action_not_completed", "Action did not complete.");
  }
  const target = await recoverTargetActionTerminal(
    application,
    context,
    operationId,
    action.id,
    terminal,
  );
  if (target?.status === "failed" || target?.status === "cancelled") {
    throw actionFailure(target.error, audience);
  }
  if (terminal.status === "failed") {
    // Older wrapper receipts and failures before target invocation still work.
    throw actionFailure(terminal.error, audience);
  }
  if (!target || target.status !== "completed") {
    throw appError(409, "action_not_completed", "Action did not complete.");
  }
  let afterStreamOrdinal: string | undefined;
  for (;;) {
    const streams = await scoped.operations.listStreams({
      namespace: status.namespace,
      operationId,
      afterStreamOrdinal,
      limit: 256,
    });
    if (
      streams.some((stream) =>
        stream.descriptor.metadata.sourceActionRunId ===
          terminal.targetActionRunId && stream.state !== "terminal"
      )
    ) {
      return pending();
    }
    if (streams.length < 256) {
      break;
    }
    afterStreamOrdinal = streams.at(-1)!.streamOrdinal;
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
