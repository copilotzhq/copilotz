/** Shared durable ingress protocol. Legacy Server identities remain replay-compatible. @module */
import type {
  ActionInvocationMetadata,
  ActionSchema,
} from "../../actions/types.ts";
import type { CollectionFilter } from "../../collections/types.ts";
export const SERVER_ACTION_REQUEST_EVENT_TYPE =
  "copilotz.server.action.requested";
export const SERVER_ACTION_REQUEST_SCHEMA = "copilotz.server.action-request.v1";
export const SERVER_ACTION_METADATA_SCHEMA = "copilotz.server.action.v1";
export const SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE =
  "copilotz.server.collection.mutation.requested";
export const SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA =
  "copilotz.server.collection-mutation-request.v1";
export const SERVER_COLLECTION_MUTATION_METADATA_SCHEMA =
  "copilotz.server.collection-mutation.v1";
export type ServerActionRequest = Readonly<{
  schema: typeof SERVER_ACTION_REQUEST_SCHEMA;
  requestId: string;
  actionAlias: string;
  input: unknown;
  actionMetadata: ActionInvocationMetadata;
}>;

export type ServerCollectionMutationRequest = Readonly<{
  schema: typeof SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA;
  requestId: string;
  collectionAlias: string;
  operation: "create" | "update" | "delete" | "command";
  id?: string;
  command?: string;
  input: unknown;
  condition?: Readonly<{
    current?: CollectionFilter;
    next?: CollectionFilter;
  }>;
}>;

export type ServerInvokeRequest = Readonly<{
  requestId: string;
  actionAlias: string;
}>;

export function serverActionRequestSchema(
  inputSchema: ActionSchema | undefined,
): ActionSchema {
  return ({
    type: "object",
    properties: {
      schema: { const: SERVER_ACTION_REQUEST_SCHEMA } as const,
      requestId: { type: "string", minLength: 1 } as const,
      actionAlias: { type: "string", minLength: 1 } as const,
      input: inputSchema ?? ({} as const),
      actionMetadata: { type: "object" } as const,
    } as const,
    required: [
      "schema",
      "requestId",
      "actionAlias",
      "input",
      "actionMetadata",
    ] as const,
    additionalProperties: false,
  } as const);
}

export function parseServerActionRequest(value: unknown): ServerActionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Server Action request must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (
    input.schema !== SERVER_ACTION_REQUEST_SCHEMA ||
    typeof input.requestId !== "string" || !input.requestId.trim() ||
    typeof input.actionAlias !== "string" || !input.actionAlias.trim() ||
    !input.actionMetadata || typeof input.actionMetadata !== "object" ||
    Array.isArray(input.actionMetadata) ||
    Reflect.ownKeys(input).some((key) =>
      key !== "schema" && key !== "requestId" && key !== "actionAlias" &&
      key !== "input" && key !== "actionMetadata"
    )
  ) throw new TypeError("Server Action request is invalid.");
  return ({
    schema: SERVER_ACTION_REQUEST_SCHEMA,
    requestId: input.requestId.trim(),
    actionAlias: input.actionAlias.trim(),
    input: structuredClone(input.input),
    actionMetadata: structuredClone(
      input.actionMetadata as Record<string, unknown>,
    ),
  } as const);
}

export function serverCollectionMutationRequestSchema(
  inputSchema?: ActionSchema,
): ActionSchema {
  return ({
    type: "object",
    properties: {
      schema: { const: SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA } as const,
      requestId: { type: "string", minLength: 1 } as const,
      collectionAlias: { type: "string", minLength: 1 } as const,
      operation: { enum: ["create", "update", "delete", "command"] } as const,
      id: { type: "string", minLength: 1 } as const,
      command: { type: "string", minLength: 1 } as const,
      input: inputSchema ?? ({} as const),
      condition: { type: "object" } as const,
    } as const,
    required: [
      "schema",
      "requestId",
      "collectionAlias",
      "operation",
      "input",
    ] as const,
    additionalProperties: false,
  } as const);
}

export function parseServerCollectionMutationRequest(
  value: unknown,
): ServerCollectionMutationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      "Server collection mutation request must be an object.",
    );
  }
  const input = value as Record<string, unknown>;
  const operation = input.operation;
  if (
    input.schema !== SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA ||
    typeof input.requestId !== "string" || !input.requestId.trim() ||
    typeof input.collectionAlias !== "string" ||
    !input.collectionAlias.trim() ||
    !["create", "update", "delete", "command"].includes(String(operation)) ||
    (input.id !== undefined &&
      (typeof input.id !== "string" || !input.id.trim())) ||
    (input.command !== undefined &&
      (typeof input.command !== "string" || !input.command.trim())) ||
    (input.condition !== undefined &&
      (!input.condition || typeof input.condition !== "object" ||
        Array.isArray(input.condition))) ||
    Reflect.ownKeys(input).some((key) =>
      ![
        "schema",
        "requestId",
        "collectionAlias",
        "operation",
        "id",
        "command",
        "input",
        "condition",
      ]
        .includes(String(key))
    )
  ) throw new TypeError("Server collection mutation request is invalid.");
  if (operation === "command" && typeof input.command !== "string") {
    throw new TypeError("Server collection command is required.");
  }
  if (operation !== "command" && input.command !== undefined) {
    throw new TypeError(
      "Server collection command is only valid for commands.",
    );
  }
  if (operation === "create" && input.id !== undefined) {
    throw new TypeError(
      "Server collection create requests cannot carry a member id.",
    );
  }
  if (operation !== "create" && typeof input.id !== "string") {
    throw new TypeError("Server collection mutation id is required.");
  }
  return ({
    schema: SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA,
    requestId: input.requestId.trim(),
    collectionAlias: input.collectionAlias.trim(),
    operation: operation as ServerCollectionMutationRequest["operation"],
    ...(typeof input.id === "string" ? { id: input.id.trim() } : {}),
    ...(typeof input.command === "string"
      ? { command: input.command.trim() }
      : {}),
    input: structuredClone(input.input),
    ...(input.condition !== undefined
      ? {
        condition: structuredClone(
          input.condition as Record<string, unknown>,
        ) as ServerCollectionMutationRequest["condition"],
      }
      : {}),
  } as const);
}
