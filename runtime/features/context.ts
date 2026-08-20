import type { PluginRegistry } from "../plugins/index.ts";
import type {
  FeatureCallOptions,
  FeatureContext,
  FeatureContextBindings,
  FeatureInvoker,
  FeatureResource,
  FeatureResources,
} from "./types.ts";

function featureId(feature: FeatureResource): string {
  return feature.id.trim();
}

function featureAlias(feature: FeatureResource): string {
  const alias = feature.alias.trim();
  if (!/^[a-z][a-zA-Z0-9]*$/.test(alias)) {
    throw new TypeError(
      `Feature '${featureId(feature)}' has invalid alias '${alias}'.`,
    );
  }
  return alias;
}

export function createFeatureInvoker(
  registry: PluginRegistry,
  context: () => FeatureContext,
  transaction: FeatureContextBindings["transaction"],
): FeatureInvoker {
  if (!transaction) throw new TypeError("Feature transaction is required.");
  const aliases = new Map<string, string>();
  const entries = registry.list<FeatureResource>("features").map((resource) => {
    const id = featureId(resource);
    const alias = featureAlias(resource);
    const existing = aliases.get(alias);
    if (existing && existing !== id) {
      throw new TypeError(
        `Feature alias '${alias}' is declared by both '${existing}' and '${id}'.`,
      );
    }
    aliases.set(alias, id);
    const actions = Object.freeze(Object.fromEntries(
      Object.entries(resource.actions).map(([action, handler]) => [
        action,
        async (input?: unknown, options: FeatureCallOptions = {}) => {
          const featureContext = context();
          if (resource.mode === "read") {
            return await handler(input, featureContext);
          }
          const result = await transaction({
            operationKey: options.operationKey?.trim() ||
              `feature:${id}:${action}`,
            namespace: featureContext.namespace,
            ...(options.identity ? { identity: options.identity } : {}),
            execute: async () => await handler(input, featureContext),
          });
          return result.value;
        },
      ]),
    ));
    return [alias, actions] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

/** Builds a FeatureContext from engine primitives, not the application. */
export function createFeatureContext(
  bindings: FeatureContextBindings,
): FeatureContext {
  const namespace = bindings.namespace.trim();
  if (!namespace) throw new TypeError("Namespace must be non-empty.");
  const holder: { current?: FeatureContext } = {};
  const features = createFeatureInvoker(
    bindings.plugins,
    () => {
      if (!holder.current) {
        throw new Error("Feature context is not ready.");
      }
      return holder.current;
    },
    bindings.transaction ?? bindings.collectionRuntime.transaction,
  );
  const context: FeatureContext = Object.freeze({
    namespace,
    collections: Object.freeze({
      ...bindings.collections?.withScope({ namespace }),
      ...bindings.collectionRuntime.withScope({ namespace }),
    }),
    content: bindings.content?.(namespace) ?? Object.freeze({
      resolver: bindings.contentResolver,
      materialize() {
        throw new Error("Feature content materialization is not configured.");
      },
      linkOwner() {
        throw new Error("Feature content ownership is not configured.");
      },
    }),
    resources: {
      list: bindings.plugins.list,
      get: bindings.plugins.get,
      require: bindings.plugins.require,
      origin: bindings.plugins.origin,
    } satisfies FeatureResources,
    features,
    events: {
      list(options = {}) {
        return bindings.events.list({ ...options, namespace });
      },
    },
    deliveries: {
      list(options = {}) {
        return bindings.deliveries.list({ ...options, namespace });
      },
    },
    relations: {
      list(options = {}) {
        return bindings.relations.list({ ...options, namespace });
      },
    },
  });
  holder.current = context;
  return context;
}
