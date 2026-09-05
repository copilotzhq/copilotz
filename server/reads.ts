/** Scoped, bounded read capabilities; policy predicates reach SQL before pagination. */
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import type { CollectionQuery } from "../runtime/collections/types.ts";
import { validateAgainstJsonSchema } from "../runtime/collections/validate.ts";
import type { HttpReadServices } from "../plugins/server/authoring/http-adapter/index.ts";
import type {
  ServerAuthorizedScope,
  ServerConstraints,
} from "../plugins/server/internal/contracts.ts";

export async function createHttpReads(
  application: InternalCopilotzApplication,
  scope: ServerAuthorizedScope,
  constraints: ServerConstraints = {},
): Promise<HttpReadServices> {
  const runtime = scope.databaseSchema &&
      scope.databaseSchema !== application.config.databaseSchema
    ? await application.databaseScope(scope.databaseSchema)
    : application;
  const collections = runtime.collections.withScope({
    namespace: scope.namespace ?? application.config.namespace!,
  });
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
    const policy = constraints.collections?.[entry[1].name] ??
      constraints.collections?.[entry[0]];
    if (constraints.collections && !policy) {
      throw Object.assign(new Error("Collection access denied."), {
        status: 403,
        code: "forbidden",
      });
    }
    return { collection: collections[entry[1].name], schema: entry[1], policy };
  };
  const read: HttpReadServices = Object.freeze({
    async get(name, id) {
      return (await read.list(name, { where: { id }, limit: 1 }))[0] ?? null;
    },
    async list(name, query = {}) {
      const { collection, policy } = definition(name);
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
      return await collection.list(
        {
          ...query,
          limit: query.limit ?? 100,
          all: [...(query.all ?? []), ...(policy ? [policy] : [])],
        } as CollectionQuery,
      );
    },
    async query(name, queryName, input) {
      const spec = definition(name).schema.queries?.[queryName];
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
      const value = spec.select
        ? await spec.select({ input, read })
        : await read.list(
          name,
          spec.query
            ? spec.query({ input })
            : { where: spec.filter?.({ input }) },
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
  });
  return read;
}
