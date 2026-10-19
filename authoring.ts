/** Shared primitive authoring surface. No application or persistence runtime. @module */
export { defineAction, isActionDefinition } from "./runtime/actions/define.ts";
export { secret } from "./runtime/actions/secret.ts";
export type { SecretActionSchema } from "./runtime/actions/secret.ts";
export {
  defineCollection,
  relation,
} from "./runtime/collections/definition.ts";
export { definePlugin, isCopilotzPlugin } from "./runtime/plugins/types.ts";
export { defineProcessor, isProcessor } from "./runtime/plugins/processor.ts";
export { contribution } from "./runtime/plugins/contribution.ts";
export { defineView, isViewDefinition } from "./runtime/views/definition.ts";
export type {
  ActionContentDeclaration,
  ActionContentEntry,
} from "./runtime/actions/content.ts";
export type {
  ActionAwaitingData,
  ActionCaller,
  ActionCallers,
  ActionCallOptions,
  ActionCompletedData,
  ActionContext,
  ActionContextOf,
  ActionDefinition,
  ActionEffect,
  ActionEffectBegin,
  ActionEffectEvidence,
  ActionEffectOptions,
  ActionEffectOutcome,
  ActionEffectState,
  ActionEventData,
  ActionFailedData,
  ActionInput,
  ActionInvocationMetadata,
  ActionInvokedData,
  ActionLifecycleAppender,
  ActionLifecycleAppendInput,
  ActionLifecycleEmitter,
  ActionLifecycleInput,
  ActionLifecycleLoader,
  ActionMap,
  ActionOutput,
  ActionPreparedCall,
  ActionPrepareFactory,
  ActionPrepareOptions,
  ActionProgressData,
  ActionReconcileResult,
  ActionSchema,
  ActionStatus,
  ActionTransactionContext,
  ActionTransactionOptions,
  AnyActionDefinition,
  BoundActionCaller,
  RuntimeActionCallerMap,
  RuntimeActionCallers,
  RuntimeCollections,
  RuntimeContent,
  RuntimeContext,
  RuntimeContextNamespace,
  RuntimeContextNamespaces,
  RuntimeIdentity,
  RuntimeOperations,
  RuntimeStreams,
  RuntimeTransactionCollections,
  SerializedActionError,
} from "./runtime/actions/types.ts";
export type * from "./runtime/actions/continuation.ts";
export type {
  CollectionCommandDefinition,
  CollectionDefinition,
  CollectionDefinitionInput,
  CollectionHookContext,
  CollectionIndex,
  CollectionMutateContext,
  CollectionMutatePatch,
  CollectionNamedQuery,
  CollectionNamedQuerySchema,
  CollectionRelation,
} from "./runtime/collections/definition.ts";
export type {
  CollectionAggregateGroup,
  CollectionAggregateMetric,
  CollectionAggregateQuery,
  CollectionAggregateRow,
  CollectionCreated,
  CollectionDeleted,
  CollectionDurableEvent,
  CollectionEventBody,
  CollectionEventOperation,
  CollectionFilter,
  CollectionGraphRelation,
  CollectionMutation,
  CollectionMutationIdentity,
  CollectionMutationIntent,
  CollectionMutationRef,
  CollectionNoop,
  CollectionQuery,
  CollectionQueryOrder,
  CollectionRecord,
  CollectionRelationQuery,
  CollectionUpdated,
  CollectionUpdatePatch,
  CollectionWrite,
  CollectionWriteOptions,
  GraphRelationEventBody,
  GraphRelationIntent,
  GraphRelationUpsertInput,
} from "./runtime/collections/types.ts";
export type {
  CollectionContentOptions,
  ResolvedCollectionContent,
  ResolvedCollectionContentEntry,
  ResolvedCollectionFields,
} from "./runtime/collections/read-options.ts";
export type {
  CollectionOperations,
  CollectionRead,
} from "./runtime/collections/operations.ts";
export type {
  CollectionPredicate,
  CollectionPredicateValue,
} from "./runtime/collections/predicate.ts";
export type {
  Processor,
  ProcessorContext,
  ProcessorEvent,
  ProcessorMatchClause,
  ProcessorSettlement,
} from "./runtime/plugins/processor.ts";
export type {
  AnyCopilotzPlugin,
  AnyProcessor,
  CollectionMap,
  ComposePlugins,
  CompositionOfPlugin,
  CopilotzPlugin,
  DefinedPlugin,
  DefinePluginInput,
  PluginAdapters,
  PluginNamespaceMap,
  PluginResources,
  PluginTypeComposition,
  ProcessorContextOf,
  ProcessorMap,
} from "./runtime/plugins/types.ts";
export type {
  CompositionContribution,
  ContributionPlugins,
  ContributionResult,
  ContributionViews,
  ResolvedNamespaces,
} from "./runtime/plugins/contribution.ts";
export type {
  AnyViewDefinition,
  ViewActions,
  ViewCollections,
  ViewContext,
  ViewDefinition,
  ViewHints,
  ViewMap,
  ViewRead,
  ViewReference,
  ViewShows,
} from "./runtime/views/definition.ts";
export type { CollectionNamedQueryRead } from "./runtime/collections/authoring.ts";

export { ActionError } from "./runtime/actions/errors.ts";
export { resolveActionSourceData } from "./runtime/actions/protected-context.ts";

export { scheduledJobDelegationDigest } from "./runtime/schedules/delegation.ts";
