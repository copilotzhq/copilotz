import type { ActionMap, AnyActionDefinition } from "../actions/types.ts";
import { isActionDefinition } from "../actions/define.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
import { isProcessor } from "./processor.ts";
import type {
  Processor,
  ProcessorEvent,
  ProcessorMatchClause,
  ProcessorSettlement,
} from "./processor.ts";

export type CollectionMap = Readonly<
  Record<string, CollectionDefinition>
>;

export type AnyProcessor = Readonly<{
  id: string;
  on: readonly ProcessorMatchClause[];
  settlement?: ProcessorSettlement;
  handle(
    event: ProcessorEvent,
    context: never,
  ): void | Promise<void>;
}>;

export type ProcessorMap = Readonly<Record<string, AnyProcessor>>;

export type ProcessorContextOf<P extends AnyProcessor> = P extends Processor<
  infer TContext
> ? TContext
  : never;

/**
 * One composition category containing named namespaces and named values.
 * Values deliberately remain unknown to the generic runtime.
 */
export type PluginNamespaceMap = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

export type PluginResources = PluginNamespaceMap;
export type PluginAdapters = PluginNamespaceMap;

type Simplify<T> = { readonly [K in keyof T]: T[K] };
type EmptyMap = Readonly<Record<never, never>>;

type OverlayRecord<A, B> = Simplify<Omit<A, keyof B> & B>;

export type OverlayPluginNamespaces<
  A extends PluginNamespaceMap,
  B extends PluginNamespaceMap,
> = Simplify<
  {
    readonly [N in keyof A | keyof B]: N extends keyof B
      ? N extends keyof A ? OverlayRecord<A[N], B[N]>
      : B[N]
      : N extends keyof A ? A[N]
      : never;
  }
>;

export type PluginTypeComposition<
  TCollections extends object = CollectionMap,
  TActions extends object = ActionMap,
  TProcessors extends object = ProcessorMap,
  TResources extends PluginResources = PluginResources,
  TAdapters extends PluginAdapters = PluginAdapters,
> = Readonly<{
  collections: TCollections;
  actions: TActions;
  processors: TProcessors;
  resources: TResources;
  adapters: TAdapters;
}>;

type EmptyPluginComposition = PluginTypeComposition<
  EmptyMap,
  EmptyMap,
  EmptyMap,
  EmptyMap,
  EmptyMap
>;

export type MergePluginCompositions<
  A extends PluginTypeComposition,
  B extends PluginTypeComposition,
> = PluginTypeComposition<
  Simplify<A["collections"] & B["collections"]>,
  Simplify<A["actions"] & B["actions"]>,
  Simplify<A["processors"] & B["processors"]>,
  OverlayPluginNamespaces<A["resources"], B["resources"]>,
  OverlayPluginNamespaces<A["adapters"], B["adapters"]>
>;

declare const pluginCompositionTypes: unique symbol;

export interface AnyCopilotzPlugin {
  readonly id: string;
  readonly version: string;
  readonly plugins: readonly AnyCopilotzPlugin[];
  readonly collections: CollectionMap;
  readonly actions: Readonly<Record<string, AnyActionDefinition>>;
  readonly processors: ProcessorMap;
  readonly resources: PluginResources;
  readonly adapters: PluginAdapters;
  readonly [pluginCompositionTypes]?: PluginTypeComposition;
}

export type CompositionOfPlugin<P extends AnyCopilotzPlugin> = NonNullable<
  P[typeof pluginCompositionTypes]
>;

export type ComposePlugins<
  TPlugins extends readonly AnyCopilotzPlugin[],
  TAcc extends PluginTypeComposition = EmptyPluginComposition,
> = number extends TPlugins["length"]
  ? MergePluginCompositions<TAcc, CompositionOfPlugin<TPlugins[number]>>
  : TPlugins extends readonly [
    infer THead extends AnyCopilotzPlugin,
    ...infer TTail extends readonly AnyCopilotzPlugin[],
  ] ? ComposePlugins<
      TTail,
      MergePluginCompositions<TAcc, CompositionOfPlugin<THead>>
    >
  : TAcc;

export interface CopilotzPlugin<
  TId extends string = string,
  TVersion extends string = string,
  TPlugins extends readonly AnyCopilotzPlugin[] = readonly AnyCopilotzPlugin[],
  TCollections extends CollectionMap = CollectionMap,
  TActions extends ActionMap = ActionMap,
  TProcessors extends ProcessorMap = ProcessorMap,
  TResources extends PluginResources = PluginResources,
  TAdapters extends PluginAdapters = PluginAdapters,
> {
  readonly id: TId;
  readonly version: TVersion;
  readonly plugins: TPlugins;
  readonly collections: TCollections;
  readonly actions: TActions;
  readonly processors: TProcessors;
  readonly resources: TResources;
  readonly adapters: TAdapters;
  readonly [pluginCompositionTypes]?: MergePluginCompositions<
    ComposePlugins<TPlugins>,
    PluginTypeComposition<
      TCollections,
      TActions,
      TProcessors,
      TResources,
      TAdapters
    >
  >;
}

export type DefinePluginInput<
  TId extends string = string,
  TVersion extends string = string,
  TPlugins extends readonly AnyCopilotzPlugin[] = readonly AnyCopilotzPlugin[],
  TCollections extends CollectionMap = CollectionMap,
  TActions extends ActionMap = ActionMap,
  TProcessors extends ProcessorMap = ProcessorMap,
  TResources extends PluginResources = PluginResources,
  TAdapters extends PluginAdapters = PluginAdapters,
> = Readonly<{
  id: TId;
  version: TVersion;
  plugins?: TPlugins;
  collections?: TCollections;
  actions?: TActions;
  processors?: TProcessors;
  resources?: TResources;
  adapters?: TAdapters;
}>;

const ALIAS_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const UNSAFE_ALIASES = new Set(["__proto__", "constructor", "prototype"]);
const PLUGIN_KEYS = new Set([
  "id",
  "version",
  "plugins",
  "collections",
  "actions",
  "processors",
  "resources",
  "adapters",
]);
const definedPlugins = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

function requireAlias(value: string, label: string): string {
  const alias = value.trim();
  if (
    alias !== value || !ALIAS_PATTERN.test(alias) ||
    UNSAFE_ALIASES.has(alias)
  ) {
    throw new TypeError(`${label} has invalid alias '${value}'.`);
  }
  return alias;
}

function requireNamespaceEntry(value: string, label: string): string {
  const key = value.trim();
  const hasControlCharacter = [...key].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    key !== value || !key || hasControlCharacter ||
    UNSAFE_ALIASES.has(key)
  ) {
    throw new TypeError(`${label} has invalid key '${value}'.`);
  }
  return key;
}

function isCollectionDefinition(value: unknown): value is CollectionDefinition {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && Boolean(value.name.trim()) &&
    isRecord(value.schema);
}

function freezeDefinitionMap<T extends object>(
  value: Readonly<Record<string, T>> | undefined,
  label: string,
  valid: (candidate: unknown) => candidate is T,
): Readonly<Record<string, T>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an alias map.`);
  }
  const entries = Object.entries(value).map(([rawAlias, definition]) => {
    const alias = requireAlias(rawAlias, `${label} entry`);
    if (!valid(definition)) {
      throw new TypeError(
        `${label} alias '${alias}' has an invalid definition.`,
      );
    }
    return [alias, definition] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

/** Shallow-freezes namespace containers while preserving every value identity. */
export function freezePluginNamespaces<T extends PluginNamespaceMap>(
  value: T | undefined,
  label: string,
): T {
  if (value === undefined) return Object.freeze({}) as T;
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be a namespace map.`);
  }
  const namespaces = Object.entries(value).map(([rawNamespace, values]) => {
    const namespace = requireAlias(rawNamespace, `${label} namespace`);
    if (!isRecord(values)) {
      throw new TypeError(
        `${label} namespace '${namespace}' must be an alias map.`,
      );
    }
    const entries = Object.entries(values).map(([rawAlias, entry]) =>
      [
        requireNamespaceEntry(
          rawAlias,
          `${label} namespace '${namespace}' entry`,
        ),
        entry,
      ] as const
    );
    return [namespace, Object.freeze(Object.fromEntries(entries))] as const;
  });
  return Object.freeze(Object.fromEntries(namespaces)) as T;
}

export function isCopilotzPlugin(value: unknown): value is AnyCopilotzPlugin {
  return isRecord(value) && definedPlugins.has(value);
}

/**
 * Defines one plugin. Dependencies must already be defined so composition has
 * one identity and one normalization path.
 */
export function definePlugin<
  const TId extends string,
  const TVersion extends string,
  const TPlugins extends readonly AnyCopilotzPlugin[] = readonly [],
  const TCollections extends CollectionMap = EmptyMap,
  const TActions extends ActionMap = EmptyMap,
  const TProcessors extends ProcessorMap = EmptyMap,
  const TResources extends PluginResources = EmptyMap,
  const TAdapters extends PluginAdapters = EmptyMap,
>(
  input: DefinePluginInput<
    TId,
    TVersion,
    TPlugins,
    TCollections,
    TActions,
    TProcessors,
    TResources,
    TAdapters
  >,
): CopilotzPlugin<
  TId,
  TVersion,
  TPlugins,
  TCollections,
  TActions,
  TProcessors,
  TResources,
  TAdapters
> {
  if (!isRecord(input)) {
    throw new TypeError("Plugin definition must be an object.");
  }
  const id = requiredText(input.id, "Plugin id") as TId;
  const version = requiredText(
    input.version,
    `Plugin '${id}' version`,
  ) as TVersion;
  const unknown = Object.keys(input).find((key) => !PLUGIN_KEYS.has(key));
  if (unknown) {
    throw new TypeError(`Plugin '${id}' cannot declare '${unknown}'.`);
  }
  const plugins = input.plugins ?? (Object.freeze([]) as unknown as TPlugins);
  if (!Array.isArray(plugins)) {
    throw new TypeError(`Plugin '${id}' dependencies must be an array.`);
  }
  for (const dependency of plugins) {
    if (!isCopilotzPlugin(dependency)) {
      throw new TypeError(
        `Plugin '${id}' dependencies must be created with definePlugin().`,
      );
    }
  }

  const plugin: CopilotzPlugin<
    TId,
    TVersion,
    TPlugins,
    TCollections,
    TActions,
    TProcessors,
    TResources,
    TAdapters
  > = Object.freeze({
    id,
    version,
    plugins: Object.freeze([...plugins]) as unknown as TPlugins,
    collections: freezeDefinitionMap(
      input.collections,
      `Plugin '${id}' collections`,
      isCollectionDefinition,
    ) as TCollections,
    actions: freezeDefinitionMap(
      input.actions,
      `Plugin '${id}' actions`,
      isActionDefinition,
    ) as TActions,
    processors: freezeDefinitionMap(
      input.processors,
      `Plugin '${id}' processors`,
      isProcessor,
    ) as TProcessors,
    resources: freezePluginNamespaces(
      input.resources,
      `Plugin '${id}' resources`,
    ),
    adapters: freezePluginNamespaces(
      input.adapters,
      `Plugin '${id}' adapters`,
    ),
  });
  definedPlugins.add(plugin);
  return plugin;
}
