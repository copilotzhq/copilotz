import { constrainInput } from "./input.ts";
import { admitHttpOperation } from "./admission.ts";
/** Durable Action ingress and authorized result recovery. @module */
import { validateAgainstJsonSchema } from "../runtime/collections/validate.ts";
import type { ActionEventData } from "@copilotz/copilotz/actions";
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import { SERVER_INVOKE_ACTION_ID } from "../plugins/server/actions/invoke-action/index.ts";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_ACTION_REQUEST_SCHEMA,
  serverActionRequestSchema,
  type ServerEndpointDescriptor,
} from "../plugins/server/internal/contracts.ts";
import type { HttpRequest, HttpResponse } from "./http-types.ts";
import type { FacadeContext } from "./context.ts";

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

function header(
  headers: HttpRequest["headers"],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower && value.trim()) return value.trim();
  }
  return undefined;
}

type ServerInvokeTerminal =
  | Readonly<{
    status: "completed";
    wrapperActionRunId: string;
    targetActionRunId: string;
  }>
  | Readonly<{
    status: "failed";
    error: Readonly<{ name: string; message: string }>;
  }>;

function actionTerminal(
  output: unknown,
  requestId: string,
  targetActionId: string,
): ServerInvokeTerminal | undefined {
  if (!output || typeof output !== "object") return undefined;
  const event = output as Record<string, unknown>;
  if (event.type !== `${SERVER_INVOKE_ACTION_ID}.completed`) return undefined;
  const data = record(event.data) as Partial<ActionEventData>;
  if (data.status !== "completed") return undefined;
  const input = record(data.input);
  if (input.requestId !== requestId) return undefined;
  const result = record(data.output);
  if (result.status === "completed") {
    const targetActionRunId = text(result.targetActionRunId);
    const wrapperActionRunId = text(data.actionRunId);
    if (
      !targetActionRunId || !wrapperActionRunId ||
      targetActionRunId !==
        `${wrapperActionRunId}/action:${targetActionId}:target`
    ) return undefined;
    return Object.freeze({
      status: "completed",
      wrapperActionRunId,
      targetActionRunId,
    });
  }
  if (result.status === "failed") {
    const error = record(result.error);
    return Object.freeze({
      status: "failed",
      error: Object.freeze({
        name: text(error.name) ?? "Error",
        message: text(error.message) ?? "Action execution failed.",
      }),
    });
  }
  return undefined;
}

async function recoverActionTerminal(
  application: InternalCopilotzApplication,
  context: FacadeContext,
  eventId: string,
  requestId: string,
  targetActionId: string,
): Promise<ServerInvokeTerminal | undefined> {
  const namespace = context.namespace ?? application.config.namespace;
  if (!namespace) return undefined;
  const databaseSchema = context.databaseSchema ??
    application.config.databaseSchema;
  const scope = databaseSchema === application.config.databaseSchema
    ? application
    : await application.databaseScope(databaseSchema);
  const requestEvent = await scope.events.get(namespace, eventId);
  if (!requestEvent) return undefined;

  let afterPosition: string | undefined;
  while (true) {
    const events = await scope.events.list({
      namespace,
      correlationId: requestEvent.correlationId,
      ...(afterPosition ? { afterPosition } : {}),
      limit: 1_000,
    });
    for (const event of events) {
      if (event.type !== `${SERVER_INVOKE_ACTION_ID}.completed`) continue;
      const resolved = await scope.events.resolve(namespace, event.id);
      const terminal = resolved &&
        actionTerminal(resolved, requestId, targetActionId);
      if (terminal) return terminal;
    }
    if (events.length < 1_000) return undefined;
    const next = events.at(-1)?.position;
    if (!next || next === afterPosition) return undefined;
    afterPosition = next;
  }
}

async function recoverTargetActionTerminal(
  application: InternalCopilotzApplication,
  context: FacadeContext,
  requestEventId: string,
  targetActionId: string,
  terminal: Extract<ServerInvokeTerminal, { status: "completed" }>,
): Promise<ActionEventData | undefined> {
  const namespace = context.namespace ?? application.config.namespace;
  if (!namespace) return undefined;
  const databaseSchema = context.databaseSchema ??
    application.config.databaseSchema;
  const scope = databaseSchema === application.config.databaseSchema
    ? application
    : await application.databaseScope(databaseSchema);
  const requestEvent = await scope.events.get(namespace, requestEventId);
  if (!requestEvent) return undefined;

  let afterPosition: string | undefined;
  while (true) {
    const events = await scope.events.list({
      namespace,
      correlationId: requestEvent.correlationId,
      ...(afterPosition ? { afterPosition } : {}),
      limit: 1_000,
    });
    for (const event of events) {
      if (
        event.subject?.id !== terminal.targetActionRunId ||
        event.subject.type !== targetActionId
      ) continue;
      const data = await scope.events.resolveActionLifecycle(
        namespace,
        event.id,
      );
      if (
        !data || data.actionRunId !== terminal.targetActionRunId ||
        data.actionId !== targetActionId ||
        data.parentActionRunId !== terminal.wrapperActionRunId
      ) continue;
      if (
        data.status === "completed" || data.status === "failed" ||
        data.status === "cancelled"
      ) return data;
    }
    if (events.length < 1_000) return undefined;
    const next = events.at(-1)?.position;
    if (!next || next === afterPosition) return undefined;
    afterPosition = next;
  }
}

export async function actionResponse(
  application: InternalCopilotzApplication,
  endpoint: ServerEndpointDescriptor,
  request: HttpRequest,
  context: FacadeContext,
): Promise<HttpResponse> {
  const input = constrainInput(
    request.body === undefined ? {} : request.body,
    context.serverConstraints.input,
  );
  if (endpoint.inputSchema) {
    try {
      validateAgainstJsonSchema(endpoint.inputSchema, input, "Action input");
    } catch {
      throw appError(
        400,
        "invalid_input",
        "Request does not match the Action schema.",
      );
    }
  }
  const requestId = header(request.headers, "idempotency-key");
  if (!requestId) {
    throw appError(
      400,
      "idempotency_key_required",
      "Idempotency-Key is required.",
    );
  }
  context = await admitHttpOperation(application, context, requestId);
  const correlationId = context.serverIdentity.correlationId ??
    header(request.headers, "x-copilotz-correlation-id") ??
    `server:${requestId}`;
  const handle = await application.sendProtected(
    {
      type: SERVER_ACTION_REQUEST_EVENT_TYPE,
      payload: Object.freeze({
        schema: SERVER_ACTION_REQUEST_SCHEMA,
        requestId,
        actionAlias: endpoint.actionAlias!,
        input,
        actionMetadata: context.serverActionMetadata,
      }),
      namespace: context.namespace,
      databaseSchema: context.databaseSchema,
      correlationId,
      causationId: context.serverIdentity.causationId,
      deduplicationId: context.serverIdentity.deduplicationId ??
        header(request.headers, "idempotency-key") ?? requestId,
      metadata: Object.freeze({ sourceAdapter: "server" }),
      operationMetadata: {
        ...context.operationMetadata,
        ...(context.serverScope.actor
          ? { actorId: context.serverScope.actor.id }
          : {}),
      },
      visibility: { kind: "internal" },
    },
    serverActionRequestSchema(endpoint.inputSchema),
    `server:${requestId}`,
  ).catch((error) => {
    if (error?.code === "event_deduplication_conflict") {
      throw appError(
        409,
        "idempotency_conflict",
        "Idempotency key was reused with different input.",
      );
    }
    throw error;
  });
  const status = await application.operationStatus({
    operationId: handle.operationId,
    namespace: context.namespace,
    databaseSchema: context.databaseSchema,
  });
  await handle.detach("http_receipt_returned");
  return {
    status: 202,
    data: {
      operationId: handle.operationId,
      correlationId: handle.correlationId,
      status: status?.state ?? "accepted",
      checkpoint: handle.replayCursor,
      acceptedAt: status?.acceptedAt,
    },
  };
}

export async function operationResult(
  application: InternalCopilotzApplication,
  context: FacadeContext,
  operationId: string,
): Promise<HttpResponse> {
  const status = await application.operationStatus({
    operationId,
    namespace: context.namespace,
    databaseSchema: context.databaseSchema,
  });
  if (!status) {
    throw appError(404, "operation_not_found", "Operation was not found.");
  }
  const pending = (): HttpResponse => ({
    status: 202,
    headers: { "cache-control": "no-store" },
    data: { status: status.state },
  });
  const scoped = context.databaseSchema &&
      context.databaseSchema !== application.config.databaseSchema
    ? await application.databaseScope(context.databaseSchema)
    : application;
  const event = await scoped.events.resolve(status.namespace, operationId);
  if (event?.type !== SERVER_ACTION_REQUEST_EVENT_TYPE) {
    if (status.state === "accepted" || status.state === "running") {
      return pending();
    }
    return {
      status: 200,
      headers: { "cache-control": "no-store" },
      data: { status: status.state },
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
  if (terminal.status === "failed") {
    throw appError(422, "action_failed", terminal.error.message);
  }
  const target = await recoverTargetActionTerminal(
    application,
    context,
    operationId,
    action.id,
    terminal,
  );
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
    ) return pending();
    if (streams.length < 256) break;
    afterStreamOrdinal = streams.at(-1)!.streamOrdinal;
  }
  return {
    status: 200,
    headers: { "cache-control": "no-store" },
    data: target.output,
  };
}
