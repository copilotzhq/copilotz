/**
 * Processor-facing engine types.
 *
 * Downstream applications define processors through
 * `@copilotz/copilotz/plugins` and are handed one of these contexts when a
 * durable delivery or live event reaches their handler. Engine assembly stays
 * internal to the runtime roles in `@copilotz/copilotz/application`, so this
 * surface is deliberately types only.
 */
export type {
  CopilotzCapabilityBase,
  CopilotzCapabilitySource,
  CopilotzLiveProcessorContext,
  CopilotzMutationIdentityFactory,
  CopilotzProcessorCapabilities,
  CopilotzProcessorContext,
  ScopedContent,
  ScopedConversation,
  ScopedEphemeralEventInput,
  ScopedEvents,
  ScopedEventWaitOptions,
  ScopedLlmAttempts,
  ScopedMutationOptions,
  ScopedPluginResources,
  ScopedRelations,
  ScopedToolExecutions,
} from "./types.ts";
