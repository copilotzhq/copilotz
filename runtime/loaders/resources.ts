/**
 * Resource loader for Copilotz configuration.
 *
 * Supports local directories (readDir discovery), manifest-guided loading,
 * and remote URLs (jsr:, npm:, https://).
 *
 * @module
 */

import type {
  AgentConfig,
  APIConfig,
  CollectionDefinition,
  MemoryResource,
  MCPServer,
  ToolConfig,
} from "@/index.ts";
import type { ProviderFactory } from "@/runtime/llm/types.ts";
import type { EmbeddingProviderFactory } from "@/runtime/embeddings/types.ts";
import {
  type ChannelEntry,
  type EgressAdapter,
  type IngressAdapter,
  mergeChannelEntries,
} from "@/server/channels.ts";
import type {
  Event,
  EventProcessor,
  NewEvent,
  NewUnknownEvent,
  ProcessorDeps,
} from "@/types/index.ts";
import type { Skill } from "@/runtime/loaders/skill-types.ts";
import { loadSkillsFromDirectory } from "@/runtime/loaders/skill-loader.ts";

import { fromFileUrl, resolve } from "@std/path";

// ---- Types ----------------------------------------------------------------

type ProcessorEntry = EventProcessor<unknown, ProcessorDeps> & {
  eventType: string;
  priority?: number;
  id?: string;
};

/** A loaded feature with named action handlers. */
export type FeatureEntry = {
  name: string;
  actions: Record<
    string,
    (request: unknown, copilotz: unknown) => Promise<unknown>
  >;
};

/**
 * Manifest declaring which resources a directory or package provides.
 * Placed at the root as `manifest.ts` (default export).
 *
 * For local directories the manifest is optional — the loader falls back to
 * `readDir`-based discovery. For remote specifiers (`jsr:`, `npm:`, `https://`)
 * a manifest is **required** since the loader cannot enumerate remote files.
 *
 * @example
 * ```ts
 * export default {
 *   provides: {
 *     tools: ["browser-session"],
 *     agents: ["browser-agent"],
 *   },
 * };
 * ```
 */
export interface ResourceManifest {
  provides: Partial<Record<string, string[]>>;
  presets?: Record<string, string[]>;
}

export interface ResourceLoadOptions {
  path: string | string[];
  preset?: string[];
  imports?: string[];
}

export type LoadedLlmProvider = {
  name: string;
  factory: ProviderFactory;
};

export type LoadedEmbeddingProvider = {
  name: string;
  factory: EmbeddingProviderFactory;
};

export type LoadedStorageAdapter = {
  name: string;
  module: Record<string, unknown>;
};

/**
 * Resources loaded from one or more paths.
 * Contains agents, APIs, tools, MCP servers, skills, custom processors,
 * and extensible resource types for marketplace packages.
 */
export type Resources = {
  /** Array of loaded agent configurations. */
  agents: AgentConfig[];
  /** Array of loaded API configurations. */
  apis?: APIConfig[];
  /** Array of loaded tool configurations. */
  tools?: ToolConfig[];
  /** Array of loaded MCP server configurations. */
  mcpServers?: MCPServer[];
  /** Array of loaded memory resources. */
  memory?: MemoryResource[];
  /** Array of loaded skill definitions. */
  skills?: Skill[];
  /** Array of loaded custom event processors. */
  processors?: ProcessorEntry[];
  /** Array of loaded feature handlers. */
  features?: FeatureEntry[];
  /** Array of loaded channels with optional ingress/egress adapters. */
  channels?: ChannelEntry[];
  /** Array of loaded LLM providers. */
  llm?: LoadedLlmProvider[];
  /** Array of loaded embedding providers. */
  embeddings?: LoadedEmbeddingProvider[];
  /** Array of loaded storage adapters. */
  storage?: LoadedStorageAdapter[];
  /** Array of loaded collection definitions. */
  collections?: CollectionDefinition[];
  /** Extensible: marketplace packages can contribute arbitrary resource types. */
  [key: string]: unknown;
};

// Well-known resource type keys that have dedicated loading logic.
const KNOWN_RESOURCE_TYPES = [
  "agents",
  "tools",
  "apis",
  "processors",
  "skills",
  "mcpServers",
  "memory",
  "features",
  "channels",
  "llm",
  "embeddings",
  "storage",
  "collections",
] as const;

type ResourceImportSelection = {
  hasExplicitSelection: boolean;
  all: Set<string>;
  named: Map<string, Set<string>>;
};

function mergeNamedResources<T extends { name: string }>(
  existing: T[] | undefined,
  incoming: T[] | undefined,
): T[] | undefined {
  if (!incoming?.length) return existing;
  if (!existing?.length) return [...incoming];

  const merged = [...existing];
  const seen = new Set(existing.map((item) => item.name));
  for (const item of incoming) {
    if (!seen.has(item.name)) {
      merged.push(item);
      seen.add(item.name);
    }
  }
  return merged;
}

function expandPresetImports(
  manifest: ResourceManifest,
  presetNames: string[],
): string[] {
  const manifestPresets = manifest.presets ?? {};
  const expanded: string[] = [];
  for (const presetName of presetNames) {
    const imports = manifestPresets[presetName];
    if (Array.isArray(imports)) {
      expanded.push(...imports);
    } else if (isInitDebugEnabled()) {
      console.warn(
        `[copilotz:resources] Unknown preset "${presetName}" in manifest selection`,
      );
    }
  }
  return expanded;
}

function parseImportSelection(
  imports: string[] | undefined,
): ResourceImportSelection {
  const normalized = (imports ?? []).filter((value) =>
    typeof value === "string" && value.length > 0
  );
  const selection: ResourceImportSelection = {
    hasExplicitSelection: normalized.length > 0,
    all: new Set<string>(),
    named: new Map<string, Set<string>>(),
  };

  for (const entry of normalized) {
    const parts = entry.split(".").filter(Boolean);
    if (parts.length === 0 || parts.length > 2) {
      if (isInitDebugEnabled()) {
        console.warn(
          `[copilotz:resources] Ignoring invalid import selector "${entry}"`,
        );
      }
      continue;
    }
    const [type, name] = parts;
    if (!name) {
      selection.all.add(type);
      selection.named.delete(type);
      continue;
    }
    if (selection.all.has(type)) continue;
    const existing = selection.named.get(type) ?? new Set<string>();
    existing.add(name);
    selection.named.set(type, existing);
  }

  return selection;
}

function getSelectedNames(
  type: string,
  names: string[],
  selection?: ResourceImportSelection,
): string[] {
  if (!selection?.hasExplicitSelection) return [...names];
  if (selection.all.has(type)) return [...names];
  const selected = selection.named.get(type);
  if (!selected?.size) return [];
  return names.filter((name) => selected.has(name));
}

function resolveManifestProvides(
  manifest: ResourceManifest,
  options?: Pick<ResourceLoadOptions, "preset" | "imports">,
): Partial<Record<string, string[]>> {
  const presetImports = expandPresetImports(manifest, options?.preset ?? []);
  const selection = parseImportSelection([
    ...presetImports,
    ...(options?.imports ?? []),
  ]);

  if (!selection.hasExplicitSelection) {
    return manifest.provides;
  }

  const resolved: Partial<Record<string, string[]>> = {};
  for (const [type, names] of Object.entries(manifest.provides)) {
    if (!Array.isArray(names) || names.length === 0) continue;
    const selected = getSelectedNames(type, names, selection);
    if (selected.length > 0) {
      resolved[type] = selected;
    }
  }
  return resolved;
}

// ---- Configuration --------------------------------------------------------

const isInitDebugEnabled = () => Deno.env.get("COPILOTZ_INIT_DEBUG") === "1";
const elapsedMs = (startedAt: number) =>
  Number((performance.now() - startedAt).toFixed(1));

type LogPhase = (
  phase: string,
  startedAt: number,
  extra?: Record<string, unknown>,
) => void;

// ---- URL Utilities --------------------------------------------------------

const REMOTE_PREFIXES = ["jsr:", "npm:", "https://", "http://"];

function isRemoteSpecifier(path: string): boolean {
  return REMOTE_PREFIXES.some((p) => path.startsWith(p));
}

/** Normalise any path into a URL string usable with `import()` and `fetch()`. */
function toBaseUrl(path: string): string {
  if (isRemoteSpecifier(path) || path.startsWith("file://")) return path;
  const cwd = Deno.cwd();
  const abs = resolve(cwd, path);
  return "file://" + abs;
}

function joinUrl(base: string, ...segments: string[]): string {
  let url = base.replace(/\/+$/, "");
  for (const seg of segments) {
    url += "/" + seg.replace(/^\/+/, "");
  }
  return url;
}

// ---- Module Loading (URL-native) ------------------------------------------

async function importModule(
  url: string,
  options?: ImportCallOptions,
): Promise<unknown> {
  const mod = await import(url, options);
  return mod?.default ?? mod;
}

async function importModuleSafe(
  url: string,
  options?: ImportCallOptions,
): Promise<unknown | undefined> {
  try {
    return await importModule(url, options);
  } catch (error) {
    if (isInitDebugEnabled()) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[copilotz:resources] Failed to load: ${url}`, msg);
    }
    return undefined;
  }
}

/**
 * Load text content from any URL.
 * Uses `fetch()` for `file://` and `https://` (Deno supports both),
 * falls back to `import()` with text assertion for `jsr:`/`npm:`.
 */
async function loadText(url: string): Promise<string | undefined> {
  try {
    if (!url.startsWith("jsr:") && !url.startsWith("npm:")) {
      const res = await fetch(url);
      return res.ok ? await res.text() : undefined;
    }
    return (await importModule(url, { with: { type: "text" } })) as string;
  } catch {
    return undefined;
  }
}

// ---- readDir helper (local filesystem only) -------------------------------

async function* readDir(path: string) {
  try {
    const fsPath = path.startsWith("file://")
      ? path.replace("file://", "")
      : path;
    for await (const entry of Deno.readDir(fsPath)) {
      yield entry;
    }
  } catch {
    return;
  }
}

// ---- Processor coercion helpers -------------------------------------------

const asShouldProcess = (
  fn: (event: unknown, deps?: unknown) => boolean | Promise<boolean>,
): EventProcessor<unknown, ProcessorDeps>["shouldProcess"] => {
  return async (event: Event, deps: ProcessorDeps): Promise<boolean> => {
    try {
      return Boolean(await fn(event, deps));
    } catch {
      return false;
    }
  };
};

const asProcess = (
  fn: (event: unknown, deps?: unknown) => unknown | Promise<unknown>,
): EventProcessor<unknown, ProcessorDeps>["process"] => {
  return async (event: Event, deps: ProcessorDeps) => {
    const result = await fn(event, deps);
    if (result == null) return;
    if (Array.isArray(result)) {
      return { producedEvents: result as Array<NewEvent | NewUnknownEvent> };
    }
    if (
      typeof result === "object" && result &&
      "type" in (result as Record<string, unknown>) &&
      "payload" in (result as Record<string, unknown>)
    ) {
      return { producedEvents: [result as NewEvent | NewUnknownEvent] };
    }
    if (
      typeof result === "object" && result &&
      "producedEvents" in (result as Record<string, unknown>)
    ) {
      const produced = (result as { producedEvents?: unknown }).producedEvents;
      if (Array.isArray(produced)) {
        return {
          producedEvents: produced as Array<NewEvent | NewUnknownEvent>,
        };
      }
      if (produced) {
        return { producedEvents: [produced as NewEvent | NewUnknownEvent] };
      }
    }
    return;
  };
};

// ---- Manifest loading -----------------------------------------------------

async function tryLoadManifest(
  baseUrl: string,
): Promise<ResourceManifest | undefined> {
  const manifest = await importModuleSafe(joinUrl(baseUrl, "manifest.ts"));
  if (
    manifest && typeof manifest === "object" &&
    "provides" in (manifest as Record<string, unknown>)
  ) {
    return manifest as ResourceManifest;
  }
  return undefined;
}

// ---- Manifest-guided loaders ----------------------------------------------

async function loadAgentsByManifest(
  baseUrl: string,
  names: string[],
): Promise<AgentConfig[]> {
  const settled = await Promise.all(names.map(async (name) => {
    const agentUrl = joinUrl(baseUrl, "agents", name);
    const [instructions, config] = await Promise.all([
      loadText(joinUrl(agentUrl, "instructions.md")),
      importModuleSafe(joinUrl(agentUrl, "config.ts")) as Promise<
        Record<string, unknown> | undefined
      >,
    ]);
    if (!instructions) return null;
    return {
      id: name,
      name,
      instructions,
      ...(config ?? {}),
    } as AgentConfig;
  }));
  return settled.filter((r): r is AgentConfig => r !== null);
}

async function loadToolsByManifest(
  baseUrl: string,
  names: string[],
): Promise<ToolConfig[]> {
  const settled = await Promise.all(
    names.filter((n) => !n.startsWith("_")).map(async (name) => {
      return await loadToolModule(baseUrl, name);
    }),
  );
  return settled.filter((r): r is ToolConfig => r !== null);
}

async function loadToolModule(
  baseUrl: string,
  name: string,
): Promise<ToolConfig | null> {
  const toolUrl = joinUrl(baseUrl, "tools", name);
  const [config, execute, indexMod] = await Promise.all([
    importModuleSafe(joinUrl(toolUrl, "config.ts")),
    importModuleSafe(joinUrl(toolUrl, "execute.ts")),
    importModuleSafe(joinUrl(toolUrl, "index.ts")),
  ]);

  if (config && execute) {
    return {
      id: name,
      name,
      ...(config as object),
      execute,
    } as ToolConfig;
  }

  if (indexMod && typeof indexMod === "object") {
    return {
      id: name,
      name,
      ...(indexMod as object),
    } as ToolConfig;
  }

  return null;
}

async function loadApisByManifest(
  baseUrl: string,
  names: string[],
): Promise<APIConfig[]> {
  const settled = await Promise.all(names.map(async (name) => {
    const apiUrl = joinUrl(baseUrl, "apis", name);
    const [config, openApiSchema] = await Promise.all([
      importModuleSafe(joinUrl(apiUrl, "config.ts")) as Promise<
        Record<string, unknown> | undefined
      >,
      importModuleSafe(joinUrl(apiUrl, "openApiSchema.json"), {
        with: { type: "json" },
      }),
    ]);
    if (!openApiSchema) return null;
    return {
      id: name,
      name,
      openApiSchema,
      ...(config ?? {}),
    } as APIConfig;
  }));
  return settled.filter((r): r is APIConfig => r !== null);
}

async function loadProcessorsByManifest(
  baseUrl: string,
  eventTypes: string[],
): Promise<ProcessorEntry[]> {
  const settled = await Promise.all(eventTypes.map(async (eventType) => {
    const eventTypeKey = eventType.toUpperCase();
    const processorUrl = joinUrl(baseUrl, "processors", eventType);

    const mod = (await importModuleSafe(
      joinUrl(processorUrl, "index.ts"),
    )) as Record<string, unknown> | undefined;
    if (!mod) return null;

    const maybeShouldProcess = mod.shouldProcess;
    const maybeProcess = mod.process || mod.default;
    if (
      typeof maybeShouldProcess === "function" &&
      typeof maybeProcess === "function"
    ) {
      return {
        shouldProcess: asShouldProcess(
          maybeShouldProcess as (
            event: unknown,
            deps?: unknown,
          ) => boolean | Promise<boolean>,
        ),
        process: asProcess(
          maybeProcess as (
            event: unknown,
            deps?: unknown,
          ) => unknown | Promise<unknown>,
        ),
        eventType: eventTypeKey,
        priority: typeof mod.priority === "number" ? mod.priority : 0,
      } as ProcessorEntry;
    }
    return null;
  }));
  return settled.filter((r): r is ProcessorEntry => r !== null);
}

async function loadMcpServersByManifest(
  baseUrl: string,
  names: string[],
): Promise<MCPServer[]> {
  const settled = await Promise.all(names.map(async (name) => {
    const mod = await importModuleSafe(joinUrl(baseUrl, "mcpServers", name, "index.ts")) ??
      await importModuleSafe(joinUrl(baseUrl, "mcpServers", name + ".ts"));
    if (!mod || typeof mod !== "object") return null;
    return {
      name,
      ...(mod as object),
    } as MCPServer;
  }));
  return settled.filter((r): r is MCPServer => r !== null);
}

async function loadMemoryByManifest(
  baseUrl: string,
  names: string[],
): Promise<MemoryResource[]> {
  const loaded = await loadNamedGenericByManifest<MemoryResource>(
    baseUrl,
    "memory",
    names,
    (value): value is MemoryResource =>
      typeof value === "object" && value !== null && "kind" in value,
  );
  return loaded.map(({ name, value }) => ({
    name,
    ...(value as object),
  } as MemoryResource));
}

/**
 * Generic loader for extensible resource types (llm, embeddings, storage, collections, etc.).
 *
 * First tries a barrel file at `<type>/mod.ts` — a single import that exports
 * all resources by name. This avoids per-name speculative imports, which is
 * critical for remote URLs where each miss is an HTTP 404 roundtrip.
 *
 * If no barrel file exists, falls back to per-name convention probing:
 *   1. Directory with `config.ts` + `adapter.ts` (provider pattern)
 *   2. Single `<name>.ts` file (collection pattern)
 *   3. Directory with `index.ts`
 */
function resolveResourceFromModule(mod: unknown, name: string): unknown {
  if (!mod || typeof mod !== "object") return mod;
  const m = mod as Record<string, unknown>;
  if (m.default) return m.default;
  if (m[name]) return m[name];
  // If it's a module object with only one export, and it's not 'default' or 'name', 
  // we might still want it, but usually the convention is default or name.
  // We'll return the module object itself as a fallback if it looks like a resource
  return mod;
}

async function loadGenericByManifest(
  baseUrl: string,
  resourceType: string,
  names: string[],
): Promise<unknown[]> {
  // Fast path: try barrel file that exports all resources for this type
  const barrelUrl = joinUrl(baseUrl, resourceType, "mod.ts");
  const barrel = await importModuleSafe(barrelUrl);
  if (barrel && typeof barrel === "object") {
    const barrelMap = barrel as Record<string, unknown>;
    return names
      .map((name) => barrelMap[name] ?? null)
      .filter((r) => r !== null);
  }

  // Slow path: per-name convention probing (fine for local, costly for remote)
  const settled = await Promise.all(names.map(async (name) => {
    const resourceUrl = joinUrl(baseUrl, resourceType, name);

    // Fire all conventions in parallel, pick the first match
    const [config, adapter, singleMod, indexMod] = await Promise.all([
      importModuleSafe(joinUrl(resourceUrl, "config.ts")),
      importModuleSafe(joinUrl(resourceUrl, "adapter.ts")),
      importModuleSafe(resourceUrl + ".ts"),
      importModuleSafe(joinUrl(resourceUrl, "index.ts")),
    ]);

    // 1. config.ts + adapter.ts (provider pattern)
    if (config || adapter) {
      return {
        id: name,
        name,
        ...(config && typeof config === "object" ? resolveResourceFromModule(config, name) as any : {}),
        ...(adapter && typeof adapter === "object" ? resolveResourceFromModule(adapter, name) as any : {}),
      };
    }

    // 2. Single file: <type>/<name>.ts
    if (singleMod) return resolveResourceFromModule(singleMod, name);

    // 3. Directory with index.ts
    if (indexMod) return resolveResourceFromModule(indexMod, name);

    return null;
  }));
  return settled.filter((r) => r !== null);
}

async function loadNamedGenericByManifest<T>(
  baseUrl: string,
  resourceType: string,
  names: string[],
  isValid?: (value: unknown) => value is T,
): Promise<Array<{ name: string; value: T }>> {
  const barrelUrl = joinUrl(baseUrl, resourceType, "mod.ts");
  const barrel = await importModuleSafe(barrelUrl);
  if (barrel && typeof barrel === "object") {
    const barrelMap = barrel as Record<string, unknown>;
    return names.flatMap((name) => {
      const value = barrelMap[name];
      if (
        typeof value === "undefined" ||
        value === null ||
        (isValid && !isValid(value))
      ) {
        return [];
      }
      return [{ name, value: value as T }];
    });
  }

  const settled = await Promise.all(names.map(async (name) => {
    const resourceUrl = joinUrl(baseUrl, resourceType, name);
    const [config, adapter, singleMod, indexMod] = await Promise.all([
      importModuleSafe(joinUrl(resourceUrl, "config.ts")),
      importModuleSafe(joinUrl(resourceUrl, "adapter.ts")),
      importModuleSafe(resourceUrl + ".ts"),
      importModuleSafe(joinUrl(resourceUrl, "index.ts")),
    ]);

    let value: unknown = null;

    // 1. config.ts + adapter.ts (provider pattern)
    if (config || adapter) {
      value = {
        id: name,
        name,
        ...(config && typeof config === "object" ? resolveResourceFromModule(config, name) as any : {}),
        ...(adapter && typeof adapter === "object" ? resolveResourceFromModule(adapter, name) as any : {}),
      };
    } else if (singleMod) {
      value = resolveResourceFromModule(singleMod, name);
    } else if (indexMod) {
      value = resolveResourceFromModule(indexMod, name);
    }

    if (
      value === null ||
      typeof value === "undefined" ||
      (isValid && !isValid(value))
    ) {
      return null;
    }
    return { name, value: value as T };
  }));

  return settled.filter((entry): entry is { name: string; value: T } =>
    entry !== null
  );
}

// ---- Feature loading ------------------------------------------------------

/**
 * Load feature handlers from a features/ directory.
 * Each subdirectory is a feature; each .ts file inside exports a default handler.
 * When `filterNames` is provided (manifest mode), only those features are loaded.
 */
async function loadFeaturesFromDirectory(
  baseUrl: string,
  filterNames?: string[],
): Promise<FeatureEntry[]> {
  const featuresUrl = joinUrl(baseUrl, "features");
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of readDir(featuresUrl)) entries.push(entry);
  } catch {
    return [];
  }

  const featureDirs = entries.filter((e) =>
    e.isDirectory && (!filterNames || filterNames.includes(e.name))
  );

  const features = await Promise.all(
    featureDirs.map(async (dir) => {
      const featureUrl = joinUrl(featuresUrl, dir.name);
      let files: Deno.DirEntry[];
      try {
        files = [];
        for await (const f of readDir(featureUrl)) files.push(f);
      } catch {
        return null;
      }

      const actions: FeatureEntry["actions"] = {};
      await Promise.all(
        files
          .filter((f) =>
            f.isFile && f.name.endsWith(".ts") && f.name !== "manifest.ts" &&
            !f.name.startsWith("_")
          )
          .map(async (file) => {
            try {
              const mod = await import(joinUrl(featureUrl, file.name));
              const handler = mod?.default;
              if (typeof handler === "function") {
                actions[file.name.replace(/\.ts$/, "")] = handler;
              }
            } catch (err) {
              console.warn(
                `[copilotz:resources] Failed to load feature action: ${dir.name}/${file.name}`,
                err,
              );
            }
          }),
      );

      if (Object.keys(actions).length === 0) return null;
      return { name: dir.name, actions } as FeatureEntry;
    }),
  );

  return features.filter((f): f is FeatureEntry => f !== null);
}

// ---- Channel loading ------------------------------------------------------

/**
 * Load channels from channel folders under `channels/<name>/{ingress,egress}.ts`.
 * Each adapter file exports a default adapter object.
 */
async function loadChannelsFromDirectory(
  baseUrl: string,
  filterNames?: string[],
): Promise<ChannelEntry[]> {
  const channelsUrl = joinUrl(baseUrl, "channels");
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of readDir(channelsUrl)) entries.push(entry);
  } catch {
    return [];
  }

  const channels = await Promise.all(
    entries.filter((entry) =>
      entry.isDirectory &&
      (!filterNames || filterNames.includes(entry.name))
    ).map(async (entry) => {
      try {
        const [ingressMod, egressMod] = await Promise.all([
          importModuleSafe(joinUrl(channelsUrl, entry.name, "ingress.ts")),
          importModuleSafe(joinUrl(channelsUrl, entry.name, "egress.ts")),
        ]);
        return toChannelEntry(entry.name, ingressMod, egressMod);
      } catch (err) {
        if (isInitDebugEnabled()) {
          console.warn(
            `[copilotz:resources] Failed to load channel: ${entry.name}`,
            err,
          );
        }
      }
      return null;
    }),
  );

  const loaded: ChannelEntry[] = [];
  for (const entry of channels) {
    if (entry !== null) loaded.push(entry);
  }
  return loaded;
}

/**
 * Manifest-driven channel loader. Imports `channels/<name>/{ingress,egress}.ts` by URL for each
 * declared channel — works for both local (`file://`) and remote
 * (`jsr:`, `npm:`, `https://`) base URLs, since it doesn't rely on `readDir`.
 */
async function loadChannelsByManifest(
  baseUrl: string,
  names: string[],
): Promise<ChannelEntry[]> {
  const settled = await Promise.all(
    names.map(async (name) => {
      const [ingressMod, egressMod] = await Promise.all([
        importModuleSafe(joinUrl(baseUrl, "channels", name, "ingress.ts")),
        importModuleSafe(joinUrl(baseUrl, "channels", name, "egress.ts")),
      ]);
      return toChannelEntry(name, ingressMod, egressMod);
    }),
  );
  const loaded: ChannelEntry[] = [];
  for (const entry of settled) {
    if (entry !== null) loaded.push(entry);
  }
  return loaded;
}

function asIngressAdapter(
  mod: unknown,
): IngressAdapter | undefined {
  if (
    !mod || typeof mod !== "object" || typeof (mod as {
        handle?: unknown;
      }).handle !== "function"
  ) {
    return undefined;
  }
  return mod as IngressAdapter;
}

function asEgressAdapter(
  mod: unknown,
): EgressAdapter | undefined {
  if (
    !mod || typeof mod !== "object" || typeof (mod as {
        deliver?: unknown;
      }).deliver !== "function"
  ) {
    return undefined;
  }
  return mod as EgressAdapter;
}

function toChannelEntry(
  name: string,
  ingressMod: unknown,
  egressMod: unknown,
): ChannelEntry | null {
  const ingress = asIngressAdapter(ingressMod);
  const egress = asEgressAdapter(egressMod);
  if (!ingress && !egress) return null;
  return { name, ingress, egress };
}

// ---- Manifest-driven full load --------------------------------------------

async function loadFromManifest(
  baseUrl: string,
  manifest: ResourceManifest,
  logPhase: LogPhase,
  options?: Pick<ResourceLoadOptions, "preset" | "imports">,
): Promise<Resources> {
  const provides = resolveManifestProvides(manifest, options);
  const resources: Resources = { agents: [] };

  const timed = async <T>(
    phase: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const s = performance.now();
    const result = await fn();
    const count = Array.isArray(result) ? result.length : 0;
    logPhase(phase, s, { count });
    return result;
  };

  // Collect generic (extensible) resource type entries
  const genericEntries = Object.entries(provides).filter(
    ([type, names]) =>
      !(KNOWN_RESOURCE_TYPES as readonly string[]).includes(type) &&
      names?.length,
  );

  // Fire ALL resource types in parallel
  const tasks: Promise<void>[] = [];

  if (provides.agents?.length) {
    tasks.push(
      timed("agents", () => loadAgentsByManifest(baseUrl, provides.agents!))
        .then((r) => {
          resources.agents = r;
        }),
    );
  }

  if (provides.tools?.length) {
    tasks.push(
      timed("tools", () => loadToolsByManifest(baseUrl, provides.tools!))
        .then((r) => {
          resources.tools = r;
        }),
    );
  }

  if (provides.apis?.length) {
    tasks.push(
      timed("apis", () => loadApisByManifest(baseUrl, provides.apis!))
        .then((r) => {
          resources.apis = r;
        }),
    );
  }

  if (provides.mcpServers?.length) {
    tasks.push(
      timed(
        "mcpServers",
        () => loadMcpServersByManifest(baseUrl, provides.mcpServers!),
      ).then((r) => {
        resources.mcpServers = r;
      }),
    );
  }

  if (provides.memory?.length) {
    tasks.push(
      timed("memory", () => loadMemoryByManifest(baseUrl, provides.memory!))
        .then((r) => {
          resources.memory = r;
        }),
    );
  }

  if (provides.processors?.length) {
    tasks.push(
      timed(
        "processors",
        () => loadProcessorsByManifest(baseUrl, provides.processors!),
      ).then((r) => {
        resources.processors = r;
      }),
    );
  }

  if (provides.skills?.length && baseUrl.startsWith("file://")) {
    tasks.push(
      timed("skills", () => {
        const skillsUrl = joinUrl(baseUrl, "skills");
        const skillsPath =
          decodeURIComponent(skillsUrl.replace("file://", "")) + "/";
        return loadSkillsFromDirectory(skillsPath, "project", provides.skills);
      }).then((r) => {
        resources.skills = r;
      }),
    );
  }

  if (provides.features?.length && baseUrl.startsWith("file://")) {
    tasks.push(
      timed(
        "features",
        () => loadFeaturesFromDirectory(baseUrl, provides.features!),
      ).then((r) => {
        resources.features = r;
      }),
    );
  }

  if (provides.channels?.length) {
    tasks.push(
      timed("channels", () =>
        loadChannelsByManifest(
          baseUrl,
          provides.channels!,
        )).then((r) => {
          resources.channels = r;
        }),
    );
  }

  if (provides.llm?.length) {
    tasks.push(
      timed("llm", async () => {
        const providers = await loadNamedGenericByManifest<ProviderFactory>(
          baseUrl,
          "llm",
          provides.llm!,
          (value): value is ProviderFactory => typeof value === "function",
        );
        return providers.map(({ name, value }) => ({ name, factory: value }));
      }).then((r) => {
        resources.llm = r;
      }),
    );
  }

  if (provides.embeddings?.length) {
    tasks.push(
      timed("embeddings", async () => {
        const providers = await loadNamedGenericByManifest<EmbeddingProviderFactory>(
          baseUrl,
          "embeddings",
          provides.embeddings!,
          (value): value is EmbeddingProviderFactory => typeof value === "function",
        );
        return providers.map(({ name, value }) => ({ name, factory: value }));
      }).then((r) => {
        resources.embeddings = r;
      }),
    );
  }

  if (provides.storage?.length) {
    tasks.push(
      timed("storage", async () => {
        const providers = await loadNamedGenericByManifest<Record<string, unknown>>(
          baseUrl,
          "storage",
          provides.storage!,
          (value): value is Record<string, unknown> =>
            typeof value === "object" && value !== null,
        );
        return providers.map(({ name, value }) => ({ name, module: value }));
      }).then((r) => {
        resources.storage = r;
      }),
    );
  }

  if (provides.collections?.length) {
    tasks.push(
      timed("collections", () =>
        loadGenericByManifest(baseUrl, "collections", provides.collections!),
      ).then((r) => {
        resources.collections = r as CollectionDefinition[];
      }),
    );
  }

  for (const [type, names] of genericEntries) {
    tasks.push(
      timed(type, () => loadGenericByManifest(baseUrl, type, names!))
        .then((r) => {
          (resources as Record<string, unknown>)[type] = r;
        }),
    );
  }

  await Promise.all(tasks);

  return resources;
}

// ---- readDir-based discovery (local fallback) -----------------------------

async function loadFromDirectory(
  baseUrl: string,
  logPhase: LogPhase,
  options?: Pick<ResourceLoadOptions, "imports">,
): Promise<Resources> {
  const resources: Resources = { agents: [] };
  const selection = parseImportSelection(options?.imports);
  const shouldLoadCategory = (type: string): boolean =>
    !selection.hasExplicitSelection ||
    selection.all.has(type) ||
    selection.named.has(type);
  const filterNames = (type: string, names: string[]): string[] =>
    getSelectedNames(type, names, selection);

  const collectEntries = async (url: string): Promise<Deno.DirEntry[]> => {
    const entries: Deno.DirEntry[] = [];
    const path = url.startsWith("file://")
      ? fromFileUrl(url)
      : url;
    try {
      for await (const entry of readDir(path)) entries.push(entry);
    } catch (_err) {
      // Directory might not exist, which is fine for optional resource types
    }
    return entries;
  };

  // Fire all resource types in parallel
  const tasks: Promise<void>[] = [];

  // ---- Agents ----
  if (shouldLoadCategory("agents")) tasks.push((async () => {
    const s = performance.now();
    const agentsUrl = joinUrl(baseUrl, "agents");
    const entries = await collectEntries(agentsUrl);
    const allowedNames = new Set(
      filterNames(
        "agents",
        entries.filter((e) => e.isDirectory).map((entry) => entry.name),
      ),
    );
    const agents = await Promise.all(
      entries.filter((e) => e.isDirectory && allowedNames.has(e.name)).map(async (entry) => {
        const agentUrl = joinUrl(agentsUrl, entry.name);
        const [instructions, config] = await Promise.all([
          loadText(joinUrl(agentUrl, "instructions.md")),
          importModuleSafe(joinUrl(agentUrl, "config.ts")) as Promise<
            Record<string, unknown> | undefined
          >,
        ]);
        if (!instructions) return null;
        return {
          id: entry.name,
          name: entry.name,
          instructions,
          ...(config ?? {}),
        } as AgentConfig;
      }),
    );
    resources.agents = agents.filter((a): a is AgentConfig => a !== null);
    logPhase("agents", s, { count: resources.agents.length });
  })());

  // ---- APIs ----
  if (shouldLoadCategory("apis")) tasks.push((async () => {
    const s = performance.now();
    const apisUrl = joinUrl(baseUrl, "apis");
    const entries = await collectEntries(apisUrl);
    const allowedNames = new Set(
      filterNames(
        "apis",
        entries.filter((e) => e.isDirectory).map((entry) => entry.name),
      ),
    );
    const apis = await Promise.all(
      entries.filter((e) => e.isDirectory && allowedNames.has(e.name)).map(async (entry) => {
        const apiUrl = joinUrl(apisUrl, entry.name);
        const [config, openApiSchema] = await Promise.all([
          importModuleSafe(joinUrl(apiUrl, "config.ts")) as Promise<
            Record<string, unknown> | undefined
          >,
          importModuleSafe(joinUrl(apiUrl, "openApiSchema.json"), {
            with: { type: "json" },
          }),
        ]);
        if (!openApiSchema) return null;
        return {
          id: entry.name,
          name: entry.name,
          openApiSchema,
          ...(config ?? {}),
        } as APIConfig;
      }),
    );
    resources.apis = apis.filter((a): a is APIConfig => a !== null);
    logPhase("apis", s, { count: resources.apis.length });
  })());

  // ---- Tools ----
  if (shouldLoadCategory("tools")) tasks.push((async () => {
    const s = performance.now();
    const toolsUrl = joinUrl(baseUrl, "tools");
    const entries = await collectEntries(toolsUrl);
    const allowedNames = new Set(
      filterNames(
        "tools",
        entries
          .filter((e) => e.isDirectory && !e.name.startsWith("_"))
          .map((entry) => entry.name),
      ),
    );
    const tools = await Promise.all(
      entries
        .filter((e) => e.isDirectory && !e.name.startsWith("_") && allowedNames.has(e.name))
        .map(async (entry) => await loadToolModule(baseUrl, entry.name)),
    );
    resources.tools = tools.filter((t): t is ToolConfig => t !== null);
    logPhase("tools", s, { count: resources.tools.length });
  })());

  // ---- Processors ----
  if (shouldLoadCategory("processors")) tasks.push((async () => {
    const s = performance.now();
    const processorsUrl = joinUrl(baseUrl, "processors");
    try {
      const evtDirs = await collectEntries(processorsUrl);
      const allowedEventTypes = new Set(
        filterNames(
          "processors",
          evtDirs.filter((e) => e.isDirectory).map((entry) => entry.name),
        ),
      );

      type Discovered = {
        shouldProcess: (
          event: unknown,
          deps?: unknown,
        ) => boolean | Promise<boolean>;
        process: (
          event: unknown,
          deps?: unknown,
        ) => unknown | Promise<unknown>;
        priority?: number;
        name?: string;
      };

      const allProcessors = await Promise.all(
        evtDirs.filter((e) => e.isDirectory && allowedEventTypes.has(e.name)).map(async (evtDir) => {
          const eventTypeKey = evtDir.name.toUpperCase();
          const dirUrl = joinUrl(processorsUrl, evtDir.name);
          const files = await collectEntries(dirUrl);

          const discovered = (
            await Promise.all(
              files
                .filter((f) => f.isFile && f.name.endsWith(".ts"))
                .map(async (file): Promise<Discovered | null> => {
                  const specifierUrl = joinUrl(dirUrl, file.name);
                  let mod: Record<string, unknown> | undefined;
                  try {
                    mod = (await import(specifierUrl)) as Record<
                      string,
                      unknown
                    >;
                  } catch (error) {
                    console.warn(
                      `[copilotz:resources] Failed to load processor: ${specifierUrl}`,
                      error,
                    );
                    return null;
                  }
                  const maybeShouldProcess = mod?.shouldProcess;
                  const maybeProcess = mod?.process || mod?.default;
                  const maybePriority = mod?.priority;
                  if (
                    typeof maybeShouldProcess === "function" &&
                    typeof maybeProcess === "function"
                  ) {
                    return {
                      shouldProcess:
                        maybeShouldProcess as Discovered["shouldProcess"],
                      process: maybeProcess as Discovered["process"],
                      priority: typeof maybePriority === "number"
                        ? maybePriority
                        : 0,
                      name: file.name,
                    };
                  }
                  return null;
                }),
            )
          ).filter((d): d is Discovered => d !== null);

          discovered.sort((a, b) => {
            if (b.priority !== a.priority) {
              return (b.priority ?? 0) - (a.priority ?? 0);
            }
            return (a.name ?? "").localeCompare(b.name ?? "", "en", {
              sensitivity: "base",
            });
          });

          return discovered.map((d) => ({
            shouldProcess: asShouldProcess(d.shouldProcess),
            process: asProcess(d.process),
            eventType: eventTypeKey,
            priority: d.priority,
          })) as ProcessorEntry[];
        }),
      );

      resources.processors = allProcessors.flat();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[copilotz:resources] Failed to load processors from: ${processorsUrl}`,
        msg,
      );
      resources.processors = [];
    }
    logPhase("processors", s, { count: resources.processors?.length ?? 0 });
  })());

  // ---- Skills ----
  if (shouldLoadCategory("skills")) tasks.push((async () => {
    const skillsPath = joinUrl(baseUrl, "skills").replace("file://", "") + "/";
    const s = performance.now();
    const names = selection.hasExplicitSelection
      ? Array.from(selection.all.has("skills") ? [] : (selection.named.get("skills") ?? []))
      : undefined;
    resources.skills = await loadSkillsFromDirectory(
      skillsPath,
      "project",
      selection.all.has("skills") ? undefined : names,
    );
    logPhase("skills", s, { count: resources.skills?.length ?? 0 });
  })());

  // ---- Features ----
  if (shouldLoadCategory("features")) tasks.push((async () => {
    const s = performance.now();
    const names = selection.all.has("features")
      ? undefined
      : selection.hasExplicitSelection
      ? Array.from(selection.named.get("features") ?? [])
      : undefined;
    resources.features = await loadFeaturesFromDirectory(baseUrl, names);
    logPhase("features", s, { count: resources.features?.length ?? 0 });
  })());

  // ---- Channels ----
  if (shouldLoadCategory("channels")) tasks.push((async () => {
    const s = performance.now();
    const names = selection.all.has("channels")
      ? undefined
      : selection.hasExplicitSelection
      ? Array.from(selection.named.get("channels") ?? [])
      : undefined;
    resources.channels = await loadChannelsFromDirectory(
      baseUrl,
      names,
    );
    logPhase("channels", s, {
      count: resources.channels?.length ?? 0,
    });
    })());

  // ---- Collections ----
  if (shouldLoadCategory("collections")) tasks.push((async () => {
    const s = performance.now();
    const collectionsUrl = joinUrl(baseUrl, "collections");
    const entries = await collectEntries(collectionsUrl);
    const discovered = entries
      .filter((entry) =>
        (entry.isDirectory || entry.name.endsWith(".ts")) &&
        entry.name !== "mod.ts" &&
        !entry.name.startsWith("_")
      )
      .map((entry) => entry.name.replace(/\.ts$/, ""));
    
    const names = filterNames("collections", discovered);
    const loaded = await loadNamedGenericByManifest<CollectionDefinition>(
      baseUrl,
      "collections",
      names,
      (value): value is CollectionDefinition =>
        typeof value === "object" && value !== null && "name" in value &&
        "schema" in value,
    );
    resources.collections = loaded.map(({ value }) => value);
    logPhase("collections", s, { count: resources.collections.length });
  })());

    const loadNamedGenericFromDirectory = async <T>(    type: string,
    mapper: (name: string, value: T) => unknown,
    isValid?: (value: unknown) => value is T,
  ) => {
    if (!shouldLoadCategory(type)) return;
    tasks.push((async () => {
      const s = performance.now();
      const typeUrl = joinUrl(baseUrl, type);
      const entries = await collectEntries(typeUrl);
      const discovered = entries
        .filter((entry) =>
          (entry.isDirectory || entry.name.endsWith(".ts")) &&
          entry.name !== "mod.ts" &&
          !entry.name.startsWith("_")
        )
        .map((entry) => entry.name.replace(/\.ts$/, ""));
      const names = filterNames(type, discovered);
      const loaded = await loadNamedGenericByManifest<T>(        baseUrl,
        type,
        names,
        isValid,
      );      (resources as Record<string, unknown>)[type] = loaded.map(({ name, value }) =>
        mapper(name, value)
      );
      logPhase(type, s, { count: loaded.length });
    })());
  };

  await loadNamedGenericFromDirectory<MCPServer>(
    "mcpServers",
    (_name, value) => value,
    (value): value is MCPServer => typeof value === "object" && value !== null,
  );
  await loadNamedGenericFromDirectory<MemoryResource>(
    "memory",
    (_name, value) => value,
    (value): value is MemoryResource =>
      typeof value === "object" && value !== null &&
      "name" in value && "kind" in value,
  );
  await loadNamedGenericFromDirectory<ProviderFactory>(
    "llm",
    (name, value) => ({ name, factory: value }),
    (value): value is ProviderFactory => typeof value === "function",
  );
  await loadNamedGenericFromDirectory<EmbeddingProviderFactory>(
    "embeddings",
    (name, value) => ({ name, factory: value }),
    (value): value is EmbeddingProviderFactory => typeof value === "function",
  );
  await loadNamedGenericFromDirectory<Record<string, unknown>>(
    "storage",
    (name, value) => ({ name, module: value }),
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null,
  );

  await Promise.all(tasks);

  return resources;
}

// ---- Single path loading --------------------------------------------------

async function loadResourcePath(
  baseUrl: string,
  originalPath: string,
  debug: boolean,
  options?: Pick<ResourceLoadOptions, "preset" | "imports">,
): Promise<Resources> {
  const logPhase: LogPhase = (phase, startedAt, extra) => {
    if (!debug) return;
    console.log("[copilotz:resources]", {
      phase,
      elapsedMs: elapsedMs(startedAt),
      path: originalPath,
      ...(extra ?? {}),
    });
  };

  // Try manifest first
  const mStartedAt = performance.now();
  const manifest = await tryLoadManifest(baseUrl);
  logPhase("manifest", mStartedAt, { found: !!manifest });

  if (manifest) {
    return await loadFromManifest(baseUrl, manifest, logPhase, options);
  }

  if (isRemoteSpecifier(originalPath)) {
    console.warn(
      `[copilotz:resources] Remote resource ${originalPath} has no manifest.ts — skipping.`,
    );
    return { agents: [] };
  }

  // Local path without manifest: fall back to readDir-based discovery
  return await loadFromDirectory(baseUrl, logPhase, { imports: options?.imports });
}

// ---- Merge helper ---------------------------------------------------------

function mergeResources(target: Resources, source: Resources): void {
  target.agents.push(...(source.agents ?? []));
  if (source.tools?.length) {
    target.tools = [...(target.tools ?? []), ...source.tools];
  }
  if (source.apis?.length) {
    target.apis = [...(target.apis ?? []), ...source.apis];
  }
  if (source.processors?.length) {
    target.processors = [...(target.processors ?? []), ...source.processors];
  }
  if (source.skills?.length) {
    target.skills = [...(target.skills ?? []), ...source.skills];
  }
  if (source.mcpServers?.length) {
    target.mcpServers = [...(target.mcpServers ?? []), ...source.mcpServers];
  }
  if (source.memory?.length) {
    target.memory = mergeNamedResources(target.memory, source.memory);
  }
  target.llm = mergeNamedResources(target.llm, source.llm);
  target.embeddings = mergeNamedResources(target.embeddings, source.embeddings);
  target.storage = mergeNamedResources(target.storage, source.storage);
  target.collections = mergeNamedResources(target.collections, source.collections);
  if (source.features?.length) {
    const existing = target.features ?? [];
    const existingNames = new Set(existing.map((f) => f.name));
    for (const feature of source.features) {
      if (existingNames.has(feature.name)) {
        const idx = existing.findIndex((f) => f.name === feature.name);
        existing[idx] = {
          ...existing[idx],
          actions: { ...existing[idx].actions, ...feature.actions },
        };
      } else {
        existing.push(feature);
      }
    }
    target.features = existing;
  }
  if (source.channels?.length) {
    target.channels = mergeChannelEntries(target.channels, source.channels);
  }
  // Merge extensible resource types
  for (const [key, value] of Object.entries(source)) {
    if (
      (KNOWN_RESOURCE_TYPES as readonly string[]).includes(key) ||
      !Array.isArray(value)
    ) {
      continue;
    }
    const existing = (target as Record<string, unknown>)[key];
    (target as Record<string, unknown>)[key] = Array.isArray(existing)
      ? [...existing, ...value]
      : [...value];
  }
}

// ---- Entry point ----------------------------------------------------------

/**
 * Load Copilotz resources from one or more paths.
 *
 * Each path can be:
 * - A **local directory** (relative to `cwd` or absolute) — uses `readDir`
 *   discovery, or manifest-guided loading if `manifest.ts` exists.
 * - A **remote specifier** (`jsr:`, `npm:`, `https://`) — **requires**
 *   `manifest.ts` at the root declaring what the package provides.
 *
 * @example
 * ```ts
 * // Single local path (backward compatible)
 * const resources = await loadResources({ path: "./resources" });
 *
 * // Multiple paths including remote packages
 * const resources = await loadResources({
 *   path: [
 *     "./resources",
 *     "jsr:@copilotz/browser-session@^1.0.0",
 *   ],
 * });
 * ```
 */
const loadResources = async (
  { path, preset, imports }: ResourceLoadOptions = { path: "resources" },
): Promise<Resources> => {
  const debug = isInitDebugEnabled();
  const totalStartedAt = performance.now();
  const paths = Array.isArray(path) ? path : [path];

  if (paths.length === 0) {
    return { agents: [] };
  }

  // Single path: load directly (no merge overhead)
  if (paths.length === 1) {
    const baseUrl = toBaseUrl(paths[0]);
    const result = await loadResourcePath(baseUrl, paths[0], debug, {
      preset,
      imports,
    });
    if (debug) {
      console.log("[copilotz:resources]", {
        phase: "total",
        elapsedMs: elapsedMs(totalStartedAt),
        agents: result.agents?.length ?? 0,
        tools: (result.tools as unknown[] | undefined)?.length ?? 0,
        apis: (result.apis as unknown[] | undefined)?.length ?? 0,
        processors: (result.processors as unknown[] | undefined)?.length ?? 0,
        skills: (result.skills as unknown[] | undefined)?.length ?? 0,
      });
    }
    return result;
  }

  // Multiple paths: load all in parallel, then merge
  const merged: Resources = { agents: [] };
  const allLoaded = await Promise.all(
    paths.map((p) =>
      loadResourcePath(toBaseUrl(p), p, debug, { preset, imports })
    ),
  );
  for (const loaded of allLoaded) {
    mergeResources(merged, loaded);
  }

  if (debug) {
    console.log("[copilotz:resources]", {
      phase: "total",
      elapsedMs: elapsedMs(totalStartedAt),
      paths: paths.length,
      agents: merged.agents?.length ?? 0,
      tools: (merged.tools as unknown[] | undefined)?.length ?? 0,
      apis: (merged.apis as unknown[] | undefined)?.length ?? 0,
      processors: (merged.processors as unknown[] | undefined)?.length ?? 0,
      skills: (merged.skills as unknown[] | undefined)?.length ?? 0,
    });
  }

  return merged;
};

export default loadResources;
