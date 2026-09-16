import type {
  ContributionActions,
  ResolvedNamespaces,
} from "./contribution.ts";
import type { ActionMap } from "../actions/types.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
import type {
  DurableConsumerObligation,
  DurableEventDraft,
} from "../events/types.ts";
import { matchProcessor } from "./match.ts";
import {
  type Processor,
  processorConsumerId,
  processorIdFromConsumer,
} from "./processor.ts";
import {
  type AnyCopilotzPlugin,
  type AnyProcessor,
  type CollectionMap,
  type ComposePlugins,
  definePlugin,
  isCopilotzPlugin,
  type OverlayPluginNamespaces,
  type PluginAdapters,
  type PluginNamespaceMap,
  type PluginResources,
  type PluginTypeComposition,
  type ProcessorMap,
} from "./types.ts";

type EmptyMap = Readonly<Record<never, never>>;

export type PluginComposition<
  TCollections extends CollectionMap = CollectionMap,
  TActions extends ActionMap = ActionMap,
  TProcessors extends ProcessorMap = ProcessorMap,
  TResources extends PluginResources = PluginResources,
  TAdapters extends PluginAdapters = PluginAdapters,
> = PluginTypeComposition<
  TCollections,
  TActions,
  TProcessors,
  TResources,
  TAdapters
>;

export type RegistryComposition<
  TPlugins extends readonly AnyCopilotzPlugin[],
  TResources extends PluginResources,
  TAdapters extends PluginAdapters,
  TActions extends ActionMap = EmptyMap,
  TCollections extends CollectionMap = EmptyMap,
  TProcessors extends ProcessorMap = EmptyMap,
> = ComposePlugins<TPlugins> extends
  infer TPluginsComposition extends PluginComposition ? PluginComposition<
    TPluginsComposition["collections"] & TCollections,
    & TPluginsComposition["actions"]
    & TActions
    & ContributionActions<TResources>
    & ContributionActions<TAdapters>,
    TPluginsComposition["processors"] & TProcessors,
    OverlayPluginNamespaces<
      TPluginsComposition["resources"],
      ResolvedNamespaces<TResources>
    >,
    OverlayPluginNamespaces<
      TPluginsComposition["adapters"],
      ResolvedNamespaces<TAdapters>
    >
  >
  : never;

function isNonEmptyPlainMatcher(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).length > 0;
}

function rejectUnguardedStaticWildcardProcessor(value: AnyProcessor): void {
  for (const [index, clause] of value.on.entries()) {
    if (clause.eventType !== "*") continue;
    if (
      isNonEmptyPlainMatcher(clause.subject) ||
      isNonEmptyPlainMatcher(clause.metadata) ||
      isNonEmptyPlainMatcher(clause.data)
    ) {
      continue;
    }
    throw new TypeError(
      `Processor '${value.id}' on[${index}] cannot register static eventType '*' without a non-empty plain subject, metadata, or data matcher.`,
    );
  }
}

export type PluginRegistry<
  TComposition extends PluginComposition = PluginComposition,
> = Readonly<{
  plugins: readonly AnyCopilotzPlugin[];
  collections: TComposition["collections"];
  actions: TComposition["actions"];
  processors: TComposition["processors"];
  resources: TComposition["resources"];
  adapters: TComposition["adapters"];
  matchDurable(
    draft: DurableEventDraft,
    data?: unknown,
  ): readonly AnyProcessor[];
  durableConsumers(
    draft: DurableEventDraft,
    data?: unknown,
  ): readonly DurableConsumerObligation[];
  processorForConsumer(consumerId: string): AnyProcessor | undefined;
}>;

export type CreatePluginRegistryOptions<
  TPlugins extends readonly AnyCopilotzPlugin[] = readonly [],
  TResources extends PluginResources = EmptyMap,
  TAdapters extends PluginAdapters = EmptyMap,
  TActions extends ActionMap = EmptyMap,
  TCollections extends CollectionMap = EmptyMap,
  TProcessors extends ProcessorMap = EmptyMap,
> = Readonly<{
  plugins?: TPlugins;
  collections?: TCollections;
  actions?: TActions;
  processors?: TProcessors;
  resources?: TResources;
  adapters?: TAdapters;
}>;

function recordFromMap<T>(
  values: ReadonlyMap<string, T>,
): Readonly<Record<string, T>> {
  return (Object.fromEntries(values));
}

function mergeNamespaces(
  target: Map<string, Map<string, unknown>>,
  source: PluginNamespaceMap,
): void {
  for (const [namespace, values] of Object.entries(source)) {
    const entries = target.get(namespace) ?? new Map<string, unknown>();
    target.set(namespace, entries);
    for (const [alias, value] of Object.entries(values)) {
      entries.set(alias, value);
    }
  }
}

function namespacesFromMap(
  source: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
): PluginNamespaceMap {
  return (Object.fromEntries(
    [...source.entries()].map(([namespace, values]) => [
      namespace,
      recordFromMap(values),
    ]),
  ));
}

/**
 * Composes dependency plugins first, then root plugins in caller order, then
 * application Resource and Adapter overlays. Executable definitions never
 * replace one another.
 */
export function createPluginRegistry<
  const TPlugins extends readonly AnyCopilotzPlugin[] = readonly [],
  const TResources extends PluginResources = EmptyMap,
  const TAdapters extends PluginAdapters = EmptyMap,
  const TActions extends ActionMap = EmptyMap,
  const TCollections extends CollectionMap = EmptyMap,
  const TProcessors extends ProcessorMap = EmptyMap,
>(
  options: CreatePluginRegistryOptions<
    TPlugins,
    TResources,
    TAdapters,
    TActions,
    TCollections,
    TProcessors
  > = {},
): PluginRegistry<
  RegistryComposition<
    TPlugins,
    TResources,
    TAdapters,
    TActions,
    TCollections,
    TProcessors
  >
> {
  const collections = new Map<string, CollectionDefinition>();
  const actions = new Map<string, ActionMap[string]>();
  const processors = new Map<string, AnyProcessor>();
  const collectionIds = new Map<string, string>();
  const actionIds = new Map<string, string>();
  const processorIds = new Map<string, string>();
  const resourceNamespaces = new Map<string, Map<string, unknown>>();
  const adapterNamespaces = new Map<string, Map<string, unknown>>();
  const plugins: AnyCopilotzPlugin[] = [];
  const pluginIds = new Map<string, AnyCopilotzPlugin>();

  const addDefinitions = <T extends object>(
    kind: "collection" | "action" | "processor",
    definitions: Readonly<Record<string, T>>,
    aliases: Map<string, T>,
    stableIds: Map<string, string>,
    stableId: (definition: T) => string,
  ): void => {
    for (const [alias, definition] of Object.entries(definitions)) {
      const existingAlias = aliases.get(alias);
      if (existingAlias) {
        throw new TypeError(
          `${kind[0].toUpperCase()}${
            kind.slice(1)
          } alias '${alias}' is declared by more than one plugin.`,
        );
      }
      const id = stableId(definition).trim();
      const existingIdAlias = stableIds.get(id);
      if (existingIdAlias) {
        throw new TypeError(
          `${kind[0].toUpperCase()}${
            kind.slice(1)
          } id '${id}' is exposed as both '${existingIdAlias}' and '${alias}'.`,
        );
      }
      aliases.set(alias, definition);
      stableIds.set(id, alias);
    }
  };

  const register = (
    plugin: AnyCopilotzPlugin,
    stack: readonly string[] = [],
  ): void => {
    if (!isCopilotzPlugin(plugin)) {
      throw new TypeError(
        "Registry plugins must be created with definePlugin().",
      );
    }
    if (stack.includes(plugin.id)) {
      throw new TypeError(
        `Plugin dependency cycle detected: ${
          [...stack, plugin.id].join(" -> ")
        }.`,
      );
    }
    const existing = pluginIds.get(plugin.id);
    if (existing) {
      if (existing === plugin) return;
      throw new TypeError(`Plugin '${plugin.id}' was declared more than once.`);
    }
    for (const dependency of plugin.plugins) {
      register(dependency, [...stack, plugin.id]);
    }
    pluginIds.set(plugin.id, plugin);
    plugins.push(plugin);
    addDefinitions(
      "collection",
      plugin.collections,
      collections,
      collectionIds,
      (definition) => definition.name,
    );
    addDefinitions(
      "action",
      plugin.actions,
      actions,
      actionIds,
      (definition) => definition.id,
    );
    for (const processor of Object.values(plugin.processors)) {
      rejectUnguardedStaticWildcardProcessor(processor);
    }
    addDefinitions(
      "processor",
      plugin.processors,
      processors,
      processorIds,
      (definition) => definition.id,
    );
    mergeNamespaces(resourceNamespaces, plugin.resources);
    mergeNamespaces(adapterNamespaces, plugin.adapters);
  };

  const rootPlugin = definePlugin({
    id: "@copilotz/application",
    version: "1",
    plugins: options.plugins as readonly AnyCopilotzPlugin[],
    collections: options.collections,
    actions: options.actions,
    processors: options.processors,
    resources: options.resources as PluginResources,
    adapters: options.adapters as PluginAdapters,
  });
  register(rootPlugin);

  const registeredProcessors = recordFromMap(processors);
  const processorById = new Map(
    Object.values(registeredProcessors).map((
      processor,
    ) => [processor.id, processor]),
  );
  const matchDurable = (
    draft: DurableEventDraft,
    data?: unknown,
  ): readonly AnyProcessor[] => (Object.values(registeredProcessors).filter((
    processor,
  ) => matchProcessor(processor as Processor, draft, data)));

  const registry: PluginRegistry = {
    plugins: plugins.filter((plugin) => plugin !== rootPlugin),
    collections: recordFromMap(collections),
    actions: recordFromMap(actions),
    processors: registeredProcessors,
    resources: namespacesFromMap(resourceNamespaces),
    adapters: namespacesFromMap(adapterNamespaces),
    matchDurable,
    durableConsumers(draft, data) {
      return (matchDurable(draft, data).map((processor) => ({
        consumerId: processorConsumerId(processor.id),
        settlement: processor.settlement ?? "inherit",
      })));
    },
    processorForConsumer(consumerId) {
      const id = processorIdFromConsumer(consumerId);
      return id ? processorById.get(id) : undefined;
    },
  };
  return registry as PluginRegistry<
    RegistryComposition<
      TPlugins,
      TResources,
      TAdapters,
      TActions,
      TCollections,
      TProcessors
    >
  >;
}
