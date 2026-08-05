import type { CollectionDefinition } from "@/database/collections/types.ts";
import type { CopilotzEvent, DurableEvent } from "@/events/types.ts";
import type { Processor } from "@/processors/types.ts";
import type {
  Agent,
  API,
  ChannelResource,
  MCPServer,
  MemoryResource,
  ProviderResource,
  SkillResource,
  Tool,
} from "@/types/resources.ts";
import type {
  CopilotzPlugin,
  PluginResolver,
  PluginResources,
  PluginSource,
  ResourceType,
} from "./types.ts";

type ResourceByType = {
  agents: Agent;
  tools: Tool;
  processors: Processor;
  collections: CollectionDefinition;
  providers: ProviderResource;
  channels: ChannelResource;
  skills: SkillResource;
  memory: MemoryResource;
  apis: API;
  mcpServers: MCPServer;
};

const RESOURCE_TYPES = [
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
] as const satisfies readonly ResourceType[];

function resourceId(type: ResourceType, value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new TypeError(`Invalid ${type} resource.`);
  }
  const resource = value as Record<string, unknown>;
  const candidate = type === "tools"
    ? resource.key ?? resource.id
    : type === "collections"
    ? resource.name
    : type === "skills" || type === "memory" || type === "apis" ||
        type === "mcpServers"
    ? resource.id ?? resource.name
    : resource.id ?? resource.name;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new TypeError(`${type} resources require a stable id.`);
  }
  return candidate;
}

function parseSelector(selector: string): { type: ResourceType; id?: string } {
  const separator = selector.indexOf(".");
  const rawType = separator < 0 ? selector : selector.slice(0, separator);
  if (!RESOURCE_TYPES.includes(rawType as ResourceType)) {
    throw new TypeError(`Unknown plugin resource selector '${selector}'.`);
  }
  const id = separator < 0 ? undefined : selector.slice(separator + 1);
  if (separator >= 0 && !id) {
    throw new TypeError(`Invalid plugin resource selector '${selector}'.`);
  }
  return { type: rawType as ResourceType, id };
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

  const all = new Set<ResourceType>();
  const named = new Map<ResourceType, Set<string>>();
  for (const selector of selectors) {
    const parsed = parseSelector(selector);
    if (!parsed.id) {
      all.add(parsed.type);
      named.delete(parsed.type);
    } else if (!all.has(parsed.type)) {
      const values = named.get(parsed.type) ?? new Set<string>();
      values.add(parsed.id);
      named.set(parsed.type, values);
    }
  }

  const result: PluginResources = {};
  for (const type of RESOURCE_TYPES) {
    const values = plugin.resources[type] as readonly unknown[] | undefined;
    if (!values?.length) continue;
    const names = named.get(type);
    if (!all.has(type) && !names?.size) continue;
    const selected = all.has(type)
      ? [...values]
      : values.filter((value) => names!.has(resourceId(type, value)));
    (result as Record<string, unknown>)[type] = selected;
  }
  return result;
}

function normalizePluginModule(value: unknown, source: string): CopilotzPlugin {
  const module = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const candidate = (module.default ?? module.plugin ?? module) as unknown;
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError(`Plugin '${source}' did not export a plugin object.`);
  }
  const plugin = candidate as Partial<CopilotzPlugin>;
  if (!plugin.manifest || !plugin.resources) {
    throw new TypeError(
      `Plugin '${source}' must export { manifest, resources }.`,
    );
  }
  return plugin as CopilotzPlugin;
}

export class PluginRegistry {
  readonly #maps = new Map<ResourceType, Map<string, unknown>>();
  readonly plugins: readonly CopilotzPlugin[];

  private constructor(
    plugins: readonly CopilotzPlugin[],
    resources: readonly PluginResources[],
  ) {
    this.plugins = Object.freeze([...plugins]);
    for (const type of RESOURCE_TYPES) this.#maps.set(type, new Map());
    for (const group of resources) this.add(group);
  }

  static async compose(options: {
    core?: CopilotzPlugin;
    plugins?: readonly PluginSource[];
    resources?: PluginResources;
    resolver?: PluginResolver;
  }): Promise<PluginRegistry> {
    const definitions: CopilotzPlugin[] = [];
    const groups: PluginResources[] = [];
    if (options.core) {
      definitions.push(options.core);
      groups.push(options.core.resources);
    }

    for (const input of options.plugins ?? []) {
      if (typeof input === "object" && "manifest" in input) {
        definitions.push(input);
        groups.push(input.resources);
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
      definitions.push(plugin);
      groups.push(selectedResources(
        plugin,
        typeof input === "string" ? undefined : input.imports,
        typeof input === "string" ? undefined : input.presets,
      ));
    }

    if (options.resources) groups.push(options.resources);
    return new PluginRegistry(definitions, groups);
  }

  private add(resources: PluginResources): void {
    for (const type of RESOURCE_TYPES) {
      const values = resources[type] as readonly unknown[] | undefined;
      if (!values) continue;
      const map = this.#maps.get(type)!;
      for (const value of values) {
        const id = resourceId(type, value);
        // Delete first so iteration order reflects composition precedence.
        map.delete(id);
        map.set(id, value);
      }
    }
  }

  list<K extends ResourceType>(type: K): readonly ResourceByType[K][] {
    return [...this.#maps.get(type)!.values()] as ResourceByType[K][];
  }

  get<K extends ResourceType>(
    type: K,
    id: string,
  ): ResourceByType[K] | undefined {
    return this.#maps.get(type)!.get(id) as ResourceByType[K] | undefined;
  }

  require<K extends ResourceType>(type: K, id: string): ResourceByType[K] {
    const value = this.get(type, id);
    if (!value) throw new Error(`Unknown ${type} resource '${id}'.`);
    return value;
  }

  matchDurable(event: DurableEvent): readonly Processor[] {
    const matches: Processor[] = [];
    for (const processor of this.list("processors")) {
      if (
        processor.delivery !== "durable" || !processor.on.includes(event.type)
      ) {
        continue;
      }
      if (processor.filter) {
        const accepted: unknown = processor.filter(event);
        if (
          accepted !== null && typeof accepted === "object" &&
          "then" in accepted &&
          typeof (accepted as { then?: unknown }).then === "function"
        ) {
          throw new TypeError(
            `Durable processor '${processor.id}' filter must be synchronous.`,
          );
        }
        if (!accepted) continue;
      }
      matches.push(processor);
    }
    return matches;
  }

  matchLive(event: CopilotzEvent): readonly Processor[] {
    return this.list("processors").filter((processor) =>
      processor.delivery === "live" && processor.on.includes(event.type) &&
      (!processor.filter || processor.filter(event))
    );
  }
}
