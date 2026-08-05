/**
 * Copilotz event-native, stream-capable public API.
 *
 * The package root intentionally exposes no queue controls, raw graph writes,
 * or database client. Applications mutate graph state through collections and
 * communicate through `run()` or persistent thread attachments.
 */

export {
  type Copilotz,
  type CopilotzConfig,
  createCopilotz,
  type MaintenanceConfig,
  type OxianConfig,
} from "./engine.ts";
export { createCopilotz as default } from "./engine.ts";

export type * from "./events/types.ts";
export type * from "./attachments/types.ts";
export {
  isAttachmentStreamOutput,
  isDiscreteEventInput,
  isStreamInput,
} from "./attachments/types.ts";
export type * from "./types/resources.ts";
export type * from "./plugins/types.ts";
export type * from "./processors/types.ts";
export * from "./assets/index.ts";

export { definePlugin } from "./plugins/types.ts";
export { PluginRegistry } from "./plugins/registry.ts";
export { defineProcessor } from "./processors/types.ts";
export {
  defineCollection,
  index,
  relation,
} from "./database/collections/index.ts";
export type * from "./database/collections/types.ts";
export { schema, V2_SCHEMA_VERSION } from "./database/v2-schema.ts";
export type { DatabaseConfig } from "./database/database.ts";

export { chat } from "./runtime/llm/orchestrator.ts";
export type * from "./runtime/llm/types.ts";
export {
  COPILOTZ_DELIVERY_WORKLOAD,
  COPILOTZ_STREAM_WORKLOAD,
} from "./execution/protocol.ts";
export { createCopilotzWorkloads } from "./execution/workloads.ts";
