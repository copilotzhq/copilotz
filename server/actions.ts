import { coreThreadObservationMetadata } from "@copilotz/copilotz/core";
import { constrainInput } from "./input.ts";
import { admitHttpOperation } from "./admission.ts";
/** Durable Action ingress and authorized result recovery. @module */
import { validateAgainstJsonSchema } from "../runtime/collections/validate.ts";
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_ACTION_REQUEST_SCHEMA,
  type ServerEndpointDescriptor,
} from "../plugins/server/shared/contracts.ts";
import type { HttpRequest, HttpResponse } from "./http-types.ts";
import type { FacadeContext } from "./context.ts";
import { recordedOperationResult } from "../runtime/application/ingress/result.ts";
import { admitActionRequest } from "../runtime/application/ingress/admit.ts";
function appError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}
function header(
  headers: HttpRequest["headers"],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
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
  const observationThreadId =
    context.serverConstraints.operations?.metadata?.threadId ??
      context.operationMetadata.threadId;
  const handle = await admitActionRequest(application, {
    type: SERVER_ACTION_REQUEST_EVENT_TYPE,
    payload: {
      schema: SERVER_ACTION_REQUEST_SCHEMA,
      requestId,
      actionAlias: endpoint.actionAlias!,
      input,
      actionMetadata: context.serverActionMetadata,
    } as const,
    namespace: context.namespace,
    databaseSchema: context.databaseSchema,
    correlationId,
    causationId: context.serverIdentity.causationId,
    deduplicationId: context.serverIdentity.deduplicationId ??
      header(request.headers, "idempotency-key") ?? requestId,
    operationMetadata: {
      ...context.operationMetadata,
      ...(context.serverScope.actor
        ? { actorId: context.serverScope.actor.id }
        : {}),
    },
    metadata: {
      ...(typeof observationThreadId === "string"
        ? coreThreadObservationMetadata(observationThreadId)
        : {}),
      ...({ sourceAdapter: "server" } as const),
      core: {
        visibility: { kind: "internal" },
      },
    },
  }, endpoint.inputSchema).catch((error) => {
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
  const result = await recordedOperationResult(
    application,
    context,
    operationId,
  );
  return {
    status: result.pending ? 202 : 200,
    ...(result.kind === "collection"
      ? {}
      : { headers: { "cache-control": "no-store" } }),
    data: result.value,
  };
}
