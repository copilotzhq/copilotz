import type { WorkDispatchTarget } from "@oxian/oxian-js/supervisor";
import type { CollectionDefinition } from "@/database/collections/types.ts";
import { createEventCollectionsManager } from "@/database/collections/event-manager.ts";
import {
  type CopilotzDatabase,
  createDatabase,
  type DatabaseConfig,
  listSchemas,
  provisionSchema,
  schemaExists,
} from "@/database/database.ts";
import { EventStore } from "@/database/event-store.ts";
import { DomainStore } from "@/database/domain-store.ts";
import type { DurableEvent, EventDelivery } from "@/events/types.ts";
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
import type {
  Attachment,
  ConnectOptions,
  RunHandle,
  RunOptions,
} from "@/attachments/types.ts";
import { AttachmentManager } from "@/attachments/manager.ts";
import { OutputHub } from "@/attachments/output-hub.ts";
import { EventBus } from "@/execution/event-bus.ts";
import { SettlementMonitor } from "@/execution/settlement.ts";
import {
  DeliveryCoordinator,
  type OxianDispatcher,
} from "@/execution/coordinator.ts";
import { DeliveryExecutor } from "@/execution/delivery-executor.ts";
import { StreamExecutor } from "@/execution/stream-executor.ts";
import { StreamCoordinator } from "@/execution/stream-coordinator.ts";
import { LiveProcessorExecutor } from "@/execution/live-processor-executor.ts";
import { createPrivateExecutionHost } from "@/execution/private-host.ts";
import { createCopilotzWorkloads } from "@/execution/workloads.ts";
import { createCorePlugin } from "@/core/plugin.ts";
import type { CoreServicesRef } from "@/core/services.ts";
import {
  type AssetConfig,
  type AssetOperations,
  type AssetStore,
  createAssetStore,
} from "@/assets/index.ts";
import { createEventAssetService } from "@/assets/event-service.ts";

export interface OxianConfig {
  /** App-owned shared host or Hypervisor dispatcher. Omit for a private host. */
  dispatcher?: OxianDispatcher;
  /** Copilotz delivery and stream workload target. */
  target?: WorkDispatchTarget;
  /** Ominipg session target; defaults to `target`. */
  databaseTarget?: WorkDispatchTarget;
}

export interface MaintenanceConfig {
  /** Periodic maintenance for long-lived engines. Default: true. */
  periodic?: boolean;
  intervalMs?: number;
  recoveryBatchSize?: number;
  /** `null` retains settled events indefinitely. Default: seven days. */
  retentionMs?: number | null;
}

export interface CopilotzConfig {
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
  oxian?: OxianConfig;
  namespace?: string;
  assets?: { config?: AssetConfig; store?: AssetStore };
  toolExecutionTimeoutMs?: number;
  toolExecutionTimeoutsMs?: Record<string, number | undefined>;
  maintenance?: MaintenanceConfig;
  validateCollections?: boolean;
}

export interface Copilotz {
  readonly config: Readonly<CopilotzConfig>;
  readonly plugins: PluginRegistry;
  readonly collections: ReturnType<typeof createEventCollectionsManager>;
  readonly assets: AssetOperations;
  connect(options: ConnectOptions): Promise<Attachment>;
  run(
    message: import("@/types/resources.ts").MessagePayload,
    options?: RunOptions,
  ): Promise<RunHandle>;
  maintenance(): Promise<{
    recovered: number;
    compacted: { events: number; deliveries: number };
  }>;
  readonly events: {
    list(options: {
      namespace?: string;
      threadId?: string;
      correlationId?: string;
      afterPosition?: string;
      limit?: number;
    }): Promise<readonly DurableEvent[]>;
  };
  readonly deliveries: {
    get(
      id: string,
      options?: { namespace?: string },
    ): Promise<EventDelivery | null>;
    list(options?: {
      namespace?: string;
      eventId?: string;
      correlationId?: string;
      status?: EventDelivery["status"];
      limit?: number;
    }): Promise<readonly EventDelivery[]>;
    retry(id: string, options?: { namespace?: string }): Promise<boolean>;
    discard(id: string, options?: { namespace?: string }): Promise<boolean>;
  };
  readonly schema: {
    provision(name: string): Promise<void>;
    exists(name: string): Promise<boolean>;
    list(): Promise<readonly string[]>;
  };
  shutdown(): Promise<void>;
}

function normalizeAgent(value: Agent | NewAgent): Agent {
  const id = value.id ?? value.name;
  return { ...value, id, name: value.name, role: value.role } as Agent;
}

function normalizeTool(value: Tool | NewTool): Tool {
  return {
    ...value,
    id: value.id ?? value.key,
    key: value.key,
    name: value.name,
    description: value.description,
  } as Tool;
}

function explicitResources(config: CopilotzConfig): PluginResources {
  return {
    agents: config.agents?.map(normalizeAgent),
    tools: config.tools?.map(normalizeTool),
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

async function resolvePluginResolver(
  config: CopilotzConfig,
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

export async function createCopilotz(
  config: CopilotzConfig = {},
): Promise<Copilotz> {
  const servicesRef: CoreServicesRef = {};
  const corePlugin: CopilotzPlugin = createCorePlugin(servicesRef);
  const registry = await PluginRegistry.compose({
    core: corePlugin,
    plugins: config.plugins,
    resources: explicitResources(config),
    resolver: await resolvePluginResolver(config),
  });

  const privateHost = config.oxian?.dispatcher
    ? undefined
    : createPrivateExecutionHost(config.database ?? {});
  const dispatcher = config.oxian?.dispatcher ?? privateHost!.host;
  const databaseTransport = config.database?.oxian ??
    (privateHost ? privateHost.databaseTransport : {
      dispatcher,
      target: config.oxian?.databaseTarget ?? config.oxian?.target,
    });
  let database: CopilotzDatabase | undefined;
  try {
    database = await createDatabase({
      ...(config.database ?? {}),
      oxian: databaseTransport,
    });
  } catch (error) {
    await privateHost?.close("database_initialization_failed");
    throw error;
  }

  const eventStore = new EventStore(database.session, database.schema);
  const bus = new EventBus();
  const outputs = new OutputHub(bus);
  const settlement = new SettlementMonitor(eventStore);
  const deliveryCoordinator = new DeliveryCoordinator({
    dispatcher,
    store: eventStore,
    bus,
    settlement,
    target: config.oxian?.target,
  });

  const committed = async (result: CommitMutationResult<unknown>) => {
    bus.publish(result.event);
    settlement.wake();
    if (result.deliveries.length) {
      await deliveryCoordinator.acceptAll(result.deliveries).catch(() => {
        // The rows are durable; the recovery scheduler retries dispatch.
        deliveryCoordinator.notifyCommitted();
      });
    }
  };

  const collections = createEventCollectionsManager(
    eventStore,
    registry.list("collections"),
    {
      validateOnWrite: config.validateCollections ?? true,
      resolveConsumers: (event) =>
        registry.matchDurable(event).map((processor) => processor.id),
      committed,
    },
  );
  const domain = new DomainStore(eventStore, {
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
    defaultNamespace: config.namespace,
  });
  const deliveryExecutor = new DeliveryExecutor({
    store: eventStore,
    registry,
    collections,
    bus,
    settlement,
  });
  const streamExecutor = new StreamExecutor({
    store: eventStore,
    domain,
    registry,
    committed,
  });
  const attachedWorker = privateHost?.attach(createCopilotzWorkloads({
    delivery: deliveryExecutor,
    stream: streamExecutor,
    bus,
  }));
  void attachedWorker;

  const streamCoordinator = new StreamCoordinator({
    dispatcher,
    events: bus,
    outputs,
    target: config.oxian?.target,
    durableCommitted: () => deliveryCoordinator.notifyCommitted(),
  });

  servicesRef.current = {
    domain,
    events: eventStore,
    bus,
    registry,
    collections,
    assetStore,
    assets,
    toolExecutionTimeoutMs: config.toolExecutionTimeoutMs ?? 300_000,
    toolExecutionTimeoutsMs: config.toolExecutionTimeoutsMs,
  };

  const attachments = new AttachmentManager({
    domain,
    events: eventStore,
    registry,
    deliveries: deliveryCoordinator,
    streams: streamCoordinator,
    settlement,
    outputs,
    schema: database.schema,
    defaultNamespace: config.namespace,
    committed,
  });

  const maintenance = async () => {
    const recovered = await deliveryCoordinator.recover(
      config.maintenance?.recoveryBatchSize ?? 100,
    );
    const compacted = await eventStore.compact({
      retentionMs: config.maintenance?.retentionMs,
    });
    return { recovered, compacted };
  };
  const deliveryInNamespace = async (
    id: string,
    namespace = config.namespace ?? "default",
  ): Promise<EventDelivery | null> => {
    const delivery = await eventStore.getDelivery(id);
    if (!delivery) return null;
    const event = await eventStore.getEvent(delivery.eventId);
    return event?.namespace === namespace ? delivery : null;
  };
  await deliveryCoordinator.recover(
    config.maintenance?.recoveryBatchSize ?? 100,
  ).catch(() => {
    deliveryCoordinator.notifyCommitted();
    return 0;
  });
  const intervalMs = Math.max(1_000, config.maintenance?.intervalMs ?? 30_000);
  const maintenanceTimer = config.maintenance?.periodic === false
    ? undefined
    : setInterval(() => void maintenance().catch(() => undefined), intervalMs);
  let closed = false;

  return {
    config: Object.freeze({ ...config }),
    plugins: registry,
    collections,
    assets,
    connect: (options) => attachments.connect(options),
    run: (message, options) => attachments.run(message, options),
    maintenance,
    events: {
      list: (options) =>
        eventStore.listEvents({
          ...options,
          namespace: options.namespace ?? config.namespace ?? "default",
        }),
    },
    deliveries: {
      get: (id, options) =>
        deliveryInNamespace(id, options?.namespace ?? config.namespace),
      list: (options = {}) =>
        eventStore.listDeliveries({
          ...options,
          namespace: options.namespace ?? config.namespace ?? "default",
        }),
      retry: async (id, options) => {
        if (
          !await deliveryInNamespace(
            id,
            options?.namespace ?? config.namespace,
          )
        ) return false;
        const retried = await eventStore.retryDeadLetter(id);
        if (retried) await deliveryCoordinator.recover(1);
        return retried;
      },
      discard: async (id, options) =>
        await deliveryInNamespace(id, options?.namespace ?? config.namespace)
          ? await eventStore.discardDeadLetter(id)
          : false,
    },
    schema: {
      provision: (name) => provisionSchema(database!, name),
      exists: (name) => schemaExists(database!, name),
      list: () => listSchemas(database!),
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      await streamCoordinator.close("copilotz_shutdown");
      await deliveryCoordinator.close("copilotz_shutdown");
      await liveProcessors.close("copilotz_shutdown");
      outputs.close();
      bus.close();
      await database!.close();
      await privateHost?.close("copilotz_shutdown");
    },
  };
}

type CommitMutationResult<T> =
  import("@/database/event-store.ts").CommitMutationResult<T>;
