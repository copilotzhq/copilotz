/**
 * Resource loader for file-based Copilotz configuration.
 * 
 * Loads agents, APIs, tools, and custom processors from a directory structure.
 * 
 * @module
 */

import type {
    AgentConfig,
    APIConfig,
    ToolConfig,
    MCPServer,
} from "@/index.ts";
import type { EventProcessor, Event, NewEvent, NewUnknownEvent, ProcessorDeps } from "@/interfaces/index.ts";

/**
 * Resources loaded from the file system.
 * Contains all agents, APIs, tools, MCP servers, and custom processors.
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
    /** Array of loaded custom event processors. */
    processors?: Array<(EventProcessor<unknown, ProcessorDeps> & { eventType: string; priority?: number; id?: string })>;
};

async function* readDir(relativePath: string) {
    try {
        for await (const entry of Deno.readDir(relativePath)) {
            yield entry;
        }
    } catch {
        return;
    }
}

const loadModule = async (specifier: string, options?: ImportCallOptions) => {
    const s = 'file://' + specifier;
    const module = await import(s, options);
    return module?.default ?? module;
};

const loadModuleSafe = async (specifier: string, options?: ImportCallOptions) => {
    try {
        return await loadModule(specifier, options);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to load resource: ${specifier}`, message);
        return undefined;
    }
};

// Coerce dynamically loaded functions to EventProcessor signatures without unsafe casts.
const asShouldProcess = (
    fn: (event: unknown, deps?: unknown) => boolean | Promise<boolean>,
): EventProcessor<unknown, ProcessorDeps>["shouldProcess"] => {
    return async (event: Event, deps: ProcessorDeps): Promise<boolean> => {
        try {
            const result = await fn(event, deps);
            return Boolean(result);
        } catch {
            return false;
        }
    };
};

const asProcess = (
    fn: (event: unknown, deps?: unknown) => unknown | Promise<unknown>,
): EventProcessor<unknown, ProcessorDeps>["process"] => {
    return async (event: Event, deps: ProcessorDeps) => {
        try {
            const result = await fn(event, deps);
            if (result == null) return;
            // If module returned a NewEvent[]
            if (Array.isArray(result)) {
                return { producedEvents: result as Array<NewEvent | NewUnknownEvent> };
            }
            // If module returned a single NewEvent
            if (typeof result === "object" && result && "type" in (result as Record<string, unknown>) && "payload" in (result as Record<string, unknown>)) {
                return { producedEvents: [result as NewEvent | NewUnknownEvent] };
            }
            // If module returned a shape with producedEvents
            if (typeof result === "object" && result && "producedEvents" in (result as Record<string, unknown>)) {
                const produced = (result as { producedEvents?: unknown }).producedEvents;
                if (Array.isArray(produced)) return { producedEvents: produced as Array<NewEvent | NewUnknownEvent> };
                if (produced) return { producedEvents: [produced as NewEvent | NewUnknownEvent] };
            }
            // Otherwise, ignore
            return;
        } catch {
            return;
        }
    };
};

/**
 * Loads Copilotz resources from a file-based directory structure.
 * 
 * Expected directory structure:
 * ```
 * resources/
 *   agents/
 *     agent-name/
 *       instructions.md   # Agent instructions (required)
 *       config.ts         # Agent configuration (optional)
 *   apis/
 *     api-name/
 *       openApiSchema.json  # OpenAPI schema (required)
 *       config.ts           # API configuration (optional)
 *   tools/
 *     tool-name/
 *       config.ts    # Tool configuration (required)
 *       execute.ts   # Tool execution function (required)
 *   event-processors/
 *     event_type/
 *       processor.ts  # Processor with shouldProcess and process exports
 * ```
 * 
 * @param options - Options object with path to resources directory
 * @param options.path - Path to resources directory. Default: "resources"
 * @returns Promise resolving to loaded Resources
 * 
 * @example
 * ```ts
 * const resources = await loadResources({ path: "./my-resources" });
 * 
 * const copilotz = await createCopilotz({
 *   agents: resources.agents,
 *   apis: resources.apis,
 *   tools: resources.tools,
 *   processors: resources.processors
 * });
 * ```
 */
const loadResources = async ({ path }: { path: string } = { path: "resources" }): Promise<Resources> => {
    const agentConfigs: Array<AgentConfig> = [];

    const agentsPath = Deno.cwd() + '/' + path + '/agents/';
    const apisPath = Deno.cwd() + '/' + path + '/apis/';
    const toolsPath = Deno.cwd() + '/' + path + '/tools/';
    const processorsPath = Deno.cwd() + '/' + path + '/event-processors/';


    for await (const entry of readDir(agentsPath.replace('file://', ''))) {
        if (!entry.isDirectory) {
            continue;
        }

        const instructions = await loadModuleSafe(
            agentsPath + entry.name + '/instructions.md',
            { with: { type: 'text' } },
        );

        if (!instructions) {
            continue;
        }

        const config = await loadModuleSafe(agentsPath + entry.name + '/config.ts') ?? {};

        agentConfigs.push({
            id: entry.name,
            name: entry.name,
            instructions,
            ...config,
        });
    }

    const apiConfigs: Array<APIConfig> = [];

    for await (const entry of readDir(apisPath.replace('file://', ''))) {
        if (!entry.isDirectory) {
            continue;
        }

        const config = await loadModuleSafe(apisPath + entry.name + '/config.ts') ?? {};
        const openApiSchema = await loadModuleSafe(
            apisPath + entry.name + '/openApiSchema.json',
            { with: { type: 'json' } },
        );

        if (!openApiSchema) {
            continue;
        }

        apiConfigs.push({
            id: entry.name,
            name: entry.name,
            openApiSchema,
            ...config,
        });
    }

    const toolConfigs: Array<ToolConfig> = [];

    for await (const entry of readDir(toolsPath.replace('file://', ''))) {
        if (!entry.isDirectory) {
            continue;
        }

        const config = await loadModuleSafe(toolsPath + entry.name + '/config.ts');
        const execute = await loadModuleSafe(toolsPath + entry.name + '/execute.ts');

        if (!config || !execute) {
            continue;
        }

        toolConfigs.push({
            id: entry.name,
            name: entry.name,
            ...config,
            execute,
        });
    }

    const processors: Array<(EventProcessor<unknown, ProcessorDeps> & { eventType: string; priority?: number; id?: string })> = [];

    // Discover processors under resources/processors/<event-type>/*
    try {
        for await (const evtDir of readDir(processorsPath.replace('file://', ''))) {
            if (!evtDir.isDirectory) {
                continue;
            }
            const eventTypeDir = evtDir.name; // e.g., 'new_message', 'llm_call', 'tool_call', 'media'
            const eventTypeKey = eventTypeDir.toUpperCase(); // 'NEW_MESSAGE', 'LLM_CALL', 'TOOL_CALL', 'MEDIA'

            type Discovered = {
                shouldProcess: (event: unknown, deps?: unknown) => boolean | Promise<boolean>;
                process: (event: unknown, deps?: unknown) => unknown | Promise<unknown>;
                priority?: number;
                name?: string;
            };

            const discovered: Discovered[] = [];

            const dirPath = (processorsPath + eventTypeDir + '/').replace('file://', '');
            for await (const file of readDir(dirPath)) {
                if (!file.isFile || !file.name.endsWith(".ts")) {
                    continue;
                }
                const specifier = processorsPath + eventTypeDir + '/' + file.name;
                const specifierUrl = 'file://' + specifier;
                let mod: Record<string, unknown> | undefined;
                try {
                    mod = await import(specifierUrl);
                } catch (error) {
                    console.warn(`Failed to load processor: ${specifier}`, error);
                    continue;
                }
                const maybeShouldProcess = mod?.shouldProcess;
                const maybeProcess = mod?.process || mod?.default;
                const maybePriority = mod?.priority;

                if (typeof maybeShouldProcess === "function" && typeof maybeProcess === "function") {
                    discovered.push({
                        shouldProcess: maybeShouldProcess as (event: unknown, deps?: unknown) => boolean | Promise<boolean>,
                        process: maybeProcess as (event: unknown, deps?: unknown) => unknown | Promise<unknown>,
                        priority: typeof maybePriority === "number" ? maybePriority : 0,
                        name: file.name,
                    });
                }
            }


            if (discovered.length > 0) {
                // Sort by priority desc, then by filename for stable order
                discovered.sort((a, b) => {
                    if (b.priority !== a.priority) return (b.priority ?? 0) - (a.priority ?? 0);
                    return (a.name ?? '').localeCompare(b.name ?? '', 'en', { sensitivity: 'base' });
                });
                for (const d of discovered) {
                    processors.push({
                        shouldProcess: asShouldProcess(d.shouldProcess),
                        process: asProcess(d.process),
                        eventType: eventTypeKey,
                        priority: d.priority,
                    });
                }
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to load processors from: ${processorsPath}`, message);
    }

    return {
        agents: agentConfigs,
        apis: apiConfigs,
        tools: toolConfigs,
        processors,
    };
};

export default loadResources;