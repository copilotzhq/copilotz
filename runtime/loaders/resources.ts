/**
 * Resource loader for Copilotz configuration.
 *
 * Supports local directories (readDir discovery), manifest-guided loading,
 * and remote URLs (jsr:, npm:, https://).
 *
 * @module
 */

import type { AgentConfig, APIConfig, MCPServer, ToolConfig } from "@/index.ts";
import type {
  Event,
  EventProcessor,
  NewEvent,
  NewUnknownEvent,
  ProcessorDeps,
} from "@/types/index.ts";
import type { Skill } from "@/runtime/loaders/skill-types.ts";
import { loadSkillsFromDirectory } from "@/runtime/loaders/skill-loader.ts";

// ---- Types ----------------------------------------------------------------

type ProcessorEntry = EventProcessor<unknown, ProcessorDeps> & {
  eventType: string;
  priority?: number;
  id?: string;
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
}

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
  /** Array of loaded skill definitions. */
  skills?: Skill[];
  /** Array of loaded custom event processors. */
  processors?: ProcessorEntry[];
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
] as const;

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
  const abs = path.startsWith("/") ? path : Deno.cwd() + "/" + path;
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
      const produced =
        (result as { producedEvents?: unknown }).producedEvents;
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
      const toolUrl = joinUrl(baseUrl, "tools", name);
      const [config, execute] = await Promise.all([
        importModuleSafe(joinUrl(toolUrl, "config.ts")),
        importModuleSafe(joinUrl(toolUrl, "execute.ts")),
      ]);
      if (!config || !execute) return null;
      return {
        id: name,
        name,
        ...(config as object),
        execute,
      } as ToolConfig;
    }),
  );
  return settled.filter((r): r is ToolConfig => r !== null);
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

/**
 * Generic loader for extensible resource types (llm, embeddings, storage, collections, etc.).
 * Tries three conventions in order:
 *   1. Directory with `config.ts` + `adapter.ts` (provider pattern)
 *   2. Single `<name>.ts` file (collection pattern)
 *   3. Directory with `index.ts`
 */
async function loadGenericByManifest(
  baseUrl: string,
  resourceType: string,
  names: string[],
): Promise<unknown[]> {
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
        ...(config && typeof config === "object" ? config : {}),
        ...(adapter && typeof adapter === "object" ? adapter : {}),
      };
    }

    // 2. Single file: <type>/<name>.ts
    if (singleMod) return singleMod;

    // 3. Directory with index.ts
    if (indexMod) return indexMod;

    return null;
  }));
  return settled.filter((r) => r !== null);
}

// ---- Manifest-driven full load --------------------------------------------

async function loadFromManifest(
  baseUrl: string,
  manifest: ResourceManifest,
  logPhase: LogPhase,
): Promise<Resources> {
  const { provides } = manifest;
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
        .then((r) => { resources.agents = r; }),
    );
  }

  if (provides.tools?.length) {
    tasks.push(
      timed("tools", () => loadToolsByManifest(baseUrl, provides.tools!))
        .then((r) => { resources.tools = r; }),
    );
  }

  if (provides.apis?.length) {
    tasks.push(
      timed("apis", () => loadApisByManifest(baseUrl, provides.apis!))
        .then((r) => { resources.apis = r; }),
    );
  }

  if (provides.processors?.length) {
    tasks.push(
      timed("processors", () =>
        loadProcessorsByManifest(baseUrl, provides.processors!),
      ).then((r) => { resources.processors = r; }),
    );
  }

  if (provides.skills?.length && baseUrl.startsWith("file://")) {
    tasks.push(
      timed("skills", () => {
        const skillsUrl = joinUrl(baseUrl, "skills");
        const skillsPath =
          decodeURIComponent(skillsUrl.replace("file://", "")) + "/";
        return loadSkillsFromDirectory(skillsPath, "project");
      }).then((r) => { resources.skills = r; }),
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
): Promise<Resources> {
  const resources: Resources = { agents: [] };

  const collectEntries = async (url: string): Promise<Deno.DirEntry[]> => {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of readDir(url)) entries.push(entry);
    return entries;
  };

  // Fire all resource types in parallel
  const tasks: Promise<void>[] = [];

  // ---- Agents ----
  tasks.push((async () => {
    const s = performance.now();
    const agentsUrl = joinUrl(baseUrl, "agents");
    const entries = await collectEntries(agentsUrl);
    const agents = await Promise.all(
      entries.filter((e) => e.isDirectory).map(async (entry) => {
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
  tasks.push((async () => {
    const s = performance.now();
    const apisUrl = joinUrl(baseUrl, "apis");
    const entries = await collectEntries(apisUrl);
    const apis = await Promise.all(
      entries.filter((e) => e.isDirectory).map(async (entry) => {
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
  tasks.push((async () => {
    const s = performance.now();
    const toolsUrl = joinUrl(baseUrl, "tools");
    const entries = await collectEntries(toolsUrl);
    const tools = await Promise.all(
      entries
        .filter((e) => e.isDirectory && !e.name.startsWith("_"))
        .map(async (entry) => {
          const toolUrl = joinUrl(toolsUrl, entry.name);
          const [config, execute] = await Promise.all([
            importModuleSafe(joinUrl(toolUrl, "config.ts")),
            importModuleSafe(joinUrl(toolUrl, "execute.ts")),
          ]);
          if (!config || !execute) return null;
          return {
            id: entry.name,
            name: entry.name,
            ...(config as object),
            execute,
          } as ToolConfig;
        }),
    );
    resources.tools = tools.filter((t): t is ToolConfig => t !== null);
    logPhase("tools", s, { count: resources.tools.length });
  })());

  // ---- Processors ----
  tasks.push((async () => {
    const s = performance.now();
    const processorsUrl = joinUrl(baseUrl, "processors");
    try {
      const evtDirs = await collectEntries(processorsUrl);

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
        evtDirs.filter((e) => e.isDirectory).map(async (evtDir) => {
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
  tasks.push((async () => {
    const skillsPath =
      joinUrl(baseUrl, "skills").replace("file://", "") + "/";
    const s = performance.now();
    resources.skills = await loadSkillsFromDirectory(skillsPath, "project");
    logPhase("skills", s, { count: resources.skills?.length ?? 0 });
  })());

  await Promise.all(tasks);

  return resources;
}

// ---- Single path loading --------------------------------------------------

async function loadResourcePath(
  baseUrl: string,
  originalPath: string,
  debug: boolean,
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
    return await loadFromManifest(baseUrl, manifest, logPhase);
  }

  if (isRemoteSpecifier(originalPath)) {
    console.warn(
      `[copilotz:resources] Remote resource ${originalPath} has no manifest.ts — skipping.`,
    );
    return { agents: [] };
  }

  // Local path without manifest: fall back to readDir-based discovery
  return await loadFromDirectory(baseUrl, logPhase);
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
  { path }: { path: string | string[] } = { path: "resources" },
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
    const result = await loadResourcePath(baseUrl, paths[0], debug);
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
    paths.map((p) => loadResourcePath(toBaseUrl(p), p, debug)),
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
