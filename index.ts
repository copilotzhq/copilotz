// Event-queue engine (now default)
import { createDatabase, schema, migrations } from "@/database/index.ts";
import type { OminipgWithCrud } from "omnipg";
import { runThread, type RunHandle, type RunOptions, type UnifiedOnEvent } from "@/runtime/index.ts";

import type {
    Agent,
    API,
    ChatCallbacks,
    ChatContext,
    EventProcessor,
    ProcessorDeps,
    CopilotzDb,
    DatabaseConfig,
    MCPServer,
    MessagePayload,
    Tool,
    ToolCallEventPayload,
    LlmCallEventPayload,
    TokenEventPayload,
} from "./interfaces/index.ts";


import defaultBanner from "@/runtime/banner.ts";

export { getNativeTools } from "@/event-processors/tool_call/native-tools-registry/index.ts";

export * from "@/interfaces/index.ts";
export { createDatabase, schema, migrations };
export type { ToolCallPayload, LLMCallPayload } from "@/interfaces/index.ts";
export { registerEventProcessor } from "@/event-processors/index.ts";
export type { StreamEvent } from "@/runtime/index.ts";

import type { AssetStore, AssetConfig } from "@/utils/assets.ts";
import { createMemoryAssetStore, createAssetStore, bytesToBase64 } from "@/utils/assets.ts";
// JSON-schema-derived database typing helpers (single source of truth)
export type DbSchemas = typeof schema;
export type DbCrud = OminipgWithCrud<DbSchemas>["crud"];

export { default as loadResources } from "@/utils/loaders/resources.ts";

export type CopilotzEvent =
    | { type: "NEW_MESSAGE"; payload: MessagePayload }
    | { type: "TOOL_CALL"; payload: ToolCallEventPayload }
    | { type: "LLM_CALL"; payload: LlmCallEventPayload }
    | { type: "TOKEN"; payload: TokenEventPayload };


export type AgentConfig = Agent; 
export type ToolConfig = Tool;
export type APIConfig = API;
export type MCPServerConfig = MCPServer;

type NormalizedCopilotzConfig = Omit<CopilotzConfig, "agents" | "tools" | "apis" | "mcpServers"> & {
    agents: Agent[];
    tools?: Tool[];
    apis?: API[];
    mcpServers?: MCPServer[];
    customProcessorsByType?: ChatContext["customProcessors"];
};

function normalizeAgent(agent: AgentConfig): Agent {
    const now = new Date().toISOString();
    return {
        ...agent,
        createdAt: ("createdAt" in agent && agent.createdAt ? agent.createdAt : now) as Agent["createdAt"],
        updatedAt: ("updatedAt" in agent && agent.updatedAt ? agent.updatedAt : now) as Agent["updatedAt"],
    };
}

function normalizeTool(tool: ToolConfig): Tool {
    const now = new Date().toISOString();
    return {
        ...tool,
        createdAt: ("createdAt" in tool && tool.createdAt ? tool.createdAt : now) as Tool["createdAt"],
        updatedAt: ("updatedAt" in tool && tool.updatedAt ? tool.updatedAt : now) as Tool["updatedAt"],
    };
}

function normalizeApi(api: APIConfig): API {
    const now = new Date().toISOString();
    return {
        ...api,
        createdAt: ("createdAt" in api && api.createdAt ? api.createdAt : now) as API["createdAt"],
        updatedAt: ("updatedAt" in api && api.updatedAt ? api.updatedAt : now) as API["updatedAt"],
    };
}

function normalizeMcpServer(server: MCPServerConfig): MCPServer {
    const now = new Date().toISOString();
    return {
        ...server,
        createdAt: ("createdAt" in server && server.createdAt ? server.createdAt : now) as MCPServer["createdAt"],
        updatedAt: ("updatedAt" in server && server.updatedAt ? server.updatedAt : now) as MCPServer["updatedAt"],
    };
}

export interface CopilotzConfig {
    agents: AgentConfig[];
    tools?: ToolConfig[];
    apis?: APIConfig[];
    mcpServers?: MCPServerConfig[];
    processors?: Array<(EventProcessor<unknown, ProcessorDeps> & { eventType: string; priority?: number; id?: string })>;
    callbacks?: ChatCallbacks;
    dbConfig?: DatabaseConfig;
    dbInstance?: CopilotzDb;
    threadMetadata?: Record<string, unknown>;
    queueTTL?: number;
    stream?: boolean;
    activeTaskId?: string;
    assets?: {
        config?: AssetConfig;
        store?: AssetStore;
    };
    rag?: {
        enabled?: boolean;
        embedding: {
            provider: "openai" | "ollama" | "cohere";
            model: string;
            apiKey?: string;
            baseUrl?: string;
            dimensions?: number;
            batchSize?: number;
        };
        chunking?: {
            strategy?: "fixed" | "paragraph" | "sentence";
            chunkSize?: number;
            chunkOverlap?: number;
        };
        retrieval?: {
            defaultLimit?: number;
            similarityThreshold?: number;
        };
        defaultNamespace?: string;
    };
}

export type CopilotzRunResult = RunHandle;

export type CopilotzRunOverrides = never;

export interface CopilotzSessionHistoryEntry {
    message: MessagePayload;
    result: CopilotzRunResult;
}

export interface CopilotzCliIO {
    prompt(message: string): Promise<string>;
    print(line: string): void;
}

export interface CopilotzCliController {
    stop(): void;
    readonly closed: Promise<void>;
}

export interface Copilotz {
    readonly config: Readonly<CopilotzConfig>;
    readonly ops: CopilotzDb["ops"];
    run(message: MessagePayload, onEvent?: UnifiedOnEvent, options?: RunOptions): Promise<CopilotzRunResult>;
    start(initialMessage?: (MessagePayload & { banner?: string | null; quitCommand?: string; threadExternalId?: string }) | string, onEvent?: UnifiedOnEvent): CopilotzCliController;
    shutdown(): Promise<void>;
    assets: {
        getBase64: (refOrId: string) => Promise<{ base64: string; mime: string }>;
        getDataUrl: (refOrId: string) => Promise<string>;
    };
}

export interface CopilotzCliController {
    stop(): void;
    readonly closed: Promise<void>;
}

export async function createCopilotz(config: CopilotzConfig): Promise<Copilotz> {

    const normalizedAgents = config.agents.map(normalizeAgent);
    const normalizedTools = config.tools?.map(normalizeTool);
    const normalizedApis = config.apis?.map(normalizeApi);
    const normalizedMcpServers = config.mcpServers?.map(normalizeMcpServer);

    const baseConfig: NormalizedCopilotzConfig = {
        ...config,
        agents: normalizedAgents,
        tools: normalizedTools,
        apis: normalizedApis,
        mcpServers: normalizedMcpServers,
    };

    const managedDb = config.dbInstance ? undefined : await createDatabase(config.dbConfig);
    const baseDb = config.dbInstance ?? managedDb;
    if (!baseDb) {
        throw new Error("Failed to initialize Copilotz database instance.");
    }
    const baseOps = baseDb.ops;

    // Prepare custom processors map (order preserved; highest priority first in provided array)
    if (Array.isArray(config.processors) && config.processors.length > 0) {
        const byType: Record<string, Array<EventProcessor<unknown, ProcessorDeps>>> = {};
        for (const p of config.processors) {
            if (!p || typeof p !== "object") continue;
            const eventType = (p as { eventType?: string }).eventType;
            if (!eventType || typeof (p as EventProcessor<unknown, ProcessorDeps>).shouldProcess !== "function" || typeof (p as EventProcessor<unknown, ProcessorDeps>).process !== "function") continue;
            const key = String(eventType).toUpperCase();
            if (!byType[key]) byType[key] = [];
            byType[key].push(p as EventProcessor<unknown, ProcessorDeps>);
        }
        baseConfig.customProcessorsByType = byType;
    }

    // Single asset store instance per Copilotz
    const assetStoreInstance = (config.assets && config.assets.store)
        ? config.assets.store
        : (config.assets?.config ? createAssetStore(config.assets.config) : createMemoryAssetStore());

    const performRun = async (
        message: MessagePayload,
        onEvent?: UnifiedOnEvent,
        options?: RunOptions,
    ): Promise<CopilotzRunResult> => {
        if (!message?.content && !message?.toolCalls?.length) {
            throw new Error("message with content or toolCalls is required.");
        }
        const ctx: ChatContext = {
            agents: baseConfig.agents,
            tools: baseConfig.tools,
            apis: baseConfig.apis,
            mcpServers: baseConfig.mcpServers,
            callbacks: baseConfig.callbacks,
            dbConfig: baseConfig.dbConfig,
            dbInstance: baseDb,
            threadMetadata: baseConfig.threadMetadata,
            queueTTL: baseConfig.queueTTL,
            stream: options?.stream ?? baseConfig.stream ?? false,
            activeTaskId: baseConfig.activeTaskId,
            customProcessors: baseConfig.customProcessorsByType,
            assetStore: assetStoreInstance,
            assetConfig: config.assets?.config,
            resolveAsset: async (ref: string) => {
                const id = ref.startsWith("asset://") ? ref.slice("asset://".length) : ref;
                return await assetStoreInstance.get(id);
            },
            // RAG configuration
            ragConfig: config.rag ? {
                enabled: config.rag.enabled ?? true,
                embedding: config.rag.embedding,
                chunking: config.rag.chunking,
                retrieval: config.rag.retrieval,
                defaultNamespace: config.rag.defaultNamespace,
            } : undefined,
            embeddingConfig: config.rag?.embedding,
        };
        return await runThread(baseDb, ctx, message, onEvent, options);
    };

    return {
        config: Object.freeze({ ...baseConfig }),
        get ops() {
            return baseOps;
        },
        run: performRun,
        start: (initialMessage?: (MessagePayload & { banner?: string | null; quitCommand?: string; threadExternalId?: string }) | string, onEvent?: UnifiedOnEvent) => {
            let quitCommand = "quit";
            let banner: string | null = typeof defaultBanner === "string" ? defaultBanner : null;
            let threadExternalId = crypto.randomUUID().slice(0, 24);
            let sessionSender: MessagePayload["sender"] | undefined = { type: "user", name: "user" };
            let sessionParticipants: string[] | undefined = undefined;

            if (initialMessage && typeof initialMessage === "object") {
                if (typeof (initialMessage as { quitCommand?: string }).quitCommand === "string") {
                    quitCommand = (initialMessage as { quitCommand?: string }).quitCommand as string;
                }
                const maybeBanner = (initialMessage as { banner?: string | null }).banner;
                if (typeof maybeBanner === "string" || maybeBanner === null) {
                    banner = maybeBanner;
                }
                const maybeThreadExternalId = (initialMessage as { threadExternalId?: string }).threadExternalId;
                if (typeof maybeThreadExternalId === "string" && maybeThreadExternalId.trim().length > 0) {
                    threadExternalId = maybeThreadExternalId;
                } else {
                    // Fallback to the thread.externalId inside the initial MessagePayload if present
                    const maybeMsg = initialMessage as unknown as MessagePayload;
                    const fromThread = (maybeMsg && typeof maybeMsg === "object") ? (maybeMsg.thread as { externalId?: string } | undefined) : undefined;
                    if (fromThread && typeof fromThread.externalId === "string" && fromThread.externalId.trim().length > 0) {
                        threadExternalId = fromThread.externalId;
                    }
                }
                // Capture sender and participants for subsequent messages
                const maybeMsg = initialMessage as unknown as MessagePayload;
                if (maybeMsg?.sender && typeof maybeMsg.sender === "object") {
                    sessionSender = {
                        id: maybeMsg.sender.id ?? undefined,
                        externalId: maybeMsg.sender.externalId ?? null,
                        type: maybeMsg.sender.type ?? "user",
                        name: maybeMsg.sender.name ?? null,
                        identifierType: maybeMsg.sender.identifierType ?? undefined,
                        metadata: (maybeMsg.sender.metadata && typeof maybeMsg.sender.metadata === "object")
                            ? maybeMsg.sender.metadata as Record<string, unknown>
                            : null,
                    };
                }
                const fromParticipants = (initialMessage as { thread?: { participants?: string[] } }).thread?.participants;
                if (Array.isArray(fromParticipants) && fromParticipants.length > 0) {
                    sessionParticipants = fromParticipants.slice();
                }
            }

            let stopped = false;

            const closed = (async () => {
                if (banner) console.log(banner);

                const unifiedOnEvent: UnifiedOnEvent = async (ev) => {
                    const e = ev as unknown as { type?: string; payload?: { token?: string; isComplete?: boolean } };
                    if (e?.type === "TOKEN" && e?.payload) {
                        const token = e.payload.token ?? "";
                        const done = Boolean(e.payload.isComplete);
                        if (!done) {
                            const anyGlobal = globalThis as unknown as {
                                Deno?: { stdout?: { writeSync?: (data: Uint8Array) => unknown } };
                                process?: { stdout?: { write?: (chunk: string) => unknown } };
                            };
                            const bytes = new TextEncoder().encode(token);
                            if (anyGlobal?.Deno?.stdout?.writeSync) {
                                anyGlobal.Deno.stdout.writeSync(bytes);
                            } else if (anyGlobal?.process?.stdout?.write) {
                                anyGlobal.process.stdout.write(token);
                            } else {
                                console.log(token);
                            }
                        } else {
                            console.log("");
                        }
                    }
                    if (typeof onEvent === "function" && ev.type !== "TOKEN") {
                        return await onEvent(ev);
                    } else if (typeof onEvent === "function") {
                        // TOKEN returns ignored (read-only)
                        await Promise.resolve(onEvent(ev)).catch(() => undefined);
                    }
                    return undefined;
                };

                const send = async (content: string) => {
                    const handle = await performRun({
                        content,
                        sender: sessionSender ?? { type: "user", name: "user" },
                        thread: sessionParticipants
                            ? { externalId: threadExternalId, participants: sessionParticipants }
                            : { externalId: threadExternalId },
                    }, unifiedOnEvent, { stream: true, ackMode: "onComplete" });
                    for await (const _ of handle.events) { /* drain */ }
                    await handle.done;
                };

                if (typeof initialMessage === "string" && initialMessage.trim().length > 0) {
                    await send(initialMessage);
                } else if (initialMessage && typeof initialMessage === "object") {
                    const { banner: _b, quitCommand: _q, threadExternalId: _t, ...rest } = initialMessage as Record<string, unknown>;
                    const msg = {
                        ...(rest as MessagePayload),
                        thread: (rest as MessagePayload).thread ?? { externalId: threadExternalId },
                    } as MessagePayload;
                    const handle = await performRun(msg, unifiedOnEvent, { stream: true, ackMode: "onComplete" });
                    for await (const _ of handle.events) { /* drain */ }
                    await handle.done;
                }

                while (!stopped) {
                    const anyGlobal = globalThis as unknown as { prompt?: (msg?: string) => string | null | undefined };
                    const q = ((typeof anyGlobal.prompt === "function" ? anyGlobal.prompt("Message: ") : "") ?? "").trim();
                    if (!q || q.toLowerCase() === quitCommand) {
                        console.log("👋 Ending session. Goodbye!");
                        break;
                    }
                    console.log("\n🔬 Thinking...\n");
                    await send(q);
                    console.log("\n------------------------------------------------------------\n");
                }
            })();

            return {
                stop: () => { stopped = true; },
                closed,
            };
        },
        shutdown: async () => {
            if (managedDb) {
                const resource = managedDb as unknown as { close?: () => Promise<void> | void; end?: () => Promise<void> | void };
                if (typeof resource.close === "function") {
                    await resource.close.call(resource);
                } else if (typeof resource.end === "function") {
                    await resource.end.call(resource);
                }
            }
        },
        assets: {
            getBase64: async (refOrId: string) => {
                const id = refOrId.startsWith("asset://") ? refOrId.slice("asset://".length) : refOrId;
                const { bytes, mime } = await assetStoreInstance.get(id);
                const base64 = bytesToBase64(bytes);
                return { base64, mime };
            },
            getDataUrl: async (refOrId: string) => {
                const id = refOrId.startsWith("asset://") ? refOrId.slice("asset://".length) : refOrId;
                const { bytes, mime } = await assetStoreInstance.get(id);
                const base64 = bytesToBase64(bytes);
                return `data:${mime};base64,${base64}`;
            },
        },
    } satisfies Copilotz;
}
