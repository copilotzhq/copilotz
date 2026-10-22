/** Scoped, bounded read capabilities; policy predicates reach SQL before pagination. */
import { createHttpActionOrigins } from "./action-origins.ts";
import { withoutCollectionPolicyInvocation } from "../runtime/authorization/invocation.ts";
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import type { CollectionQuery } from "../runtime/collections/types.ts";
import type { FacadeContext } from "./context.ts";
import { withRetainedAuthority } from "../runtime/authorization/binding.ts";
import { validateAgainstJsonSchema } from "../runtime/collections/validate.ts";
import type { HttpReadServices } from "../plugins/server/authoring/http-adapter/index.ts";
import type {
  ServerAuthorizedScope,
} from "../plugins/server/shared/contracts.ts";

export async function createHttpReads(
  application: InternalCopilotzApplication,
  scope:
    & Pick<ServerAuthorizedScope, "namespace" | "databaseSchema">
    & Partial<Pick<ServerAuthorizedScope, "authority" | "actor">>,
  host: Readonly<{ context?: FacadeContext; domainProjection?: boolean }> = {},
): Promise<HttpReadServices> {
  const runtime = scope.databaseSchema &&
      scope.databaseSchema !== application.config.databaseSchema
    ? await application.databaseScope(scope.databaseSchema)
    : application;
  const collections = runtime.collections.withScope({
    namespace: scope.namespace ?? application.config.namespace!,
  });
  const bound = <T>(run: () => T | Promise<T>): Promise<T> =>
    scope.authority
      ? withRetainedAuthority(
        scope.authority,
        host.context?.serverSignal ?? new AbortController().signal,
        run,
      )
      : Promise.resolve().then(run);
  const definition = (name: string) => {
    const entry = Object.entries(application.plugins.collections).find((
      [alias, def],
    ) => alias === name || def.name === name);
    if (!entry) {
      throw Object.assign(new Error("Collection was not found."), {
        status: 404,
        code: "collection_not_found",
      });
    }
    return { collection: collections[entry[1].name], schema: entry[1] };
  };
  const read: HttpReadServices = {
    async observe(name, query = {}, options = {}) {
      const { schema } = definition(name);
      const alias = Object.keys(application.plugins.collections).find((key) =>
        application.plugins.collections[key] === schema
      )!;
      if (!scope.authority) {
        throw Object.assign(new Error("Retained authority is required."), {
          code: "forbidden",
          status: 403,
        });
      }
      return await runtime.observeCollection(
        scope.authority,
        alias,
        query,
        options,
      );
    },
    async get(name, id, options) {
      return (await read.list(name, { where: { id }, limit: 1 }, options))[0] ??
        null;
    },
    async list(name, query = {}, options) {
      const { collection } = definition(name);
      if (query.include?.length) {
        throw Object.assign(
          new Error("Unscoped relation includes are unavailable."),
          { status: 400, code: "invalid_query" },
        );
      }
      if (
        query.limit !== undefined &&
        (!Number.isSafeInteger(query.limit) || query.limit < 1 ||
          query.limit > 1000)
      ) {
        throw Object.assign(new Error("Read limit must be 1 to 1000."), {
          status: 400,
          code: "invalid_query",
        });
      }
      return await bound(() =>
        collection.list(
          {
            ...query,
            limit: query.limit ?? 100,
            all: query.all ?? [],
          } as CollectionQuery,
          options,
        )
      );
    },
    async aggregate(name, query, options) {
      const { collection } = definition(name);
      return await bound(
        () =>
          collection.aggregate({
            ...query,
            all: query.all ?? [],
          }, options),
      );
    },
    async query(name, queryName, input) {
      const selected = definition(name);
      const spec = selected.schema.queries?.[queryName];
      if (!spec) {
        throw Object.assign(new Error("Query was not found."), {
          status: 404,
          code: "query_not_found",
        });
      }
      if (spec.inputSchema) {
        try {
          validateAgainstJsonSchema(
            spec.inputSchema,
            input,
            "HTTP query input",
          );
        } catch {
          throw Object.assign(
            new Error("Input does not match the query schema."),
            {
              status: 400,
              code: "invalid_input",
            },
          );
        }
      }
      const value = await bound(() =>
        selected.collection.queries[queryName](input as Record<string, unknown>)
      );
      if (spec.outputSchema) {
        validateAgainstJsonSchema(
          spec.outputSchema,
          value,
          "HTTP query output",
        );
      }
      return value;
    },
  } as const;
  if (host.domainProjection === false) return read;
  return Object.values(application.plugins?.adapters?.http ?? {}).reduce<
    HttpReadServices
  >(
    (current, adapter) =>
      (adapter as import("../plugins/server/authoring/http-adapter/index.ts").HttpAdapter)
        .reads?.(current, scope as ServerAuthorizedScope) ?? current,
    read,
  );
}

/** Domain checks inspect canonical metadata, not the viewer's filtered evidence.
 * They may only narrow an asset grant already approved by the owner. */
export async function authorizeHttpAsset(
  application: InternalCopilotzApplication,
  scope: ServerAuthorizedScope,
  id: string,
): Promise<void> {
  const runtime = scope.databaseSchema &&
      scope.databaseSchema !== application.config.databaseSchema
    ? await application.databaseScope(scope.databaseSchema)
    : application;
  const namespace = scope.namespace ?? application.config.namespace!;
  const read = await createHttpReads(application, {
    namespace,
    databaseSchema: scope.databaseSchema,
  }, { domainProjection: false });
  const adapters = Object.values(
    application.plugins?.adapters?.http ?? {},
  ) as import("../plugins/server/authoring/http-adapter/index.ts").HttpAdapter[];
  await withoutCollectionPolicyInvocation(async () => {
    for (const adapter of adapters) {
      await adapter.authorizeAsset?.(id, scope, read);
    }
  });
  // A closed live stream also has a canonical Asset. Reuse its descriptor's
  // source ancestry so knowing that Asset id cannot bypass stream visibility.
  const asset = await runtime.content.assets.get(namespace, id);
  const streamId = asset?.metadata?.streamId;
  if (typeof streamId === "string") {
    const stream = await runtime.operations.findStream(namespace, streamId);
    if (stream) {
      const origins = createHttpActionOrigins(runtime, namespace);
      for (const adapter of adapters) {
        if (
          adapter.projectOutput &&
          !await adapter.projectOutput(
            stream
              .descriptor as import("../runtime/streams/types.ts").ApplicationOutput,
            scope,
            read,
            (run) => origins(stream.operationId, run),
          )
        ) {
          throw Object.assign(new Error("Message content was not found."), {
            status: 404,
            code: "message_content_not_found",
          });
        }
      }
    }
  }
}
