import { isProcessor } from "./processor.ts";

export const PLUGIN_RESOURCE_TYPES = [
  "agents",
  "tools",
  "processors",
  "collections",
  "providers",
  "channels",
  "skills",
  "memory",
  "apis",
  "mcpServers",
  "features",
  "storage",
] as const;

export type PluginResourceType = typeof PLUGIN_RESOURCE_TYPES[number];
export type PluginResource = object;

export type PluginResources = Partial<
  Record<PluginResourceType, readonly PluginResource[]>
>;

export type PluginManifest = Readonly<{
  id: string;
  version: string;
  provides: Partial<Record<PluginResourceType, readonly string[]>>;
  presets?: Readonly<Record<string, readonly string[]>>;
}>;

export type CopilotzPlugin = Readonly<{
  manifest: PluginManifest;
  resources: PluginResources;
}>;

export type PluginSource =
  | string
  | Readonly<{
    source: string;
    imports?: readonly string[];
    presets?: readonly string[];
  }>
  | CopilotzPlugin;

/** Runtime adapter for local paths, JSR, npm, or application-owned sources. */
export type PluginResolver = {
  resolve(source: string): Promise<unknown>;
};

export type PluginResourceOrigin = Readonly<{
  pluginId: string;
  pluginVersion?: string;
}>;

function resourceType(value: string): PluginResourceType {
  if (!PLUGIN_RESOURCE_TYPES.includes(value as PluginResourceType)) {
    throw new TypeError(`Unknown plugin resource type '${value}'.`);
  }
  return value as PluginResourceType;
}

export function pluginResourceId(
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
        type === "storage"
    ? resource.name ?? resource.id
    : resource.id ?? resource.name;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new TypeError(`${type} resources require a stable ID.`);
  }
  return candidate.trim();
}

export function parsePluginSelector(selector: string): {
  type: PluginResourceType;
  id?: string;
} {
  const normalized = selector.trim();
  const separator = normalized.indexOf(".");
  const rawType = separator < 0 ? normalized : normalized.slice(0, separator);
  const type = resourceType(rawType);
  if (separator < 0) return { type };
  const id = normalized.slice(separator + 1).trim();
  if (!id) throw new TypeError(`Invalid plugin selector '${selector}'.`);
  return { type, id };
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
    const ids = values.map((value) => pluginResourceId(type, value));
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

function assertManifestMatchesResources(
  manifest: PluginManifest,
  resources: PluginResources,
): void {
  for (const type of PLUGIN_RESOURCE_TYPES) {
    const declared = new Set(manifest.provides[type] ?? []);
    const actual = new Set(
      (resources[type] ?? []).map((value) => pluginResourceId(type, value)),
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

function frozenPresets(
  pluginId: string,
  presets: PluginManifest["presets"],
  provides: PluginManifest["provides"],
): PluginManifest["presets"] {
  if (!presets) return undefined;
  const result: Record<string, readonly string[]> = {};
  for (const [name, selectors] of Object.entries(presets)) {
    if (!name.trim() || !Array.isArray(selectors)) {
      throw new TypeError(`Plugin '${pluginId}' contains an invalid preset.`);
    }
    const normalized = selectors.map((selector) => selector.trim());
    for (const selector of normalized) {
      const parsed = parsePluginSelector(selector);
      if (
        parsed.id && !(provides[parsed.type] ?? []).includes(parsed.id)
      ) {
        throw new TypeError(
          `Plugin '${pluginId}' preset '${name}' references unknown resource '${selector}'.`,
        );
      }
    }
    result[name] = Object.freeze(normalized);
  }
  return Object.freeze(result);
}

export function definePlugin(plugin: CopilotzPlugin): CopilotzPlugin {
  const id = plugin.manifest?.id?.trim();
  const version = plugin.manifest?.version?.trim();
  if (!id) throw new TypeError("Plugin id is required.");
  if (!version) throw new TypeError(`Plugin '${id}' requires a version.`);
  const provides = frozenProvides(plugin.manifest.provides ?? {});
  const resources = frozenResources(plugin.resources ?? {});
  const manifest: PluginManifest = Object.freeze({
    id,
    version,
    provides,
    ...(plugin.manifest.presets
      ? { presets: frozenPresets(id, plugin.manifest.presets, provides) }
      : {}),
  });
  assertManifestMatchesResources(manifest, resources);
  return Object.freeze({ manifest, resources });
}
