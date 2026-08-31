/** Compiled Fetch facade over composed Copilotz primitives. @module */

import type { ActionEventData } from "@copilotz/copilotz/actions";
import { type ContentRef, formatAssetRef } from "../runtime/content/index.ts";
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import { SERVER_INVOKE_ACTION_ID } from "../plugins/server/actions/invoke-action/index.ts";
import { actionSchemaHasSecrets } from "../runtime/actions/secret.ts";
import {
  type CompiledServerRoutes,
  compileServerRoutes,
} from "../plugins/server/authoring/route-compiler/index.ts";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_ACTION_REQUEST_SCHEMA,
  SERVER_RESOURCE_ALIAS,
  SERVER_RESOURCE_NAMESPACE,
  serverActionRequestSchema,
  type ServerAuthorizedScope,
  type ServerEndpointDescriptor,
  type ServerFacadeResource,
} from "../plugins/server/internal/contracts.ts";
import {
  createEventNativeApp,
  EVENT_NATIVE_OUTPUT_STREAM,
  type EventNativeApp,
  type EventNativeAppRequest,
  type EventNativeAppResponse,
  type EventNativeOutputStream,
} from "./event-native.ts";
import {
  createEventNativeFetchHandler,
  type CreateEventNativeFetchHandlerOptions,
  type EventNativeFetchHandler,
} from "./fetch.ts";
import { eventNativeAsset } from "./assets.ts";

export type CreateServerFacadeFetchHandlerOptions = Readonly<{
  facade?: ServerFacadeResource;
  admit?: () => void | Promise<void>;
  /** Resolves host-authenticated, process-local request context before guard. */
  resolveContext?: CreateEventNativeFetchHandlerOptions["resolveContext"];
  responseHeaders?: Readonly<Record<string, string>>;
  onError?: (error: unknown, request: Request) => void | Promise<void>;
}>;

export type ServerFacadeFetchHandler =
  & EventNativeFetchHandler
  & Readonly<{
    routes: CompiledServerRoutes;
  }>;

type FacadeContext = Readonly<{
  serverEndpointKey: string;
  serverParams: Readonly<Record<string, string>>;
  serverResponseMode: "json" | "sse" | "multipart";
  serverActionMetadata: Readonly<Record<string, unknown>>;
  operationMetadata: Readonly<Record<string, unknown>>;
  serverIdentity: Readonly<Record<string, string>>;
  serverSignal: AbortSignal;
  namespace?: string;
  databaseSchema?: string;
}>;

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
  headers: EventNativeAppRequest["headers"],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower && value.trim()) return value.trim();
  }
  return undefined;
}

function uploadTooLarge(maxBytes: number): Error {
  return appError(
    413,
    "asset_too_large",
    `Asset upload exceeds the ${maxBytes}-byte limit.`,
  );
}

/** Reject a declared oversized upload before Fetch consumes its request body. */
function assertUploadContentLength(
  request: Request,
  endpoint: ServerEndpointDescriptor,
  maxBytes: number,
): void {
  if (endpoint.kind !== "asset" || endpoint.operation !== "upload") return;
  const contentLength = request.headers.get("content-length")?.trim();
  if (!contentLength || !/^\d+$/.test(contentLength)) return;
  const byteLength = Number(contentLength);
  if (Number.isSafeInteger(byteLength) && byteLength > maxBytes) {
    throw uploadTooLarge(maxBytes);
  }
}

function uploadMediaType(headers: EventNativeAppRequest["headers"]): string {
  const mediaType = header(headers, "content-type")?.split(";", 1)[0]
    ?.trim().toLowerCase();
  return mediaType || "application/octet-stream";
}

function uploadFilename(
  headers: EventNativeAppRequest["headers"],
): string | undefined {
  const disposition = header(headers, "content-disposition");
  if (!disposition) return undefined;
  const extended = /(?:^|;)\s*filename\*=\s*([^;]+)/i.exec(disposition)?.[1];
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i
    .exec(disposition);
  let value = extended ?? plain?.[1] ?? plain?.[2];
  if (!value) return undefined;
  value = value.trim().replace(/^"|"$/g, "");
  if (extended) {
    value = value.replace(/^utf-8''/i, "");
    try {
      value = decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  const filename = [...value.replace(/[\\/]/g, "/").split("/").at(-1)!]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    }).join("").trim().slice(0, 255);
  return filename || undefined;
}

function facadeResource(
  application: InternalCopilotzApplication,
  explicit?: ServerFacadeResource,
): ServerFacadeResource {
  if (explicit) return explicit;
  const candidate = application.plugins.resources[SERVER_RESOURCE_NAMESPACE]?.[
    SERVER_RESOURCE_ALIAS
  ];
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError(
      "Server facade requires createServerPlugin() in the application composition.",
    );
  }
  return candidate as ServerFacadeResource;
}

function responseMode(request: Request): FacadeContext["serverResponseMode"] {
  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  if (accept.includes("multipart/mixed")) return "multipart";
  if (accept.includes("text/event-stream")) return "sse";
  return "json";
}

function authorizedScope(value: unknown): ServerAuthorizedScope {
  if (value === undefined) return Object.freeze({});
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) throw new TypeError("Server guard returned an invalid scope.");
  const input = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(input).some((key) =>
      key !== "namespace" && key !== "databaseSchema" && key !== "identity" &&
      key !== "actionMetadata" && key !== "operationMetadata" &&
      key !== "context"
    )
  ) throw new TypeError("Server guard returned unsupported scope fields.");
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

function endpointByKey(
  routes: CompiledServerRoutes,
  key: string,
): ServerEndpointDescriptor {
  const endpoint = routes.routes.find((route) => route.endpoint.key === key)
    ?.endpoint;
  if (!endpoint) throw appError(404, "route_not_found", "Route was not found.");
  return endpoint;
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

async function actionResponse(
  application: InternalCopilotzApplication,
  endpoint: ServerEndpointDescriptor,
  request: EventNativeAppRequest,
  context: FacadeContext,
): Promise<EventNativeAppResponse> {
  const requestId = header(request.headers, "idempotency-key") ??
    crypto.randomUUID();
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
        input: request.body ?? {},
        actionMetadata: context.serverActionMetadata,
      }),
      namespace: context.namespace,
      databaseSchema: context.databaseSchema,
      correlationId,
      causationId: context.serverIdentity.causationId,
      deduplicationId: context.serverIdentity.deduplicationId ??
        header(request.headers, "idempotency-key") ?? requestId,
      metadata: Object.freeze({ sourceAdapter: "server" }),
      operationMetadata: context.operationMetadata,
      visibility: { kind: "internal" },
    },
    serverActionRequestSchema(endpoint.inputSchema),
    `server:${requestId}`,
  );
  const abort = () => {
    void handle.detach("server_request_detached").catch(() => undefined);
  };
  if (context.serverSignal.aborted) abort();
  else context.serverSignal.addEventListener("abort", abort, { once: true });
  const respondAsync = header(request.headers, "prefer")?.split(",").some(
    (value) => value.trim().toLowerCase() === "respond-async",
  ) ?? false;
  if (respondAsync) {
    const status = await application.operationStatus({
      operationId: handle.operationId,
      namespace: context.namespace,
      databaseSchema: context.databaseSchema,
    });
    context.serverSignal.removeEventListener("abort", abort);
    await handle.detach("http_respond_async");
    const threadId = typeof status?.metadata.threadId === "string"
      ? status.metadata.threadId.trim()
      : "";
    const externalId = typeof status?.metadata.threadExternalId === "string"
      ? status.metadata.threadExternalId.trim()
      : typeof status?.metadata.externalThreadId === "string"
      ? status.metadata.externalThreadId.trim()
      : threadId;
    return {
      status: 202,
      headers: { "preference-applied": "respond-async" },
      data: Object.freeze({
        operationId: handle.operationId,
        status: status?.state === "accepted" ? "accepted" : "running",
        correlationId: handle.correlationId,
        replayCursor: handle.replayCursor,
        acceptedAt: status?.acceptedAt ?? new Date().toISOString(),
        ...(threadId
          ? { thread: Object.freeze({ id: threadId, externalId }) }
          : {}),
      }),
    };
  }
  if (context.serverResponseMode !== "json") {
    const done = handle.done.finally(() =>
      context.serverSignal.removeEventListener("abort", abort)
    );
    const stream: EventNativeOutputStream = Object.freeze({
      type: EVENT_NATIVE_OUTPUT_STREAM,
      outputs: handle.outputs,
      done,
      operationId: handle.operationId,
      replayCursor: handle.replayCursor,
      async cancel(reason = "server_request_cancelled") {
        context.serverSignal.removeEventListener("abort", abort);
        await handle.detach(reason);
      },
    });
    return {
      status: 200,
      ...(actionSchemaHasSecrets(endpoint.outputSchema)
        ? { headers: { "cache-control": "no-store" } }
        : {}),
      data: stream,
    };
  }
  let terminal: ServerInvokeTerminal | undefined;
  const collect = (async () => {
    for await (const output of handle.outputs) {
      terminal ??= actionTerminal(output, requestId, endpoint.id);
    }
  })();
  let settlementError: unknown;
  try {
    await Promise.all([handle.done, collect]);
  } catch (error) {
    settlementError = error;
  } finally {
    context.serverSignal.removeEventListener("abort", abort);
  }
  terminal ??= await recoverActionTerminal(
    application,
    context,
    handle.eventId,
    requestId,
    endpoint.id,
  );
  if (!terminal && settlementError !== undefined) throw settlementError;
  if (!terminal) {
    throw appError(
      500,
      "action_result_missing",
      "Action result was not observed.",
    );
  }
  if (terminal.status === "failed") {
    throw appError(500, "action_failed", terminal.error.message);
  }
  const target = await recoverTargetActionTerminal(
    application,
    context,
    handle.eventId,
    endpoint.id,
    terminal,
  );
  if (!target) {
    throw appError(
      500,
      "action_result_missing",
      "Target Action result was not found.",
    );
  }
  if (target.status === "failed" || target.status === "cancelled") {
    throw appError(500, "action_failed", target.error.message);
  }
  if (target.status !== "completed") {
    throw appError(
      500,
      "action_result_missing",
      "Target Action result was not terminal.",
    );
  }
  return {
    status: 200,
    ...(actionSchemaHasSecrets(endpoint.outputSchema)
      ? { headers: { "cache-control": "no-store" } }
      : {}),
    data: target.output,
  };
}

async function assetUploadResponse(
  application: InternalCopilotzApplication,
  endpoint: ServerEndpointDescriptor,
  request: EventNativeAppRequest,
  context: FacadeContext,
  maxBytes: number,
): Promise<EventNativeAppResponse> {
  if (endpoint.operation !== "upload") {
    throw appError(405, "method_not_allowed", "Asset method is not allowed.");
  }
  const rawBody = (request.context as { rawBody?: unknown } | undefined)
    ?.rawBody;
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength === 0) {
    throw appError(400, "asset_body_required", "Asset upload requires a body.");
  }
  if (rawBody.byteLength > maxBytes) throw uploadTooLarge(maxBytes);
  const namespace = context.namespace ?? application.config.namespace;
  if (!namespace) {
    throw appError(400, "namespace_required", "Tenant namespace is required.");
  }
  const databaseSchema = context.databaseSchema ??
    application.config.databaseSchema;
  const scope = databaseSchema === application.config.databaseSchema
    ? application
    : await application.databaseScope(databaseSchema);
  const name = uploadFilename(request.headers);
  const asset = await scope.content.assets.publish({
    namespace,
    mediaType: uploadMediaType(request.headers),
    body: rawBody,
    idempotencyKey: header(request.headers, "idempotency-key") ??
      crypto.randomUUID(),
    ...(name ? { metadata: { name } } : {}),
  });
  const canonicalName = typeof asset.metadata?.name === "string"
    ? asset.metadata.name
    : undefined;
  const content: ContentRef = Object.freeze({
    assetId: asset.id,
    kind: "file",
    role: "attachment",
    mediaType: asset.mediaType,
    disposition: "attachment",
    ...(canonicalName ? { name: canonicalName } : {}),
  });
  return {
    status: 201,
    data: Object.freeze({
      asset: eventNativeAsset(asset),
      assetRef: formatAssetRef(namespace, asset.id),
      content,
    }),
  };
}

function nativeRequest(
  endpoint: ServerEndpointDescriptor,
  params: Readonly<Record<string, string>>,
  request: EventNativeAppRequest,
): EventNativeAppRequest {
  const context = request.context;
  if (endpoint.kind === "collection") {
    const operation = endpoint.operation!;
    const path = operation === "list" || operation === "create"
      ? [endpoint.id]
      : operation === "get" || operation === "update" || operation === "delete"
      ? [endpoint.id, params.id]
      : operation.startsWith("query:")
      ? [endpoint.id, "queries", endpoint.member!]
      : [endpoint.id, params.id, "commands", endpoint.member!];
    return Object.freeze({
      ...request,
      resource: "collections",
      path,
      context,
    });
  }
  if (endpoint.kind === "channel") {
    return Object.freeze({
      ...request,
      resource: "channels",
      path: [endpoint.id],
      context,
    });
  }
  if (endpoint.kind === "asset") {
    return Object.freeze({
      ...request,
      resource: "assets",
      path: [params.id],
      context,
    });
  }
  return Object.freeze({ ...request, resource: "agents", path: [], context });
}

/** Creates the compiled Fetch handler for one fully composed application. */
export function createServerFacadeFetchHandler(
  application: InternalCopilotzApplication,
  options: CreateServerFacadeFetchHandlerOptions = {},
): ServerFacadeFetchHandler {
  const facade = facadeResource(application, options.facade);
  const routes = compileServerRoutes(application.plugins, facade);
  const native = createEventNativeApp(application, {
    // These values were selected by the process-local facade guard. Passing
    // them through the event-native trust hooks preserves that authority when
    // the request targets a non-default physical schema.
    resolveNamespace: (request) => request.context?.namespace,
    resolveDatabaseSchema: (request) => request.context?.databaseSchema,
  });
  const app: EventNativeApp = Object.freeze({
    resources: () =>
      routes.routes.map((route) =>
        Object.freeze({
          name: route.endpoint.id,
          methods: Object.freeze([route.endpoint.method]),
        })
      ),
    async handle(request) {
      const context = request.context as FacadeContext | undefined;
      if (!context?.serverEndpointKey) {
        throw appError(
          500,
          "server_context_missing",
          "Server context is missing.",
        );
      }
      const endpoint = endpointByKey(routes, context.serverEndpointKey);
      if (endpoint.kind === "openapi") {
        return { status: 200, data: routes.openApi };
      }
      if (endpoint.kind === "action") {
        return await actionResponse(application, endpoint, request, context);
      }
      if (endpoint.kind === "asset" && endpoint.operation === "upload") {
        return await assetUploadResponse(
          application,
          endpoint,
          request,
          context,
          facade.maxAssetUploadBytes,
        );
      }
      return await native.handle(nativeRequest(
        endpoint,
        context.serverParams,
        request,
      ));
    },
  });
  const fetch = createEventNativeFetchHandler(app, {
    basePath: facade.basePath,
    responseHeaders: options.responseHeaders,
    streamResponseMode: "negotiate",
    onError: options.onError,
    rawBody(_request, context) {
      const key = (context as FacadeContext | undefined)?.serverEndpointKey;
      const upload = routes.routes.some((route) =>
        route.endpoint.key === key && route.endpoint.kind === "asset" &&
        route.endpoint.operation === "upload"
      );
      return upload
        ? Object.freeze({
          maxBytes: facade.maxAssetUploadBytes,
          tooLarge: Object.freeze({
            code: "asset_too_large",
            message: uploadTooLarge(facade.maxAssetUploadBytes).message,
          }),
        })
        : false;
    },
    async resolveContext(request) {
      await options.admit?.();
      const match = routes.match(request.method, new URL(request.url).pathname);
      if (!match) {
        throw appError(
          404,
          "route_not_found",
          "Application route was not found.",
        );
      }
      const hostContext = await options.resolveContext?.(request);
      if (hostContext instanceof Response) return hostContext;
      const guarded = await facade.guard?.(
        request,
        Object.freeze({
          endpoint: match.endpoint,
          defaultNamespace: application.config.namespace,
          defaultDatabaseSchema: application.config.databaseSchema,
          ...(hostContext ? { requestContext: hostContext } : {}),
        }),
      );
      if (guarded instanceof Response) return guarded;
      const scope = authorizedScope(guarded);
      assertUploadContentLength(
        request,
        match.endpoint,
        facade.maxAssetUploadBytes,
      );
      return Object.freeze({
        ...(hostContext ?? {}),
        ...(scope.context ?? {}),
        namespace: scope.namespace ?? text(hostContext?.namespace) ??
          application.config.namespace,
        databaseSchema: scope.databaseSchema ??
          text(hostContext?.databaseSchema) ??
          application.config.databaseSchema,
        serverEndpointKey: match.endpoint.key,
        serverParams: match.params,
        serverResponseMode: responseMode(request),
        serverActionMetadata: scope.actionMetadata ?? Object.freeze({}),
        operationMetadata: scope.operationMetadata ?? Object.freeze({}),
        serverIdentity: scope.identity ?? Object.freeze({}),
        serverSignal: request.signal,
      });
    },
  });
  return Object.assign(fetch, { routes }) as ServerFacadeFetchHandler;
}
