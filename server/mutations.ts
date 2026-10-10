import { coreThreadObservationMetadata } from "@copilotz/copilotz/core";
/** Durable, policy-bound collection mutation ingress. @module */

import type { ActionSchema } from "../runtime/actions/types.ts";
import { admitCollectionMutationRequest } from "../runtime/application/ingress/admit.ts";
import { collectionMutationResult as recordedCollectionMutationResult } from "../runtime/application/ingress/result.ts";
import { validateAgainstJsonSchema } from "../runtime/collections/validate.ts";
import type { ScopedCollection } from "../runtime/collections/index.ts";
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import {
  SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
  SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA,
  type ServerCollectionMutationPolicy,
  type ServerCollectionMutationRequest,
  type ServerEndpointDescriptor,
} from "../plugins/server/shared/contracts.ts";
import type { HttpRequest, HttpResponse } from "./http-types.ts";
import type { FacadeContext } from "./context.ts";
import { admitHttpOperation } from "./admission.ts";
import { constrainInput } from "./input.ts";

function appError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

export function collectionMutationPolicy(
  context: FacadeContext,
  endpoint: ServerEndpointDescriptor,
): ServerCollectionMutationPolicy {
  const name = endpoint.collectionAlias!;
  const definition = context.serverConstraints.collectionMutations?.[name] ??
    context.serverConstraints.collectionMutations?.[endpoint.id];
  const policy = endpoint.operation === "create"
    ? definition?.create
    : endpoint.operation === "update"
    ? definition?.update
    : endpoint.operation === "delete"
    ? definition?.delete
    : endpoint.operation?.startsWith("command:")
    ? definition?.commands?.[endpoint.member!]
    : undefined;
  if (!policy) {
    throw appError(
      403,
      "forbidden",
      "Collection mutation policy is required.",
    );
  }
  return policy;
}

function allowedFields(
  policy: ServerCollectionMutationPolicy,
  value: Record<string, unknown>,
  label: string,
): void {
  if (!policy.fields) return;
  const fields = new Set(policy.fields);
  if ([...Object.keys(value)].some((field) => !fields.has(field))) {
    throw appError(
      403,
      "forbidden",
      `${label} contains a field outside its mutation policy.`,
    );
  }
}

/** Validates trusted write policy before a request enters the durable queue. */
export function authorizeCollectionMutation(
  endpoint: ServerEndpointDescriptor,
  context: FacadeContext,
  _collection: ScopedCollection,
  input: unknown,
): unknown {
  const policy = collectionMutationPolicy(context, endpoint);
  const candidateInput = record(input);
  const constrained = constrainInput(candidateInput, policy.input) as Record<
    string,
    unknown
  >;
  if (endpoint.operation === "create") {
    if (
      ["namespace", "createdAt", "updatedAt"].some((field) =>
        Object.hasOwn(constrained, field)
      )
    ) {
      throw appError(
        403,
        "forbidden",
        "Protected collection fields cannot be supplied.",
      );
    }
    allowedFields(policy, constrained, "Create input");
    return constrained;
  }
  if (endpoint.operation === "update") {
    const set = record(constrained.set);
    const unset = Array.isArray(constrained.unset) ? constrained.unset : [];
    if (
      [...Object.keys(set), ...unset].some((field) =>
        ["id", "namespace", "createdAt", "updatedAt"].includes(field)
      )
    ) {
      throw appError(
        403,
        "forbidden",
        "Protected collection fields cannot be mutated.",
      );
    }
    allowedFields(policy, {
      ...set,
      ...Object.fromEntries(unset.map((key) => [key, undefined])),
    }, "Update input");
  } else if (endpoint.operation?.startsWith("command:")) {
    if (Object.hasOwn(candidateInput, "id")) {
      throw appError(
        403,
        "forbidden",
        "Command input cannot choose the record id.",
      );
    }
    allowedFields(policy, candidateInput, "Command input");
  }
  return constrained;
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
  collection: ScopedCollection,
): Promise<HttpResponse> {
  const input = request.body === undefined ? {} : request.body;
  if (endpoint.inputSchema) {
    try {
      validateAgainstJsonSchema(
        endpoint.inputSchema,
        input,
        "Collection mutation input",
      );
    } catch {
      throw appError(
        400,
        "invalid_input",
        "Request does not match the collection mutation schema.",
      );
    }
  }
  const policy = collectionMutationPolicy(context, endpoint);
  const checked = await authorizeCollectionMutation(
    endpoint,
    context,
    collection,
    input,
  );
  const id = requestId(request.headers);
  context = await admitHttpOperation(application, context, id);
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
    ...(policy.filter
      ? {
        condition: {
          ...(endpoint.operation === "create" ||
              endpoint.operation === "update" ||
              endpoint.operation?.startsWith("command:")
            ? { next: policy.filter }
            : {}),
          ...(endpoint.operation !== "create"
            ? { current: policy.filter }
            : {}),
        },
      }
      : {}),
  };
  const observationThreadId =
    context.serverConstraints.operations?.metadata?.threadId ??
      context.operationMetadata.threadId;
  const handle = await admitCollectionMutationRequest(application, {
    type: SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
    payload,
    namespace: context.namespace,
    databaseSchema: context.databaseSchema,
    correlationId: context.serverIdentity.correlationId ?? `server:${id}`,
    causationId: context.serverIdentity.causationId,
    deduplicationId: context.serverIdentity.deduplicationId ?? id,
    operationMetadata: {
      ...context.operationMetadata,
      ...(context.serverConstraints.operations?.metadata ?? {}),
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
  }, endpoint.inputSchema as ActionSchema | undefined).catch((error) => {
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
