import { constrainInput } from "./input.ts";
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
} from "../plugins/server/internal/contracts.ts";
import type { HttpApplication } from "./http-types.ts";
import { admitHttpOperation } from "./admission.ts";
import { createHttpFetchHandler, type HttpFetchHandler } from "./fetch.ts";
import { assetUploadResponse } from "./assets.ts";
import { actionResponse, operationResult } from "./actions.ts";

export type CreateServerFacadeFetchHandlerOptions = Readonly<{
  facade?: ServerFacadeResource;
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
      "Server facade requires createServerPlugin() in the application composition.",
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
  const facade = facadeResource(application, options.facade);
  const routes = compileServerRoutes(application.plugins, facade);
  const app: HttpApplication = Object.freeze({
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
        context.serverConstraints,
      );
      const operations = await createHttpOperations(
        application,
        context.serverScope,
        context.serverConstraints,
        read,
      );
      if (endpoint.kind === "http") {
        const route = Object.values(application.plugins.adapters.http ?? {})
          .flatMap((adapter) => (adapter as HttpAdapter).routes).find((route) =>
            route.id === endpoint.id
          );
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
            },
          })).data;
        };
        const handlerContext: HttpHandlerContext = Object.freeze({
          request: context.serverRequest,
          endpoint,
          params: context.serverParams,
          input: request.body,
          scope: context.serverScope,
          constraints: context.serverConstraints,
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
              const content = await runtime.content.assets.read(
                context.namespace!,
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
        });
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
        throw appError(405, "method_not_allowed", "Mutations require Actions.");
      }
      if (endpoint.kind === "operation") {
        if (endpoint.operation !== "observe") {
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
          data: await application.cancelOperation({
            operationId: context.serverParams.id,
            namespace: context.namespace,
            databaseSchema: context.databaseSchema,
          }),
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
        const scoped = Object.freeze({
          ...application,
          ...physical,
          config: {
            ...application.config,
            databaseSchema: context.databaseSchema!,
          },
        });
        const admitted = await admitHttpOperation(
          application,
          context,
          request.headers?.["idempotency-key"] ?? "",
        );
        return await handleChannel(scoped, context.namespace!, {
          ...request,
          body: constrainInput(request.body, context.serverConstraints.input),
          context: { ...admitted, actor: context.serverScope.actor },
        }, [endpoint.id]);
      }
      if (endpoint.kind === "asset") {
        const content = await physical.content.assets.read(
          context.namespace!,
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
  });
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
        : { maxBytes: 1024 * 1024 };
    },
    responseHeaders: options.responseHeaders,
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
            message: "Asset upload exceeds the configured byte limit.",
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
      return await authenticateHttpRequest(request, application, facade, match);
    },
  });
  return Object.assign(fetch, { routes }) as ServerFacadeFetchHandler;
}
