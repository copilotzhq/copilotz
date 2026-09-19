/** Public Collection authoring declarations without the runtime kernel. @module */

export { defineCollection, relation } from "./definition.ts";
export type {
  CollectionCommandDefinition,
  CollectionDefinition,
  CollectionDefinitionInput,
  CollectionHookContext,
  CollectionIndex,
  CollectionMutateContext,
  CollectionMutatePatch,
  CollectionNamedQuery,
  CollectionNamedQueryRead,
  CollectionNamedQuerySchema,
  CollectionRelation,
} from "./definition.ts";
export type {
  CollectionContentOptions,
  ResolvedCollectionContent,
  ResolvedCollectionContentEntry,
  ResolvedCollectionFields,
  ScopedCollectionReadOptions,
} from "./read-options.ts";
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
} from "./types.ts";
export type { CollectionOperations, CollectionRead } from "./operations.ts";
export type {
  CollectionPredicate,
  CollectionPredicateValue,
} from "./predicate.ts";
