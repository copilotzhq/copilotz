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
  definePlugin,
  parsePluginSelector,
  PLUGIN_RESOURCE_TYPES,
  type PluginResolver,
  pluginResourceId,
  type PluginResourceOrigin,
  type PluginResources,
  type PluginResourceType,
  type PluginSource,
} from "./types.ts";

type RegistryEntry = {
  value: object;
  origin: PluginResourceOrigin;
};

export type PluginRegistry = Readonly<{
  plugins: readonly CopilotzPlugin[];
  list<T extends object = object>(type: PluginResourceType): readonly T[];
  get<T extends object = object>(
    type: PluginResourceType,
    id: string,
  ): T | undefined;
  require<T extends object = object>(
    type: PluginResourceType,
    id: string,
  ): T;
  origin(
    type: PluginResourceType,
    id: string,
  ): PluginResourceOrigin | undefined;
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

export type CreatePluginRegistryOptions = {
  core?: CopilotzPlugin | readonly CopilotzPlugin[];
  plugins?: readonly PluginSource[];
  resources?: PluginResources;
  resolver?: PluginResolver;
};

function normalizePluginModule(value: unknown, source: string): CopilotzPlugin {
  const module = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const candidate = module.default ?? module.plugin ?? module;
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError(`Plugin '${source}' did not export a plugin object.`);
  }
  const plugin = candidate as Partial<CopilotzPlugin>;
  if (!plugin.manifest || !plugin.resources) {
    throw new TypeError(
      `Plugin '${source}' must export { manifest, resources }.`,
    );
  }
  return definePlugin(plugin as CopilotzPlugin);
}

function selectedResources(
  plugin: CopilotzPlugin,
  imports: readonly string[] | undefined,
  presets: readonly string[] | undefined,
): PluginResources {
  const selectors = [
    ...(presets ?? []).flatMap((preset) => {
      const selected = plugin.manifest.presets?.[preset];
      if (!selected) {
        throw new TypeError(
          `Plugin '${plugin.manifest.id}' does not define preset '${preset}'.`,
        );
      }
      return selected;
    }),
    ...(imports ?? []),
  ];
  if (selectors.length === 0) return plugin.resources;

  const all = new Set<PluginResourceType>();
  const named = new Map<PluginResourceType, Set<string>>();
  for (const selector of selectors) {
    const parsed = parsePluginSelector(selector);
    if (!parsed.id) {
      all.add(parsed.type);
      named.delete(parsed.type);
      continue;
    }
    if (!(plugin.manifest.provides[parsed.type] ?? []).includes(parsed.id)) {
      throw new TypeError(
        `Plugin '${plugin.manifest.id}' does not provide '${selector}'.`,
      );
    }
    if (!all.has(parsed.type)) {
      const ids = named.get(parsed.type) ?? new Set<string>();
      ids.add(parsed.id);
      named.set(parsed.type, ids);
    }
  }

  const result: PluginResources = {};
  for (const type of PLUGIN_RESOURCE_TYPES) {
    const values = plugin.resources[type];
    if (!values?.length) continue;
    const ids = named.get(type);
    if (!all.has(type) && !ids?.size) continue;
    (result as Record<string, unknown>)[type] = Object.freeze(
      all.has(type)
        ? [...values]
        : values.filter((value) => ids!.has(pluginResourceId(type, value))),
    );
  }
  return Object.freeze(result);
}

/**
 * Composes core, declared plugins in order, then explicit application
 * resources. A later stable ID replaces an earlier one for that resource type.
 */
export async function createPluginRegistry(
  options: CreatePluginRegistryOptions = {},
): Promise<PluginRegistry> {
  const maps = new Map<PluginResourceType, Map<string, RegistryEntry>>();
  for (const type of PLUGIN_RESOURCE_TYPES) maps.set(type, new Map());
  const plugins: CopilotzPlugin[] = [];
  const pluginIds = new Set<string>();

  const add = (
    resources: PluginResources,
    origin: PluginResourceOrigin,
  ): void => {
    const stableOrigin = Object.freeze({ ...origin });
    for (const type of PLUGIN_RESOURCE_TYPES) {
      const values = resources[type];
      if (!values) continue;
      const map = maps.get(type)!;
      for (const value of values) {
        const id = pluginResourceId(type, value);
        map.delete(id);
        map.set(id, { value, origin: stableOrigin });
      }
    }
  };

  const register = (
    pluginInput: CopilotzPlugin,
    resources = pluginInput.resources,
  ): CopilotzPlugin => {
    const plugin = definePlugin(pluginInput);
    if (pluginIds.has(plugin.manifest.id)) {
      throw new TypeError(
        `Plugin '${plugin.manifest.id}' was declared more than once.`,
      );
    }
    pluginIds.add(plugin.manifest.id);
    plugins.push(plugin);
    add(resources, {
      pluginId: plugin.manifest.id,
      pluginVersion: plugin.manifest.version,
    });
    return plugin;
  };

  const corePlugins = options.core
    ? Array.isArray(options.core) ? options.core : [options.core]
    : [];
  for (const plugin of corePlugins) register(plugin);

  for (const input of options.plugins ?? []) {
    if (typeof input === "object" && "manifest" in input) {
      register(input);
      continue;
    }
    const source = typeof input === "string" ? input : input.source;
    if (!options.resolver) {
      throw new TypeError(
        `A plugin resolver is required to load '${source}'.`,
      );
    }
    const plugin = normalizePluginModule(
      await options.resolver.resolve(source),
      source,
    );
    const selected = selectedResources(
      plugin,
      typeof input === "string" ? undefined : input.imports,
      typeof input === "string" ? undefined : input.presets,
    );
    register(plugin, selected);
  }

  if (options.resources) {
    add(options.resources, { pluginId: "@copilotz/application" });
  }

  const listProcessors = (): readonly Processor[] =>
    [...maps.get("processors")!.values()]
      .map((entry) => entry.value)
      .filter(isProcessor);

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
    list<T extends object = object>(type: PluginResourceType): readonly T[] {
      return Object.freeze(
        [...maps.get(type)!.values()].map((entry) => entry.value as T),
      );
    },
    get<T extends object = object>(type: PluginResourceType, id: string) {
      return maps.get(type)!.get(id)?.value as T | undefined;
    },
    require<T extends object = object>(type: PluginResourceType, id: string) {
      const value = maps.get(type)!.get(id)?.value;
      if (!value) throw new Error(`Unknown ${type} resource '${id}'.`);
      return value as T;
    },
    origin(type, id) {
      return maps.get(type)!.get(id)?.origin;
    },
    matchDurable,
    durableConsumers,
    processorForConsumer(consumerId) {
      const id = processorIdFromConsumer(consumerId);
      const value = id ? maps.get("processors")!.get(id)?.value : undefined;
      return isProcessor(value) ? value : undefined;
    },
  };
  return Object.freeze(registry);
}
