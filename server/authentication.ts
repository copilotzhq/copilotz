/** Resolves trusted scope and policy once for a compiled HTTP endpoint. @module */
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import type {
  ServerAuthorizedScope,
  ServerFacadeResource,
} from "../plugins/server/internal/contracts.ts";
import type { ServerRouteMatch } from "../plugins/server/authoring/route-compiler/index.ts";
import type { FacadeContext } from "./context.ts";
import { createHttpReads } from "./reads.ts";
import { assertUploadContentLength } from "./assets.ts";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function authorizedScope(value: unknown): ServerAuthorizedScope {
  if (value === undefined) return Object.freeze({});
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) throw new TypeError("Server authentication returned an invalid scope.");
  const input = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(input).some((key) =>
      key !== "namespace" && key !== "databaseSchema" && key !== "identity" &&
      key !== "actionMetadata" && key !== "operationMetadata" &&
      key !== "context" && key !== "actor"
    )
  ) {
    throw new TypeError(
      "Server authentication returned unsupported scope fields.",
    );
  }
  for (const field of ["namespace", "databaseSchema"] as const) {
    if (input[field] !== undefined && !text(input[field])) {
      throw new TypeError(`Server ${field} must be a non-empty string.`);
    }
  }
  if (
    input.actor !== undefined && (
      !input.actor || typeof input.actor !== "object" ||
      Array.isArray(input.actor) ||
      !text((input.actor as Record<string, unknown>).id)
    )
  ) throw new TypeError("Server actor must have a non-empty id.");
  const plain = (candidate: unknown, label: string) => {
    if (candidate === undefined) return undefined;
    if (
      !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    ) {
      throw new TypeError(`${label} must be an object.`);
    }
    return Object.freeze(structuredClone(candidate as Record<string, unknown>));
  };
  return Object.freeze({
    ...(input.actor
      ? {
        actor: plain(
          input.actor,
          "Server actor",
        ) as ServerAuthorizedScope["actor"],
      }
      : {}),
    ...(text(input.namespace) ? { namespace: text(input.namespace) } : {}),
    ...(text(input.databaseSchema)
      ? { databaseSchema: text(input.databaseSchema) }
      : {}),
    ...(input.identity
      ? { identity: plain(input.identity, "Server identity")! }
      : {}),
    ...(input.actionMetadata
      ? {
        actionMetadata: plain(input.actionMetadata, "Server Action metadata")!,
      }
      : {}),
    ...(input.operationMetadata
      ? {
        operationMetadata: plain(
          input.operationMetadata,
          "Server operation metadata",
        )!,
      }
      : {}),
    ...(input.context
      ? { context: plain(input.context, "Server context")! }
      : {}),
  });
}

export async function authenticateHttpRequest(
  request: Request,
  application: InternalCopilotzApplication,
  facade: ServerFacadeResource,
  match: ServerRouteMatch,
): Promise<FacadeContext | Response> {
  const authenticationContext = Object.freeze({
    lookup: (scope: ServerAuthorizedScope) =>
      createHttpReads(application, scope),
    endpoint: match.endpoint,
    params: match.params,
    defaultNamespace: application.config.namespace,
    defaultDatabaseSchema: application.config.databaseSchema,
  });
  const authenticationRequest = request.clone();
  let authenticated;
  try {
    authenticated = await facade.authenticate?.(
      authenticationRequest,
      authenticationContext,
    );
  } finally {
    if (!authenticationRequest.bodyUsed) {
      void authenticationRequest.body?.cancel().catch(() => undefined);
    }
  }
  if (authenticated instanceof Response) return authenticated;
  const selected = authorizedScope(authenticated);
  const scope = Object.freeze({
    ...selected,
    namespace: selected.namespace ?? application.config.namespace,
    databaseSchema: selected.databaseSchema ??
      application.config.databaseSchema,
  });
  const read = await createHttpReads(application, scope);
  const policyRequest = request.clone();
  let authorized;
  try {
    authorized = await facade.authorize?.(policyRequest, {
      ...authenticationContext,
      scope,
      read,
    });
  } finally {
    if (!policyRequest.bodyUsed) {
      void policyRequest.body?.cancel().catch(() => undefined);
    }
  }
  if (authorized instanceof Response) return authorized;
  const constraints = Object.freeze(structuredClone(authorized ?? {}));
  assertUploadContentLength(
    request,
    match.endpoint,
    facade.maxAssetUploadBytes,
  );
  return Object.freeze({
    ...(scope.context ?? {}),
    serverScope: scope,
    serverConstraints: constraints,
    serverRequest: request,
    namespace: scope.namespace,
    databaseSchema: scope.databaseSchema,
    serverEndpointKey: match.endpoint.key,
    serverParams: match.params,
    serverActionMetadata: {
      ...scope.actionMetadata,
      ...constraints.actionMetadata,
      ...(scope.actor ? { httpActor: scope.actor } : {}),
    },
    operationMetadata: {
      ...scope.operationMetadata,
      ...(scope.actor ? { actorId: scope.actor.id } : {}),
    },
    serverIdentity: scope.identity ?? Object.freeze({}),
    serverSignal: request.signal,
  });
}
