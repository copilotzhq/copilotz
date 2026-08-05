import type { CollectionsManager } from "@/database/collections/types.ts";
import type { DomainStore } from "@/database/domain-store.ts";
import type { EventStore } from "@/database/event-store.ts";
import type { EventBus } from "@/execution/event-bus.ts";
import type { PluginRegistry } from "@/plugins/registry.ts";
import type { AssetStore } from "@/assets/index.ts";
import type { EventAssetService } from "@/assets/event-service.ts";

export interface CoreRuntimeServices {
  domain: DomainStore;
  events: EventStore;
  bus: EventBus;
  registry: PluginRegistry;
  collections: CollectionsManager;
  assetStore?: AssetStore;
  assets: EventAssetService;
  toolExecutionTimeoutMs?: number;
  toolExecutionTimeoutsMs?: Record<string, number | undefined>;
}

export interface CoreServicesRef {
  current?: CoreRuntimeServices;
}

export function requireCoreServices(ref: CoreServicesRef): CoreRuntimeServices {
  if (!ref.current) {
    throw new Error("Copilotz core services are not initialized.");
  }
  return ref.current;
}
