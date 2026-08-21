import { isProcessor } from "./processor.ts";

export type PluginResource = object;

export type PluginResources = Readonly<
  Partial<{
    agents: readonly PluginResource[];
    collections: readonly PluginResource[];
    processors: readonly PluginResource[];
    llm: readonly PluginResource[];
    embedding: readonly PluginResource[];
    tools: readonly PluginResource[];
    skills: readonly PluginResource[];
    features: readonly PluginResource[];
    storage: readonly PluginResource[];
    mcp: readonly PluginResource[];
    api: readonly PluginResource[];
    channels: readonly PluginResource[];
    memoryKinds: readonly PluginResource[];
  }>
>;

export type PluginResourceType = keyof PluginResources;

export const INTERNAL_PLUGIN_RESOURCE_TYPES = [
  "agents",
  "collections",
  "processors",
  "llm",
  "embedding",
  "tools",
  "skills",
  "features",
  "storage",
  "mcp",
  "api",
  "channels",
  "memoryKinds",
] as const satisfies readonly PluginResourceType[];

export type PluginDeclarationResourceType = PluginResourceType;

export type PluginDeclarationResources = PluginResources;

export type PluginContextContribution = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

export type PluginContextValues = PluginContextContribution;

export type PluginManifest = Readonly<{
  id: string;
  version: string;
  provides: Partial<Record<PluginResourceType, readonly string[]>>;
}>;

export type CopilotzPlugin = Readonly<{
  manifest: PluginManifest;
  resources: PluginResources;
  plugins: readonly CopilotzPlugin[];
  context: PluginContextValues;
}>;

export type DefinePluginInput = Readonly<
  & {
    id: string;
    version: string;
    plugins?: readonly (DefinePluginInput | CopilotzPlugin)[];
    context?: PluginContextContribution;
  }
  & PluginDeclarationResources
>;

function resourceType(value: string): PluginResourceType {
  if (!INTERNAL_PLUGIN_RESOURCE_TYPES.includes(value as PluginResourceType)) {
    throw new TypeError(`Unknown plugin resource type '${value}'.`);
  }
  return value as PluginResourceType;
}

export function stablePluginResourceId(
  type: PluginResourceType,
  value: unknown,
): string {
  if (!value || typeof value !== "object") {
    throw new TypeError(`Invalid ${type} resource.`);
  }
  const resource = value as Record<string, unknown>;
  const candidate = type === "tools"
    ? resource.key ?? resource.id ?? resource.name
    : type === "collections"
    ? resource.name ?? resource.id
    : type === "skills" || type === "channels" || type === "features" ||
        type === "storage" || type === "memoryKinds"
    ? resource.name ?? resource.id
    : resource.id ?? resource.name;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new TypeError(`${type} resources require a stable ID.`);
  }
  return candidate.trim();
}

function frozenProvides(
  provides: PluginManifest["provides"],
): PluginManifest["provides"] {
  const result: Partial<Record<PluginResourceType, readonly string[]>> = {};
  for (const [rawType, values] of Object.entries(provides)) {
    const type = resourceType(rawType);
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      throw new TypeError(
        `Plugin manifest '${type}' provides must be an array.`,
      );
    }
    const ids = values.map((value) => value.trim());
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new TypeError(
        `Plugin manifest '${type}' provides must contain unique stable IDs.`,
      );
    }
    result[type] = Object.freeze(ids);
  }
  return Object.freeze(result);
}

function frozenResources(resources: PluginResources): PluginResources {
  const result: PluginResources = {};
  for (const [rawType, values] of Object.entries(resources)) {
    const type = resourceType(rawType);
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      throw new TypeError(`Plugin resources '${type}' must be an array.`);
    }
    const ids = values.map((value) => stablePluginResourceId(type, value));
    if (type === "processors" && values.some((value) => !isProcessor(value))) {
      throw new TypeError("Plugin processors must be defined subscriptions.");
    }
    if (new Set(ids).size !== ids.length) {
      throw new TypeError(`Plugin contains duplicate ${type} resource IDs.`);
    }
    (result as Record<string, unknown>)[type] = Object.freeze([...values]);
  }
  return Object.freeze(result);
}

function frozenContext(
  context: PluginContextContribution | undefined,
  label: string,
): PluginContextValues {
  if (!context) return Object.freeze({});
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [rawNamespace, values] of Object.entries(context)) {
    const namespace = rawNamespace.trim();
    if (!namespace) {
      throw new TypeError(`${label} contains an empty context namespace.`);
    }
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new TypeError(
        `${label} context namespace '${namespace}' must be an object.`,
      );
    }
    const entries: Record<string, unknown> = {};
    for (const [rawKey, value] of Object.entries(values)) {
      const key = rawKey.trim();
      if (!key) {
        throw new TypeError(
          `${label} context namespace '${namespace}' contains an empty key.`,
        );
      }
      entries[key] = value;
    }
    result[namespace] = Object.freeze(entries);
  }
  return Object.freeze(result);
}

function assertManifestMatchesResources(
  manifest: PluginManifest,
  resources: PluginResources,
): void {
  for (const type of INTERNAL_PLUGIN_RESOURCE_TYPES) {
    const declared = new Set(manifest.provides[type] ?? []);
    const actual = new Set(
      (resources[type] ?? []).map((value) =>
        stablePluginResourceId(type, value)
      ),
    );
    const missing = [...actual].filter((id) => !declared.has(id));
    const absent = [...declared].filter((id) => !actual.has(id));
    if (missing.length || absent.length) {
      throw new TypeError(
        `Plugin '${manifest.id}' manifest/resources mismatch for '${type}'.`,
      );
    }
  }
}

function isDefinedPlugin(value: unknown): value is CopilotzPlugin {
  if (!value || typeof value !== "object") return false;
  const plugin = value as Partial<CopilotzPlugin>;
  return !!plugin.manifest && !!plugin.resources &&
    Array.isArray(plugin.plugins) && !!plugin.context;
}

function derivedProvides(
  resources: PluginResources,
): PluginManifest["provides"] {
  const provides: Partial<Record<PluginResourceType, readonly string[]>> = {};
  for (const type of INTERNAL_PLUGIN_RESOURCE_TYPES) {
    const values = resources[type];
    if (!values?.length) continue;
    provides[type] = Object.freeze(
      values.map((value) => stablePluginResourceId(type, value)),
    );
  }
  return Object.freeze(provides);
}

function normalizePlugin(
  plugin: DefinePluginInput | CopilotzPlugin,
  stack: readonly string[],
): CopilotzPlugin {
  if (isDefinedPlugin(plugin)) {
    const id = plugin.manifest.id;
    if (stack.includes(id)) {
      throw new TypeError(
        `Plugin dependency cycle detected: ${[...stack, id].join(" -> ")}.`,
      );
    }
    return plugin;
  }
  const id = plugin.id?.trim();
  const version = plugin.version?.trim();
  if (!id) throw new TypeError("Plugin id is required.");
  if (!version) throw new TypeError(`Plugin '${id}' requires a version.`);
  if (stack.includes(id)) {
    throw new TypeError(
      `Plugin dependency cycle detected: ${[...stack, id].join(" -> ")}.`,
    );
  }
  const resources = frozenResources({
    ...Object.fromEntries(
      INTERNAL_PLUGIN_RESOURCE_TYPES.flatMap((type) =>
        plugin[type] ? [[type, plugin[type]]] : []
      ),
    ),
  } as PluginResources);
  const context = frozenContext(plugin.context, `Plugin '${id}'`);
  const provides = frozenProvides(derivedProvides(resources));
  const manifest: PluginManifest = Object.freeze({
    id,
    version,
    provides,
  });
  assertManifestMatchesResources(manifest, resources);
  const plugins = Object.freeze(
    (plugin.plugins ?? []).map((dependency) =>
      normalizePlugin(dependency, [...stack, id])
    ),
  );
  return Object.freeze({ manifest, resources, plugins, context });
}

export function definePlugin(plugin: DefinePluginInput): CopilotzPlugin {
  return normalizePlugin(plugin, []);
}
