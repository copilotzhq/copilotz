import type { WorkerWorkHandler } from "@oxian/oxian-js/worker";
import type { CollectionDefinition } from "@/database/collections/types.ts";
import { createEventCollectionsManager } from "@/database/collections/event-manager.ts";
import { createDatabase, type DatabaseConfig } from "@/database/database.ts";
import {
  type CommitMutationResult,
  EventStore,
} from "@/database/event-store.ts";
import { DomainStore } from "@/database/domain-store.ts";
import type {
  CopilotzPlugin,
  PluginResolver,
  PluginResources,
  PluginSource,
} from "@/plugins/types.ts";
import { PluginRegistry } from "@/plugins/registry.ts";
import type { Processor } from "@/processors/types.ts";
import type {
  Agent,
  API,
  ChannelResource,
  MCPServer,
  MemoryResource,
  NewAgent,
  NewTool,
  ProviderResource,
  SkillResource,
  Tool,
} from "@/types/resources.ts";
import { EventBus } from "./event-bus.ts";
import { SettlementMonitor } from "./settlement.ts";
import { DeliveryExecutor } from "./delivery-executor.ts";
import { StreamExecutor } from "./stream-executor.ts";
import { LiveProcessorExecutor } from "./live-processor-executor.ts";
import { createCopilotzWorkloads } from "./workloads.ts";
import { createCorePlugin } from "@/core/plugin.ts";
import type { CoreServicesRef } from "@/core/services.ts";
import {
  type AssetConfig,
  type AssetStore,
  createAssetStore,
} from "@/assets/index.ts";
import { createEventAssetService } from "@/assets/event-service.ts";

export interface CopilotzWorkerRuntimeConfig {
  plugins?: readonly PluginSource[];
  pluginResolver?: PluginResolver;
  pluginBaseUrl?: string;
  agents?: readonly (Agent | NewAgent)[];
  tools?: readonly (Tool | NewTool)[];
  processors?: readonly Processor[];
  collections?: readonly CollectionDefinition[];
  providers?: readonly ProviderResource[];
  channels?: readonly ChannelResource[];
  skills?: readonly SkillResource[];
  memory?: readonly MemoryResource[];
  apis?: readonly API[];
  mcpServers?: readonly MCPServer[];
  database?: DatabaseConfig;
  assets?: { config?: AssetConfig; store?: AssetStore };
  toolExecutionTimeoutMs?: number;
  toolExecutionTimeoutsMs?: Record<string, number | undefined>;
  validateCollections?: boolean;
}

export interface CopilotzWorkerRuntime {
  readonly workloads: Readonly<Record<string, WorkerWorkHandler>>;
  readonly plugins: PluginRegistry;
  compact(
    retentionMs?: number | null,
  ): Promise<{ events: number; deliveries: number }>;
  close(): Promise<void>;
}

function resources(config: CopilotzWorkerRuntimeConfig): PluginResources {
  return {
    agents: config.agents?.map((agent) => ({
      ...agent,
      id: agent.id ?? agent.name,
    } as Agent)),
    tools: config.tools?.map((tool) => ({
      ...tool,
      id: tool.id ?? tool.key,
    } as Tool)),
    processors: config.processors,
    collections: config.collections,
    providers: config.providers,
    channels: config.channels,
    skills: config.skills,
    memory: config.memory,
    apis: config.apis,
    mcpServers: config.mcpServers,
  };
}

async function resolver(
  config: CopilotzWorkerRuntimeConfig,
): Promise<PluginResolver | undefined> {
  if (config.pluginResolver) return config.pluginResolver;
  if (
    !config.plugins?.some((plugin) =>
      typeof plugin === "string" || "source" in plugin
    )
  ) {
    return undefined;
  }
  const { createDefaultPluginResolver } = await import(
    "@/runtime/adapters/plugin-resolver.ts"
  );
  return createDefaultPluginResolver(config.pluginBaseUrl);
}

/**
 * Builds long-lived Copilotz workload handlers for an Oxian worker. The worker
 * owns one Ominipg session and resolves logical processor/provider IDs locally.
 */
export async function createCopilotzWorkerRuntime(
  config: CopilotzWorkerRuntimeConfig,
): Promise<CopilotzWorkerRuntime> {
  const servicesRef: CoreServicesRef = {};
  const core: CopilotzPlugin = createCorePlugin(servicesRef);
  const registry = await PluginRegistry.compose({
    core,
    plugins: config.plugins,
    resources: resources(config),
    resolver: await resolver(config),
  });
  const database = await createDatabase(config.database);
  const events = new EventStore(database.session, database.schema);
  const bus = new EventBus();
  const settlement = new SettlementMonitor(events);
  const committed = (result: CommitMutationResult<unknown>) => {
    bus.publish(result.event);
    settlement.wake();
  };
  const collections = createEventCollectionsManager(
    events,
    registry.list("collections"),
    {
      validateOnWrite: config.validateCollections ?? true,
      resolveConsumers: (event) =>
        registry.matchDurable(event).map((processor) => processor.id),
      committed,
    },
  );
  const domain = new DomainStore(events, {
    resolveConsumers: (event) =>
      registry.matchDurable(event).map((processor) => processor.id),
    committed,
  });
  const liveProcessors = new LiveProcessorExecutor({
    bus,
    registry,
    collections,
  });
  const assetStore = config.assets?.store ??
    createAssetStore(config.assets?.config);
  const assets = createEventAssetService({
    store: assetStore,
    collections,
  });
  const delivery = new DeliveryExecutor({
    store: events,
    registry,
    collections,
    bus,
    settlement,
  });
  const stream = new StreamExecutor({
    store: events,
    domain,
    registry,
    committed,
  });
  servicesRef.current = {
    domain,
    events,
    bus,
    registry,
    collections,
    assetStore,
    assets,
    toolExecutionTimeoutMs: config.toolExecutionTimeoutMs ?? 300_000,
    toolExecutionTimeoutsMs: config.toolExecutionTimeoutsMs,
  };
  const workloads = createCopilotzWorkloads({ delivery, stream, bus });
  let closed = false;
  return {
    workloads,
    plugins: registry,
    compact: (retentionMs) => events.compact({ retentionMs }),
    async close() {
      if (closed) return;
      closed = true;
      await liveProcessors.close("copilotz_worker_shutdown");
      bus.close();
      await database.close();
    },
  };
}
