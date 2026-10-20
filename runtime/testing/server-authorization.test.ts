import { ActionError } from "../actions/errors.ts";
import { coreThreadObservationKey } from "../../plugins/core/shared/events/index.ts";
/** Native owner-policy fixtures for transport tests; no production compatibility API. */
import { defineServerFacade } from "../../plugins/server/resources/facade/index.ts";
import type {
  DefineServerFacadeInput,
  ServerAuthorizedScope,
  ServerConstraints,
  ServerEndpointDescriptor,
  ServerFacadeResource,
} from "../../plugins/server/shared/contracts.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createCopilotzApplication } from "../application/application.ts";
import { createCopilotz } from "../../create-copilotz.ts";
import { bindTestActions, testAuthority } from "./authority.ts";
import type {
  AuthorizationIntent,
  OwnerAuthorization,
} from "../authorization/evaluator.ts";
import type { HttpReadServices } from "../../plugins/server/authoring/http-adapter/index.ts";

type FixturePolicy = (
  request: Request,
  context: {
    scope: ServerAuthorizedScope;
    endpoint: ServerEndpointDescriptor;
    read: HttpReadServices;
    intent: AuthorizationIntent;
  },
) => ServerConstraints | Response | Promise<ServerConstraints | Response>;
const policies = new WeakMap<ServerFacadeResource, FixturePolicy>();
export function defineTestServerFacade(
  input: DefineServerFacadeInput & { evaluate?: FixturePolicy } = {},
): ServerFacadeResource {
  const { evaluate, ...options } = input;
  const facade = defineServerFacade({
    ...options,
    async authenticate(request, context) {
      const selected = await options.authenticate?.(request, context) ?? {};
      if (selected instanceof Response) return selected;
      const scope = {
        ...selected,
        namespace: selected.namespace ?? context.defaultNamespace!,
        databaseSchema: selected.databaseSchema ??
          context.defaultDatabaseSchema,
      };
      return {
        ...scope,
        authority: {
          ...testAuthority(
            scope.databaseSchema,
            scope.namespace,
            scope.actor?.id ?? "viewer",
          ),
          provenance: { ingress: "http", source: context.endpoint.key },
          requestFacts: {
            endpoint: context.endpoint.key,
            transport: "http",
            operation: context.endpoint.operation ?? context.endpoint.kind,
            params: context.params,
            input: JSON.parse(
              JSON.stringify({
                path: new URL(request.url).pathname,
                method: request.method,
                headers: [...request.headers],
                endpoint: context.endpoint,
                actor: scope.actor ?? null,
              }),
            ),
          },
        },
      };
    },
  });
  if (evaluate) policies.set(facade, evaluate);
  return facade;
}
function fixtureOptions<
  T extends Parameters<typeof createCopilotzApplication>[0],
>(options: T): T {
  const registry = createPluginRegistry(options);
  const selected = registry.resources.server?.default as
    | ServerFacadeResource
    | undefined;
  if (!selected) return options;
  const policy = policies.get(selected);
  const collectionRefs = Object.fromEntries(
    Object.keys(registry.collections).map((
      alias,
    ) => [alias, { id: "fixture", revision: "1" }]),
  );
  const actionRefs = Object.fromEntries(
    Object.keys(registry.actions).map((
      alias,
    ) => [alias, { id: "fixture", revision: "1" }]),
  );
  const actions = Object.fromEntries(
    Object.keys(registry.actions).map((alias) => [alias, {}]),
  );
  const collections = Object.fromEntries(
    Object.keys(registry.collections).map((alias) => [alias, {}]),
  );
  const mutations = Object.fromEntries(
    Object.entries(registry.collections).map((
      [alias, definition],
    ) => [alias, {
      create: {},
      update: {},
      delete: {},
      commands: Object.fromEntries(
        Object.keys(definition.commands ?? {}).map((name) => [name, {}]),
      ),
    }]),
  );
  const authorization: OwnerAuthorization = {
    policies: {
      fixture: {
        revision: "1",
        sources: Object.keys(registry.collections),
        async evaluate({ authority, read, intent }) {
          if (authority.principal.id === "fixture-host") {
            return {
              actions,
              collections,
              collectionMutations: mutations,
              operations: { metadata: {} },
            };
          }
          const facts = authority.requestFacts.input as {
            path: string;
            method: string;
            headers: [string, string][];
            endpoint: ServerEndpointDescriptor;
            actor: ServerAuthorizedScope["actor"];
          };
          const constraints = policy
            ? await policy(
              new Request(`https://fixture.invalid${facts.path}`, {
                method: facts.method,
                headers: facts.headers,
              }),
              {
                scope: {
                  namespace: authority.scope.namespace,
                  databaseSchema: authority.scope.databaseSchema,
                  ...(facts.actor ? { actor: facts.actor } : {}),
                },
                endpoint: facts.endpoint,
                intent,
                read: {
                  observe: () =>
                    Promise.reject(
                      new Error("Policy sources cannot subscribe"),
                    ),
                  get: read.get,
                  list: read.list,
                  aggregate: () =>
                    Promise.reject(
                      new Error("Declare the fixture aggregate source"),
                    ),
                  query: () =>
                    Promise.reject(
                      new Error("Declare the fixture named source"),
                    ),
                },
              },
            )
            : {};
          if (constraints instanceof Response) {
            const value = await constraints.json().catch(() => ({}));
            throw Object.assign(
              new ActionError(value.error?.message ?? "Forbidden", {
                code: value.error?.code ?? "forbidden",
                status: constraints.status,
              }),
              {
                code: value.error?.code ?? "forbidden",
                status: constraints.status,
              },
            );
          }
          const thread = constraints.operations?.metadata.threadId;
          return {
            actions,
            events: ["copilotz.channels.ingress.input"],
            collections,
            ...(!policy ? { collectionMutations: mutations } : {}),
            operations: { metadata: {} },
            ...constraints,
            ...(typeof thread === "string"
              ? { observationKeys: [coreThreadObservationKey(thread)] }
              : {}),
          };
        },
      },
    },
    collections: collectionRefs,
    actions: actionRefs,
  };
  return {
    ...options,
    authorization: options.authorization ?? authorization,
    resources: {
      ...options.resources,
      server: {
        ...options.resources?.server,
        default: selected && policies.has(selected)
          ? selected
          : selected?.authenticate
          ? selected
          : defineTestServerFacade(selected),
      },
    },
  };
}
function hostScope<T extends object>(
  value: T,
  schema: string,
  namespace: string,
  publicHost = false,
): T {
  const authority = testAuthority(schema, namespace, "fixture-host");
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = Object.defineProperties(
    Object.create(Object.getPrototypeOf(value)),
    Object.getOwnPropertyDescriptors(value),
  );
  const databaseScope = record.databaseScope;
  if (typeof databaseScope === "function") {
    result.databaseScope = async (selected: string) =>
      hostScope(
        await Reflect.apply(databaseScope, value, [selected]) as object,
        selected,
        namespace,
      );
  }
  if (!publicHost && record.actions && typeof record.actions === "object") {
    result.actions = bindTestActions(record.actions, authority);
  }
  if (record.engine && typeof record.engine === "object") {
    result.engine = hostScope(record.engine, schema, namespace);
  }
  if (record.host && typeof record.host === "object") {
    result.host = hostScope(record.host, schema, namespace, true);
  }
  const collections = record.collections as Record<string, unknown> | undefined;
  if (collections && !publicHost) {
    const bindCollections = (
      scope: Record<string, object>,
      selectedNamespace = namespace,
    ) =>
      Object.fromEntries(
        Object.entries(scope).map((
          [key, collection],
        ) => [
          key,
          bindTestActions(
            collection,
            testAuthority(schema, selectedNamespace, "fixture-host"),
          ),
        ]),
      );
    result.collections = typeof collections.withScope === "function"
      ? {
        ...collections,
        ...(typeof collections.get === "function"
          ? {
            get: (...args: unknown[]) => {
              const collection = Reflect.apply(
                collections.get as (...args: unknown[]) => object,
                collections,
                args,
              );
              return collection
                ? new Proxy(collection, {
                  get(target, key) {
                    const member = Reflect.get(target, key);
                    if (typeof member !== "function") return member;
                    return (...input: unknown[]) =>
                      Reflect.apply(
                        bindTestActions(
                          { call: member },
                          testAuthority(
                            schema,
                            (input[0] as { namespace?: string })?.namespace ??
                              namespace,
                            "fixture-host",
                          ),
                        ).call,
                        target,
                        input,
                      );
                  },
                })
                : collection;
            },
          }
          : {}),
        withScope: (...args: unknown[]) =>
          bindCollections(
            Reflect.apply(
              collections.withScope as (
                ...args: unknown[]
              ) => Record<string, object>,
              collections,
              args,
            ),
            (args[0] as { namespace?: string })?.namespace ?? namespace,
          ),
      }
      : bindCollections(collections as Record<string, object>);
  }
  return result as T;
}
export const createTestApplication: typeof createCopilotzApplication = async (
  options,
  ...rest
) => {
  const application = await createCopilotzApplication(
    fixtureOptions(options),
    ...rest,
  );
  return hostScope(
    application,
    application.config.databaseSchema,
    application.config.namespace!,
  );
};
export const createTestCopilotz =
  (async (options: Parameters<typeof createCopilotz>[0]) => {
    if ((options as { role?: string } | undefined)?.role === "worker") {
      return await createCopilotz(options);
    }
    const configured = fixtureOptions(
      options as Parameters<typeof createCopilotzApplication>[0],
    );
    const application = await createCopilotz(configured);
    return hostScope(
      application,
      configured.databaseSchema ?? "public",
      configured.namespace ?? "default",
      true,
    );
  }) as typeof createCopilotz;
