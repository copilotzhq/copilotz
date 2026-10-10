/** Trusted in-process ingress and reads over the ordinary application runtime. @module */
import type { ActionSchema } from "../actions/types.ts";
import type {
  CollectionQuery,
  CollectionRecord,
} from "../collections/index.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { isStreamOutput } from "../streams/index.ts";
import type {
  ApplicationActions,
  ApplicationCallOptions,
  ApplicationCollections,
  ApplicationReadOptions,
  ApplicationScope,
  ApplicationSendHandle,
  CopilotzApplication,
  InternalCopilotzApplication,
} from "./types.ts";
import {
  admitActionRequest,
  admitCollectionMutationRequest,
} from "./ingress/admit.ts";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_ACTION_REQUEST_SCHEMA,
  SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
  SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA,
  type ServerCollectionMutationRequest,
} from "./ingress/contracts.ts";
import {
  createInputSchema,
  updateInputSchema,
} from "./ingress/mutation-schema.ts";
import { recordedOperationResult } from "./ingress/result.ts";

/** Own, enumerable bindings only; inherited Object names are never callers. */
function bindings<T>(
  entries: readonly (readonly [string, T])[],
): Record<string, T> {
  return Object.assign(Object.create(null), Object.fromEntries(entries));
}

export function createHostServices(
  application: () => InternalCopilotzApplication,
  registry: PluginRegistry,
): Pick<CopilotzApplication, "actions" | "collections"> {
  const scope = (options: ApplicationScope = {}) => {
    const app = application();
    const namespace = options.namespace?.trim() || app.config.namespace;
    if (!namespace) {
      throw new TypeError(
        "A tenant namespace is required on the application or call.",
      );
    }
    return {
      namespace,
      databaseSchema: options.databaseSchema?.trim() ||
        app.config.databaseSchema,
    };
  };
  const collection = async (alias: string, options: ApplicationScope = {}) => {
    const definition = registry.collections[alias];
    const boundary = scope(options);
    const runtime = await application().databaseScope(boundary.databaseSchema);
    return runtime.collections.withScope({
      namespace: boundary.namespace,
    })[definition.name];
  };
  const admission = (options: ApplicationCallOptions = {}) => {
    const id = options.idempotencyKey === undefined
      ? crypto.randomUUID()
      : options.idempotencyKey.trim();
    if (!id) throw new TypeError("Idempotency key must be non-empty.");
    return {
      // Keep result recovery identity aligned with the durable admission key.
      // HTTP and host calls may deliberately share a correlation ID.
      id: `host:${id}`,
      envelope: {
        ...scope(options),
        correlationId: options.correlationId ?? `host:${id}`,
        causationId: options.causationId,
        deduplicationId: `host:${id}`,
        metadata: options.metadata,
        operationMetadata: options.operationMetadata,
      },
    };
  };
  const result = async (
    handle: ApplicationSendHandle,
    boundary: ApplicationScope,
  ) => {
    // Result-only callers own no progressive readers. Drain observations while
    // settlement runs, releasing each subscriber-owned byte stream immediately.
    const drained = (async () => {
      for await (const output of handle.outputs) {
        if (isStreamOutput(output)) await output.payload.cancel();
      }
    })();
    try {
      const settled = await Promise.allSettled([handle.done, drained]);
      for (const value of settled) {
        if (value.status === "rejected") throw value.reason;
      }
      const recorded = await recordedOperationResult(
        application(),
        boundary,
        handle.operationId,
      );
      if (recorded.pending) {
        throw new Error("Operation result is not yet recorded.");
      }
      return recorded.value;
    } finally {
      await handle.detach("host_result_returned");
    }
  };
  const mutate = async (
    alias: string,
    operation: ServerCollectionMutationRequest["operation"],
    input: unknown,
    options: ApplicationCallOptions = {},
    id?: string,
    command?: string,
  ) => {
    const definition = registry.collections[alias];
    const schema = typeof definition.schema === "object"
      ? definition.schema
      : undefined;
    const commandDefinition = command === undefined
      ? undefined
      : definition.commands?.[command];
    if (operation !== "create" && !id?.trim()) {
      throw new TypeError("Record id must be non-empty.");
    }
    const inputSchema = operation === "create"
      ? createInputSchema(schema, definition.defaults)
      : operation === "update"
      ? updateInputSchema(schema)
      : operation === "command"
      ? commandDefinition?.input
      : undefined;
    input = structuredClone(input);
    if (inputSchema && typeof inputSchema === "object") {
      validateAgainstJsonSchema(
        inputSchema,
        input,
        "Collection mutation input",
      );
    }
    const { id: requestId, envelope } = admission(options);
    const handle = await admitCollectionMutationRequest(
      application(),
      {
        ...envelope,
        type: SERVER_COLLECTION_MUTATION_REQUEST_EVENT_TYPE,
        payload: {
          schema: SERVER_COLLECTION_MUTATION_REQUEST_SCHEMA,
          requestId,
          collectionAlias: alias,
          operation,
          input,
          ...(id === undefined ? {} : { id }),
          ...(command === undefined ? {} : { command }),
        },
      },
      typeof inputSchema === "object" ? inputSchema as ActionSchema : undefined,
    );
    return await result(handle, envelope);
  };
  const actions: ApplicationActions = bindings(
    Object.entries(registry.actions).filter(([alias]) =>
      alias !== "serverInvoke"
    )
      .map(([alias, action]) => [alias, async (input, options = {}) => {
        input = structuredClone(input);
        if (action.inputSchema) {
          validateAgainstJsonSchema(action.inputSchema, input, "Action input");
        }
        const { id, envelope } = admission(options);
        const handle = await admitActionRequest(application(), {
          ...envelope,
          type: SERVER_ACTION_REQUEST_EVENT_TYPE,
          payload: {
            schema: SERVER_ACTION_REQUEST_SCHEMA,
            requestId: id,
            actionAlias: alias,
            input,
            actionMetadata: structuredClone(options.actionMetadata ?? {}),
          },
        }, action.inputSchema);
        return await result(handle, envelope);
      }]),
  );
  const collections: ApplicationCollections = bindings(
    Object.entries(registry.collections).map(([alias, definition]) => [alias, {
      definition: {
        name: definition.name,
        schema: definition.schema,
        relations: definition.relations,
      },
      async get(input: { id: string }, options: ApplicationReadOptions = {}) {
        return await (await collection(alias, options)).get(input, options);
      },
      async list(
        query?: CollectionQuery,
        options: ApplicationReadOptions = {},
      ) {
        return await (await collection(alias, options)).list(query, options);
      },
      async search(
        query: CollectionQuery,
        options: ApplicationReadOptions = {},
      ) {
        return await (await collection(alias, options)).search(query, options);
      },
      async aggregate(query, options = {}) {
        return await (await collection(alias, options)).aggregate(
          query,
          options,
        );
      },
      relations: {
        async list(query, options = {}) {
          return await (await collection(alias, options)).relations.list(
            query,
            options,
          );
        },
      },
      queries: bindings(
        Object.keys(definition.queries ?? {}).map((
          name,
        ) => [
          name,
          async (input = {}, options = {}) =>
            await (await collection(alias, options)).queries[name](
              input,
              options,
            ),
        ]),
      ),
      async create(input, options) {
        return await mutate(
          alias,
          "create",
          input,
          options,
        ) as CollectionRecord;
      },
      async update({ id, ...patch }, options) {
        return await mutate(
          alias,
          "update",
          patch,
          options,
          id,
        ) as CollectionRecord;
      },
      async delete({ id }, options) {
        return await mutate(alias, "delete", {}, options, id) as Readonly<
          { id: string; deleted: true }
        >;
      },
      commands: bindings(
        Object.keys(definition.commands ?? {}).map((
          name,
        ) => [name, async ({ id, ...input }, options) =>
          await mutate(
            alias,
            "command",
            input,
            options,
            id,
            name,
          ) as CollectionRecord]
        ),
      ),
    }]),
  );
  return { actions, collections };
}
