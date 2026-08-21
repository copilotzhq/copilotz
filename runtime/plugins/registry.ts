import type {
  DurableConsumerObligation,
  DurableEventDraft,
} from "../events/types.ts";
import { matchProcessor } from "./match.ts";
import {
  isProcessor,
  type Processor,
  processorConsumerId,
  processorIdFromConsumer,
} from "./processor.ts";
import {
  type CopilotzPlugin,
  INTERNAL_PLUGIN_RESOURCE_TYPES,
  type PluginContextContribution,
  type PluginContextValues,
  type PluginResources,
  type PluginResourceType,
  stablePluginResourceId,
} from "./types.ts";

function rejectStaticWildcardProcessor(value: object, id: string): void {
  if (!isProcessor(value)) return;
  if (value.on.some((clause) => clause.eventType === "*")) {
    throw new TypeError(
      `Processor '${id}' cannot register eventType '*' as a static resource.`,
    );
  }
}

function contextNamespaceForResourceType(
  type: PluginResourceType,
): string | undefined {
  switch (type) {
    case "agents":
      return "agents";
    case "tools":
      return "tools";
    case "llm":
      return "llm";
    case "api":
      return "apis";
    case "mcp":
      return "mcp";
    case "skills":
      return "skills";
    case "features":
      return "featureDefinitions";
    case "embedding":
      return "embeddings";
    case "memoryKinds":
      return "memoryKinds";
    case "channels":
      return "channels";
    default:
      return undefined;
  }
}

export type PluginRegistry = Readonly<{
  plugins: readonly CopilotzPlugin[];
  context: PluginContextValues;
  collections: Readonly<{
    list(): readonly object[];
    get(id: string): object | undefined;
    require(id: string): object;
  }>;
  processors: Readonly<{
    list(): readonly Processor[];
    get(id: string): Processor | undefined;
    matchDurable(
      draft: DurableEventDraft,
      data?: unknown,
    ): readonly Processor[];
    durableConsumers(
      draft: DurableEventDraft,
      data?: unknown,
    ): readonly DurableConsumerObligation[];
    processorForConsumer(consumerId: string): Processor | undefined;
  }>;
}>;

export type CreatePluginRegistryOptions = {
  core?: CopilotzPlugin | readonly CopilotzPlugin[];
  plugins?: readonly CopilotzPlugin[];
  context?: PluginContextContribution;
};

/**
 * Composes core, declared plugins in order, then explicit application
 * resources. A later stable ID replaces an earlier one for that resource type.
 */
export function createPluginRegistry(
  options: CreatePluginRegistryOptions = {},
): PluginRegistry {
  const maps = new Map<PluginResourceType, Map<string, object>>();
  for (const type of INTERNAL_PLUGIN_RESOURCE_TYPES) {
    maps.set(type, new Map());
  }
  const contextMaps = new Map<string, Map<string, unknown>>();
  const plugins: CopilotzPlugin[] = [];
  const pluginIds = new Map<string, CopilotzPlugin>();

  const add = (resources: PluginResources): void => {
    for (const type of INTERNAL_PLUGIN_RESOURCE_TYPES) {
      const values = resources[type];
      if (!values) continue;
      const map = maps.get(type)!;
      for (const value of values) {
        const id = stablePluginResourceId(type, value);
        if (type === "processors") rejectStaticWildcardProcessor(value, id);
        map.delete(id);
        map.set(id, value);
      }
    }
  };

  const addResourceContext = (resources: PluginResources): void => {
    for (const type of INTERNAL_PLUGIN_RESOURCE_TYPES) {
      const namespace = contextNamespaceForResourceType(type);
      if (!namespace) continue;
      const values = resources[type];
      if (!values) continue;
      const map = contextMaps.get(namespace) ?? new Map<string, unknown>();
      contextMaps.set(namespace, map);
      for (const value of values) {
        map.set(stablePluginResourceId(type, value), value);
      }
    }
  };

  const addContext = (context: PluginContextContribution): void => {
    for (const [namespace, values] of Object.entries(context)) {
      const map = contextMaps.get(namespace) ?? new Map<string, unknown>();
      contextMaps.set(namespace, map);
      for (const [key, value] of Object.entries(values)) {
        map.set(key, value);
      }
    }
  };

  const register = (
    pluginInput: CopilotzPlugin,
    resources = pluginInput.resources,
    stack: readonly string[] = [],
  ): CopilotzPlugin => {
    const plugin = pluginInput;
    const id = plugin.manifest.id;
    if (stack.includes(id)) {
      throw new TypeError(
        `Plugin dependency cycle detected: ${[...stack, id].join(" -> ")}.`,
      );
    }
    const existing = pluginIds.get(id);
    if (existing) {
      if (existing === plugin) return existing;
      throw new TypeError(
        `Plugin '${id}' was declared more than once.`,
      );
    }
    for (const dependency of plugin.plugins) {
      register(dependency, dependency.resources, [...stack, id]);
    }
    pluginIds.set(id, plugin);
    plugins.push(plugin);
    add(resources);
    addResourceContext(resources);
    addContext(plugin.context);
    return plugin;
  };

  const corePlugins = options.core
    ? Array.isArray(options.core) ? options.core : [options.core]
    : [];
  for (const plugin of corePlugins) register(plugin);

  for (const plugin of options.plugins ?? []) register(plugin);

  if (options.context) {
    addContext(options.context);
  }

  const context = Object.freeze(Object.fromEntries(
    [...contextMaps.entries()].map(([namespace, values]) => [
      namespace,
      Object.freeze(Object.fromEntries(values.entries())),
    ]),
  )) as PluginContextValues;

  const listProcessors = (): readonly Processor[] =>
    [...maps.get("processors")!.values()].filter(isProcessor);

  const matchDurable = (
    draft: DurableEventDraft,
    data?: unknown,
  ): readonly Processor[] =>
    Object.freeze(
      listProcessors().filter((processor) =>
        matchProcessor(processor, draft, data)
      ),
    );

  const durableConsumers = (
    draft: DurableEventDraft,
    data?: unknown,
  ): readonly DurableConsumerObligation[] =>
    Object.freeze(
      matchDurable(draft, data).map((processor) =>
        Object.freeze({
          consumerId: processorConsumerId(processor.id),
          settlement: processor.settlement ?? "inherit",
        })
      ),
    );

  const registry: PluginRegistry = {
    plugins: Object.freeze([...plugins]),
    context,
    collections: Object.freeze({
      list(): readonly object[] {
        return Object.freeze([...maps.get("collections")!.values()]);
      },
      get(id: string): object | undefined {
        return maps.get("collections")!.get(id);
      },
      require(id: string): object {
        const value = maps.get("collections")!.get(id);
        if (!value) throw new Error(`Unknown collection '${id}'.`);
        return value;
      },
    }),
    processors: Object.freeze({
      list: listProcessors,
      get(id: string): Processor | undefined {
        const value = maps.get("processors")!.get(id);
        return isProcessor(value) ? value : undefined;
      },
      matchDurable,
      durableConsumers,
      processorForConsumer(consumerId) {
        const id = processorIdFromConsumer(consumerId);
        const value = id ? maps.get("processors")!.get(id) : undefined;
        return isProcessor(value) ? value : undefined;
      },
    }),
  };
  return Object.freeze(registry);
}
