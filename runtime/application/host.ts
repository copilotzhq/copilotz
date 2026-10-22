import {
  captureCollectionInvocation,
  withOwnerCollectionInvocation,
} from "../authorization/invocation.ts";
import { collectionAssetAdopterFor } from "../content/database-repository.ts";
import { hostIngressProof } from "./ingress/authority.ts";
/** Trusted in-process ingress and reads over the ordinary application runtime. @module */
import type { ActionSchema } from "../actions/types.ts";
import type {
  CollectionQuery,
  CollectionRecord,
} from "../collections/index.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import {
  validateAgainstJsonSchema,
  validateCollectionInput,
} from "../collections/validate.ts";
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
    const app = application();
    const drained = (async () => {
      for await (const output of handle.outputs) {
        if (isStreamOutput(output)) await output.payload.cancel();
      }
    })();
    void drained.catch(() => {});
    void handle.done.catch(() => {});
    let closeWatch = () => {};
    try {
      const runtime = await app.databaseScope(boundary.databaseSchema!);
      // Subscribe before reading, including when completion preceded this call.
      const changes = await runtime.operations.watch(handle.operationId, {
        namespace: boundary.namespace!,
      });
      closeWatch = () => changes.close();
      for (;;) {
        const recorded = await recordedOperationResult(
          app,
          boundary,
          handle.operationId,
          "host",
        );
        if (!recorded.pending) return recorded.value;
        await changes.wait();
      }
    } finally {
      closeWatch();
      await handle.detach("host_result_returned");
      await drained.catch(() => {});
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
      validateCollectionInput(
        inputSchema,
        input,
        "Collection mutation input",
      );
    }
    const { id: requestId, envelope } = admission(options);
    const inlineContent = !definition.content || collectionAssetAdopterFor(
      (await application().databaseScope(envelope.databaseSchema)).content
        .assets,
    ).prepareInCommand;
    const completion:
      import("./ingress/inline-collection.ts").InlineCollectionCompletion = {};
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
      hostIngressProof(),
      inlineContent ? completion : undefined,
    );
    return !inlineContent || completion.deferred
      ? await result(handle, envelope)
      : completion.value;
  };
  const actions: ApplicationActions = bindings(
    Object.entries(registry.actions).map((
      [alias, action],
    ) => [alias, async (input, options = {}) => {
      input = structuredClone(input);
      if (action.inputSchema) {
        validateAgainstJsonSchema(action.inputSchema, input, "Action input");
      }
      const { id, envelope } = admission(options);
      const handle = await admitActionRequest(
        application(),
        {
          ...envelope,
          type: SERVER_ACTION_REQUEST_EVENT_TYPE,
          payload: {
            schema: SERVER_ACTION_REQUEST_SCHEMA,
            requestId: id,
            actionAlias: alias,
            input,
            actionMetadata: structuredClone(options.actionMetadata ?? {}),
          },
        },
        action.inputSchema,
        hostIngressProof(),
        true,
      );
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
      async observe(query = {}, options = {}) {
        const authority = options.authority ??
          captureCollectionInvocation()?.authority;
        if (!authority) {
          throw Object.assign(
            new Error("Subscription requires retained authority."),
            { code: "forbidden" },
          );
        }
        const boundary = scope(options);
        if (
          authority.scope.namespace !== boundary.namespace ||
          authority.scope.databaseSchema !== boundary.databaseSchema
        ) throw new TypeError("Subscription authority scope mismatch.");
        const runtime = await application().databaseScope(
          boundary.databaseSchema,
        );
        return await runtime.observeCollection(
          authority,
          alias,
          query,
          options,
        );
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
  // Public host services are trusted capabilities. An existing invocation keeps
  // its narrower authority, including when an HTTP handler calls a host method.
  const bindHost = <T extends object>(value: T, path: readonly string[]): T => {
    const bound = Object.create(Object.getPrototypeOf(value));
    for (const [key, member] of Object.entries(value)) {
      bound[key] = typeof member === "function"
        ? async (...args: unknown[]) => {
          const invocation = captureCollectionInvocation();
          if (invocation?.callHostCapability) {
            return invocation.callHostCapability(
              [...path, key],
              args,
              scope((args[1] ?? {}) as ApplicationScope),
            );
          }
          if (invocation) {
            return Reflect.apply(member, value, args);
          }
          const options = (args[1] ?? {}) as ApplicationReadOptions;
          const boundary = scope(options);
          const signal = options.signal ?? new AbortController().signal;
          return await withOwnerCollectionInvocation({
            trustedHost: true,
            scope: boundary,
            signal,
            invocation: {
              kind: "processor",
              id: "host",
              runId: crypto.randomUUID(),
            },
            check: () => signal.throwIfAborted(),
            resolveSource: () =>
              Promise.reject(new Error("Host reads have no execution source.")),
          }, () => Reflect.apply(member, value, args));
        }
        : member && typeof member === "object" && key !== "definition"
        ? bindHost(member, [...path, key])
        : member;
    }
    return bound;
  };
  return {
    actions: bindHost(actions, ["actions"]),
    collections: bindHost(collections, ["collections"]),
  };
}
