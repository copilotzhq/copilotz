export {
  defineProcessor,
  isProcessor,
  processorConsumerId,
  processorIdFromConsumer,
  withProcessorEventData,
} from "./processor.ts";
export type {
  Processor,
  ProcessorContext,
  ProcessorEvent,
  ProcessorMatchClause,
  ProcessorSettlement,
} from "./processor.ts";
export {
  matchDataFromPayload,
  matchesPartial,
  matchProcessor,
} from "./match.ts";
export {
  resolveProcessorEvent,
  resolveProcessorEventData,
} from "./event-data.ts";
export { createTransientProcessorSet } from "./transient.ts";
export type { TransientProcessorSet } from "./transient.ts";
export { createPluginRegistry } from "./registry.ts";
export type {
  CreatePluginRegistryOptions,
  PluginComposition,
  PluginRegistry,
  RegistryComposition,
} from "./registry.ts";
export { definePlugin, isCopilotzPlugin } from "./types.ts";
export type {
  AnyCopilotzPlugin,
  AnyProcessor,
  CollectionMap,
  ComposePlugins,
  CompositionOfPlugin,
  CopilotzPlugin,
  DefinePluginInput,
  PluginAdapters,
  PluginNamespaceMap,
  PluginResources,
  PluginTypeComposition,
  ProcessorContextOf,
  ProcessorMap,
} from "./types.ts";
export { isNonRetryableError, markNonRetryable } from "../failure.ts";
export type { NonRetryableError } from "../failure.ts";
