import type { PluginRegistry } from "../plugins/index.ts";
import type {
  FeatureContext,
  FeatureContextBindings,
  FeatureInvoker,
  FeatureResource,
  FeatureResources,
} from "./types.ts";

function featureId(feature: FeatureResource): string {
  return feature.id.trim();
}

export function createFeatureInvoker(
  registry: PluginRegistry,
  context: () => FeatureContext,
): FeatureInvoker {
  return Object.freeze({
    async invoke(resourceId, action, input) {
      const resource = registry.list<FeatureResource>("features").find(
        (candidate) => featureId(candidate) === resourceId.trim(),
      );
      const handler = resource?.actions[action];
      if (!resource || !handler) {
        throw new Error(
          `Feature '${resourceId.trim()}.${action}' is not registered.`,
        );
      }
      return await handler(input, context());
    },
  });
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
  );
  const context: FeatureContext = Object.freeze({
    namespace,
    collections: bindings.collections.withScope({ namespace }),
    collectionRuntime: bindings.collectionRuntime,
    transaction: (input) =>
      bindings.collectionRuntime.transaction({
        ...input,
        namespace: input.namespace ?? namespace,
      }),
    content: Object.freeze({ resolver: bindings.contentResolver }),
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
