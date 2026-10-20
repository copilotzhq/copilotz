import { digestContent } from "../runtime/content/digest.ts";
import { retainedAuthority } from "../runtime/authorization/authority.ts";
import { withTrustedCollectionPolicyRead } from "../runtime/authorization/invocation.ts";
import {
  authorityIngressProof,
} from "../runtime/application/ingress/authority.ts";
import { withFacadeIngress } from "./context.ts";
/** Resolves trusted scope and policy once for a compiled HTTP endpoint. @module */
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import type {
  ServerAuthorizedScope,
  ServerFacadeResource,
} from "../plugins/server/shared/contracts.ts";
import type { ServerRouteMatch } from "../plugins/server/authoring/route-compiler/index.ts";
import type { FacadeContext } from "./context.ts";
import { createHttpReads } from "./reads.ts";
import { assertUploadContentLength } from "./assets.ts";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function authorizedScope(value: unknown): ServerAuthorizedScope {
  if (value === undefined) {
    throw new TypeError("Authentication must return retained authority.");
  }
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
      key !== "context" && key !== "actor" && key !== "authority"
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
  if (
    input.actor &&
    Object.entries(input.actor as Record<string, unknown>).some((
      [key, value],
    ) =>
      !["id", "externalId", "name", "email"].includes(key) ||
      typeof value !== "string"
    )
  ) {
    throw new TypeError("Server actor contains unsupported identity fields.");
  }
  const plain = (candidate: unknown, label: string) => {
    if (candidate === undefined) return undefined;
    if (
      !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    ) {
      throw new TypeError(`${label} must be an object.`);
    }
    return (structuredClone(candidate as Record<string, unknown>));
  };
  return ({
    authority: retainedAuthority(input.authority),
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
  } as const);
}

export async function authenticateHttpRequest(
  request: Request,
  application: InternalCopilotzApplication,
  facade: ServerFacadeResource,
  match: ServerRouteMatch,
): Promise<FacadeContext | Response> {
  assertUploadContentLength(
    request,
    match.endpoint,
    facade.maxAssetUploadBytes,
  );
  const authenticationContext = {
    lookup: (scope: ServerAuthorizedScope) =>
      createHttpReads(application, scope),
    endpoint: match.endpoint,
    params: match.params,
    defaultNamespace: application.config.namespace,
    defaultDatabaseSchema: application.config.databaseSchema,
  } as const;
  const authenticationRequest = request.clone();
  let authenticated;
  try {
    authenticated = await withTrustedCollectionPolicyRead(() =>
      facade.authenticate?.(
        authenticationRequest,
        authenticationContext,
      )
    );
  } finally {
    if (!authenticationRequest.bodyUsed) {
      void authenticationRequest.body?.cancel().catch(() => undefined);
    }
  }
  if (authenticated instanceof Response) return authenticated;
  const selected = authorizedScope(authenticated);
  const scope = {
    ...selected,
    namespace: selected.namespace ?? application.config.namespace,
    databaseSchema: selected.databaseSchema ??
      application.config.databaseSchema,
  } as const;
  let selectedAuthority = scope.authority!;
  const proof = request.headers.get("x-copilotz-credential-proof");
  if (proof && !/^[A-Za-z0-9_-]{32,128}$/.test(proof)) {
    throw new TypeError("Invalid credential projection proof.");
  }
  selectedAuthority = retainedAuthority({
    ...selectedAuthority,
    scope: {
      ...selectedAuthority.scope,
      bindings: {
        ...selectedAuthority.scope.bindings,
        "@credential-proof": proof
          ? await digestContent(new TextEncoder().encode(proof))
          : "",
      },
    },
  });
  const flowToken = request.headers.get("x-copilotz-flow");
  const cookieName = facade.sessionCookie?.name ?? "copilotz_session";
  const sessionToken = request.headers.get("cookie")?.split(";").map((value) =>
    value.trim()
  ).find((value) => value.startsWith(`${cookieName}=`))?.slice(
    cookieName.length + 1,
  );
  if (flowToken || sessionToken) {
    const runtime = scope.databaseSchema === application.config.databaseSchema
      ? application
      : await application.databaseScope(scope.databaseSchema);
    selectedAuthority = await runtime.authorization.credentials.authenticate(
      selectedAuthority,
      flowToken || sessionToken!,
      flowToken ? "flow" : "session",
    );
  }
  const authority = retainedAuthority({
    ...selectedAuthority,
    requestFacts: {
      ...selectedAuthority.requestFacts,
      endpoint: match.endpoint.key,
      operation: match.endpoint.operation ?? match.endpoint.kind,
      params: match.params,
    },
  });
  if (
    authority.scope.namespace !== scope.namespace ||
    authority.scope.databaseSchema !== scope.databaseSchema
  ) {
    throw new TypeError(
      "Authentication scope differs from retained authority.",
    );
  }
  if (
    authority.flow && !(
      match.endpoint.kind === "action" &&
        match.endpoint.actionAlias === authority.flow.continuation ||
      match.endpoint.kind === "operation" &&
        ["get", "result", "observe"].includes(match.endpoint.operation ?? "")
    )
  ) {
    throw Object.assign(new Error("Forbidden."), {
      code: "forbidden",
      status: 403,
    });
  }
  const result = withFacadeIngress(
    {
      ...(scope.context ?? {}),
      sessionCookie: facade.sessionCookie,
      serverScope: {
        ...scope,
        authority,
      },
      serverRequest: request,
      namespace: scope.namespace,
      databaseSchema: scope.databaseSchema,
      serverEndpointKey: match.endpoint.key,
      serverParams: match.params,
      serverActionMetadata: {
        ...scope.actionMetadata,
        ...(scope.actor ? { httpActor: scope.actor } : {}),
      },
      operationMetadata: {
        ...scope.operationMetadata,
        ...(scope.actor ? { actorId: scope.actor.id } : {}),
      },
      serverIdentity: scope.identity ?? ({} as const),
      serverSignal: request.signal,
    } as const,
    authorityIngressProof(authority),
  );
  return result;
}
