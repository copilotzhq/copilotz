import { facadeIngress } from "./context.ts";
import { coreThreadObservationMetadata } from "@copilotz/copilotz/core";
/** Durable, policy-bound collection mutation ingress. @module */

import type { ActionSchema } from "../runtime/actions/types.ts";
import { admitCollectionMutationRequest } from "../runtime/application/ingress/admit.ts";
import { collectionMutationResult as recordedCollectionMutationResult } from "../runtime/application/ingress/result.ts";
import type { ScopedCollection } from "../runtime/collections/index.ts";
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import {
  SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
  SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA,
  type ServerCollectionMutationRequest,
  type ServerEndpointDescriptor,
} from "../plugins/server/shared/contracts.ts";
import type { HttpRequest, HttpResponse } from "./http-types.ts";
import type { FacadeContext } from "./context.ts";

function appError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
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

function requestId(headers: HttpRequest["headers"]): string {
  const value = header(headers, "idempotency-key");
  if (!value) {
    throw appError(
      400,
      "idempotency_key_required",
      "Idempotency-Key is required.",
    );
  }
  return value;
}

export async function collectionMutationResponse(
  application: InternalCopilotzApplication,
  endpoint: ServerEndpointDescriptor,
  request: HttpRequest,
  context: FacadeContext,
  _collection: ScopedCollection,
): Promise<HttpResponse> {
  const input = request.body === undefined ? {} : request.body;
  const checked = input;
  const id = requestId(request.headers);
  const payload: ServerCollectionMutationRequest = {
    schema: SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA,
    requestId: id,
    collectionAlias: endpoint.collectionAlias!,
    operation: endpoint.operation === "command" ||
        endpoint.operation?.startsWith("command:")
      ? "command"
      : endpoint.operation as ServerCollectionMutationRequest["operation"],
    ...(endpoint.operation === "create" ? {} : { id: context.serverParams.id }),
    ...(endpoint.operation?.startsWith("command:")
      ? { command: endpoint.member }
      : {}),
    input: checked,
  };
  const observationThreadId = context.operationMetadata.threadId;
  const handle = await admitCollectionMutationRequest(
    application,
    {
      type: SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
      payload,
      namespace: context.namespace,
      databaseSchema: context.databaseSchema,
      correlationId: context.serverIdentity.correlationId ?? `server:${id}`,
      causationId: context.serverIdentity.causationId,
      deduplicationId: context.serverIdentity.deduplicationId ?? id,
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
        sourceAdapter: "server",
        core: { visibility: { kind: "internal" } },
      },
    },
    endpoint.inputSchema as ActionSchema | undefined,
    facadeIngress(context),
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

export async function collectionMutationResult(
  application: InternalCopilotzApplication,
  context: FacadeContext,
  operationId: string,
): Promise<HttpResponse | undefined> {
  const result = await recordedCollectionMutationResult(
    application,
    context,
    operationId,
  );
  return result && { status: result.pending ? 202 : 200, data: result.value };
}
