import { retainedAuthority } from "../runtime/authorization/authority.ts";
import { attachDeviceSocket } from "./device.ts";
import {
  type DeviceUpgrade,
  hostedDeviceUpgrade,
  trackHostedDeviceSocket,
} from "../runtime/subscriptions/hosting.ts";
import { withRetainedAuthority } from "../runtime/authorization/binding.ts";
import { handleChannel } from "./channels.ts";
import type { FacadeContext } from "./context.ts";
/** Compiled Fetch facade over composed Copilotz primitives. @module */

import { authenticateHttpRequest } from "./authentication.ts";
import { createHttpOperations } from "./operations.ts";
import { applicationOutputsMultipartResponse } from "./multipart.ts";
import { createHttpReads } from "./reads.ts";
import { validateAgainstJsonSchema } from "../runtime/collections/validate.ts";
import type {
  HttpAdapter,
  HttpHandlerContext,
} from "../plugins/server/authoring/http-adapter/index.ts";
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import {
  type CompiledServerRoutes,
  compileServerRoutes,
} from "../plugins/server/authoring/route-compiler/index.ts";
import {
  SERVER_RESOURCE_ALIAS,
  SERVER_RESOURCE_NAMESPACE,
  type ServerEndpointDescriptor,
  type ServerFacadeResource,
} from "../plugins/server/shared/contracts.ts";
import type { HttpApplication } from "./http-types.ts";
import { createHttpFetchHandler, type HttpFetchHandler } from "./fetch.ts";
import { assetUploadResponse } from "./assets.ts";
import { actionResponse, operationResult } from "./actions.ts";
import { collectionMutationResponse } from "./mutations.ts";

export type CreateServerFacadeFetchHandlerOptions = Readonly<{
  facade?: ServerFacadeResource;
  /** Host WebSocket upgrade; mounts the authenticated device binding at /device. */
  upgradeDevice?: DeviceUpgrade;
  admit?: () => void | Promise<void>;
  responseHeaders?: Readonly<Record<string, string>>;
  onError?: (error: unknown, request: Request) => void | Promise<void>;
}>;

export type ServerFacadeFetchHandler =
  & HttpFetchHandler
  & Readonly<{
    routes: CompiledServerRoutes;
  }>;

function appError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
      "Server facade requires serverPlugin in the application composition.",
    );
  }
  return candidate as ServerFacadeResource;
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

/** Creates the compiled Fetch handler for one fully composed application. */
export function createServerFacadeFetchHandler(
  application: InternalCopilotzApplication,
  options: CreateServerFacadeFetchHandlerOptions = {},
): ServerFacadeFetchHandler {
  const configuredFacade = facadeResource(application, options.facade);
  const facade = Object.freeze({ ...configuredFacade });
  if (typeof facade.authenticate !== "function") {
    throw new TypeError(
      "Server authentication and retained authority are required.",
    );
  }
  const routes = compileServerRoutes(application.plugins, facade);
  application.authorization.assertResources({
    collections: [
      ...new Set(
        routes.routes.flatMap(({ endpoint }) =>
          endpoint.collectionAlias ? [endpoint.collectionAlias] : []
        ),
      ),
    ],
    actions: [
      ...new Set(
        routes.routes.flatMap(({ endpoint }) =>
          endpoint.actionAlias ? [endpoint.actionAlias] : []
        ),
      ),
    ],
  });
  const httpRoutes = new Map(
    Object.values(application.plugins.adapters.http ?? {})
      .flatMap((adapter) => (adapter as HttpAdapter).routes)
      .map((route) => [route.id, route]),
  );
  const app: HttpApplication = {
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
      const read = await createHttpReads(
        application,
        context.serverScope,
        { context },
      );
      const operations = await createHttpOperations(
        application,
        context.serverScope,
        read,
      );
      if (endpoint.kind === "http") {
        const route = httpRoutes.get(endpoint.id);
        if (!route) {
          throw appError(
            500,
            "route_missing",
            "Compiled handler is unavailable.",
          );
        }
        if (route.inputSchema) {
          try {
            validateAgainstJsonSchema(
              route.inputSchema,
              request.body,
              "HTTP input",
            );
          } catch {
            throw appError(
              400,
              "invalid_input",
              "Request does not match the endpoint schema.",
            );
          }
        }
        const submit = async (
          actionId: string,
          input: unknown,
          options: {
            idempotencyKey?: string;
            actionMetadata?: Readonly<Record<string, unknown>>;
          } = {},
        ) => {
          const entry = Object.entries(application.plugins.actions).find((
            [, action],
          ) => action.id === actionId);
          if (!entry) {
            throw appError(404, "action_not_found", "Action was not found.");
          }
          const target = {
            ...endpoint,
            id: actionId,
            actionAlias: entry[0],
            inputSchema: entry[1].inputSchema,
          };
          return (await actionResponse(application, target, {
            ...request,
            body: input,
            headers: {
              ...request.headers,
              ...(options.idempotencyKey
                ? { "idempotency-key": options.idempotencyKey }
                : {}),
            },
          }, {
            ...context,
            serverActionMetadata: {
              ...context.serverActionMetadata,
              ...options.actionMetadata,
              ...(context.serverScope.actor
                ? { httpActor: context.serverScope.actor }
                : {}),
            },
          })).data;
        };
        const handlerContext: HttpHandlerContext = {
          request: context.serverRequest,
          endpoint,
          params: context.serverParams,
          input: request.body,
          scope: context.serverScope,
          sessions: {
            async create(input) {
              const runtime = context.databaseSchema
                ? await application.databaseScope(context.databaseSchema)
                : application;
              await runtime.authorization.createSession(
                context.serverScope.authority!,
                input,
              );
            },
            async revoke(
              id = context.serverScope.authority!.authorityBasis.id,
            ) {
              const runtime = context.databaseSchema
                ? await application.databaseScope(context.databaseSchema)
                : application;
              await runtime.authorization.revokeSession(
                context.serverScope.authority!,
                id,
              );
            },
          },
          read,
          async invoke(id, input, options) {
            const receipt = await submit(id, input, {
              ...(request.method === "GET"
                ? { idempotencyKey: crypto.randomUUID() }
                : {}),
              ...options,
            }) as {
              operationId: string;
            };
            for (;;) {
              context.serverSignal.throwIfAborted();
              const result = await operationResult(
                application,
                context,
                receipt.operationId,
              );
              if (result.status !== 202) return result.data;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          },
          operations: {
            checkpoint: operations.checkpoint,
            async observe(selection) {
              const stream = await operations.observe({
                ...selection,
                signal: context.serverSignal,
              });
              return applicationOutputsMultipartResponse(stream, {
                signal: context.serverSignal,
              });
            },
          },
          content: {
            async get(id) {
              const runtime =
                context.databaseSchema !== application.config.databaseSchema
                  ? await application.databaseScope(context.databaseSchema!)
                  : application;
              await runtime.authorization.asset(
                context.serverScope.authority!,
                id,
              );
              const content = await runtime.content.assets.read(
                context.namespace!,
                id,
              );
              await runtime.authorization.asset(
                context.serverScope.authority!,
                id,
              );
              return new Response(content.bytes.slice(), {
                headers: {
                  "content-type": content.asset.mediaType,
                  "cache-control": "no-store",
                },
              });
            },
          },
        } as const;
        if (route.action) {
          return {
            status: 202,
            data: await submit(
              route.action,
              route.input ? await route.input(handlerContext) : request.body,
            ),
          };
        }
        const result = await route.handler!(handlerContext);
        if (result instanceof Response) {
          return { status: result.status, data: result };
        }
        if (route.outputSchema) {
          validateAgainstJsonSchema(route.outputSchema, result, "HTTP output");
        }
        return { status: 200, data: result };
      }
      if (endpoint.kind === "collection") {
        const name = endpoint.collectionAlias!;
        if (
          endpoint.operation === "create" || endpoint.operation === "update" ||
          endpoint.operation === "delete" ||
          endpoint.operation?.startsWith("command:")
        ) {
          const runtime =
            context.databaseSchema !== application.config.databaseSchema
              ? await application.databaseScope(context.databaseSchema!)
              : application;
          const collection = runtime.collections.withScope({
            namespace: context.namespace!,
          })[endpoint.id];
          if (!collection) {
            throw appError(
              404,
              "collection_not_found",
              "Collection was not found.",
            );
          }
          return await collectionMutationResponse(
            application,
            endpoint,
            request,
            context,
            collection,
          );
        }
        if (endpoint.operation === "get") {
          const value = await read.get(name, context.serverParams.id);
          if (!value) {
            throw appError(404, "record_not_found", "Record was not found.");
          }
          return { status: 200, data: value };
        }
        if (endpoint.operation?.startsWith("query:")) {
          return {
            status: 200,
            data: await read.query(
              name,
              endpoint.member!,
              record(request.body),
            ),
          };
        }
        if (endpoint.operation === "list") {
          const query = request.query?.query;
          let requested;
          try {
            requested = typeof query === "string" ? JSON.parse(query) : {};
            if (
              !requested || typeof requested !== "object" ||
              Array.isArray(requested)
            ) throw new Error();
          } catch {
            throw appError(
              400,
              "invalid_query",
              "Query must be a JSON object.",
            );
          }
          const limit = requested.limit ?? 100;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 999) {
            throw appError(
              400,
              "invalid_query",
              "List limit must be 1 to 999.",
            );
          }
          const values = await read.list(name, {
            ...requested,
            limit: limit + 1,
          });
          return {
            status: 200,
            data: values.slice(0, limit),
            pageInfo: {
              hasMore: values.length > limit,
              next: values.length > limit ? values[limit - 1]?.id : undefined,
            },
          };
        }
        throw appError(
          405,
          "method_not_allowed",
          "Collection operation is not supported.",
        );
      }
      if (endpoint.kind === "operation") {
        if (
          endpoint.operation !== "observe" && endpoint.operation !== "result"
        ) {
          await operations.get(context.serverParams.id);
        }
        if (endpoint.operation === "result") {
          return await operationResult(
            application,
            context,
            context.serverParams.id,
          );
        }
        if (endpoint.operation === "observe") {
          const selection = record(request.body);
          if (
            !Array.isArray(selection.operationIds) ||
            selection.checkpoint !== undefined &&
              typeof selection.checkpoint !== "string"
          ) {
            throw appError(
              400,
              "invalid_operation_selection",
              "Invalid observation selection.",
            );
          }
          return {
            status: 200,
            data: await operations.observe({
              operationIds: selection.operationIds,
              checkpoint: selection.checkpoint as string | undefined,
              signal: context.serverSignal,
            }),
          };
        }

        if (endpoint.operation === "get") {
          return {
            status: 200,
            data: await operations.get(context.serverParams.id),
          };
        }
        return {
          status: 200,
          data: await withRetainedAuthority(
            context.serverScope.authority!,
            context.serverSignal,
            () =>
              application.cancelOperation({
                operationId: context.serverParams.id,
                namespace: context.namespace,
                databaseSchema: context.databaseSchema,
              }),
          ),
        };
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
      const physical =
        context.databaseSchema === application.config.databaseSchema
          ? application
          : await application.databaseScope(context.databaseSchema!);
      if (endpoint.kind === "channel") {
        const scoped = {
          ...application,
          ...physical,
          config: {
            ...application.config,
            databaseSchema: context.databaseSchema!,
          },
        } as const;
        const admitted = context;

        return await withRetainedAuthority(
          context.serverScope.authority!,
          context.serverSignal,
          () =>
            handleChannel(scoped, context.namespace!, {
              ...request,
              context: { ...admitted, actor: context.serverScope.actor },
            }, [endpoint.id]),
        );
      }
      if (endpoint.kind === "asset") {
        await physical.authorization.asset(
          context.serverScope.authority!,
          context.serverParams.id,
        );
        const content = await physical.content.assets.read(
          context.namespace!,
          context.serverParams.id,
        );
        await physical.authorization.asset(
          context.serverScope.authority!,
          context.serverParams.id,
        );
        return {
          status: 200,
          data: new Response(content.bytes.slice(), {
            headers: {
              "content-type": content.asset.mediaType,
              "cache-control": "no-store",
            },
          }),
        };
      }
      if (endpoint.kind === "agents") {
        return {
          status: 200,
          data: Object.values(application.plugins.resources.agents ?? {}).map(
            (value) => {
              const agent = value as {
                id: string;
                name: string;
                role?: string;
                description?: string;
              };
              return {
                id: agent.id,
                name: agent.name,
                role: agent.role,
                description: agent.description,
              };
            },
          ),
        };
      }
      throw appError(404, "route_not_found", "Route was not found.");
    },
  } as const;
  const fetch = createHttpFetchHandler(app, {
    basePath: facade.basePath,
    requestBodyPolicy(request) {
      const endpoint = routes.match(
        request.method,
        new URL(request.url).pathname,
      )?.endpoint;
      return endpoint?.kind === "asset" && endpoint.operation === "upload"
        ? {
          maxBytes: facade.maxAssetUploadBytes,
          tooLarge: {
            code: "asset_too_large",
            message: "Asset upload exceeds the configured byte limit.",
          },
        }
        : endpoint?.kind === "http"
        ? httpRoutes.get(endpoint.id)?.body ?? { maxBytes: 1024 * 1024 }
        : { maxBytes: 1024 * 1024 };
    },
    responseHeaders: options.responseHeaders,
    onError: options.onError,
    rawBody(_request, context) {
      const key = (context as FacadeContext | undefined)?.serverEndpointKey;
      const endpoint = routes.routes.find((route) => route.endpoint.key === key)
        ?.endpoint;
      if (endpoint?.kind === "asset" && endpoint.operation === "upload") {
        return {
          maxBytes: facade.maxAssetUploadBytes,
          tooLarge: {
            code: "asset_too_large",
            message: "Asset upload exceeds the configured byte limit.",
          },
        };
      }
      return endpoint?.kind === "http" &&
        httpRoutes.get(endpoint.id)?.body?.raw === true;
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
      return await authenticateHttpRequest(request, application, facade, match);
    },
  });
  const handler: HttpFetchHandler = async (request) => {
    if (
      new URL(request.url).pathname !== `${facade.basePath}/device`
    ) return fetch(request);
    const upgradeDevice = options.upgradeDevice ?? hostedDeviceUpgrade(request);
    if (!upgradeDevice) return fetch(request);
    if (
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    await options.admit?.();
    request.signal.throwIfAborted();
    const requestHeaders = new Headers(request.headers),
      requestUrl = request.url;
    const { socket, response, requestDeadline } = upgradeDevice(
      request,
    );
    trackHostedDeviceSocket(request, socket);
    attachDeviceSocket(socket, {
      requestDeadline,
      async authenticate(credentials) {
        if (
          !credentials || typeof credentials !== "object" ||
          Array.isArray(credentials)
        ) throw appError(403, "forbidden", "Session proof required");
        const headers = new Headers(requestHeaders);
        // Explicit proof changes authority; cookies on an already-open socket do not.
        for (const [key, value] of Object.entries(credentials)) {
          if (
            !["authorization", "cookie", "x-api-key"].includes(
              key.toLowerCase(),
            ) || typeof value !== "string"
          ) throw appError(403, "forbidden", "Invalid session proof");
          headers.set(key, value);
        }
        const session = await authenticateHttpRequest(
          new Request(requestUrl, { headers }),
          application,
          facade,
          {
            endpoint: {
              key: "device",
              kind: "http",
              id: "device",
              method: "GET",
              path: `${facade.basePath}/device`,
              operation: "connect",
            },
            params: {},
          },
        );
        if (session instanceof Response) {
          throw appError(
            session.status,
            "forbidden",
            "Device authentication refused",
          );
        }
        return {
          async observe(collection, query, observation) {
            const endpoint = routes.routes.find((route) =>
              route.endpoint.kind === "collection" &&
              route.endpoint.collectionAlias === collection &&
              route.endpoint.operation === "list"
            )?.endpoint;
            if (!endpoint) {
              throw appError(403, "forbidden", "Collection is not exposed");
            }
            const authenticated = await authenticateHttpRequest(
              new Request(new URL(endpoint.path, requestUrl), { headers }),
              application,
              facade,
              { endpoint, params: {} },
            );
            if (authenticated instanceof Response) {
              throw appError(
                authenticated.status,
                "forbidden",
                "Device authentication refused",
              );
            }
            const read = await createHttpReads(
              application,
              {
                ...authenticated.serverScope,
                authority: retainedAuthority({
                  ...authenticated.serverScope.authority!,
                  requestFacts: {
                    ...authenticated.serverScope.authority!.requestFacts,
                    transport: "websocket",
                  },
                }),
              },
              { context: authenticated },
            );
            return read.observe(collection, query, observation);
          },
        };
      },
    });
    return response;
  };
  return Object.assign(handler, { routes }) as ServerFacadeFetchHandler;
}
