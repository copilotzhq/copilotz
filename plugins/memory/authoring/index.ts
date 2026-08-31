/** Public authoring declarations for semantic-memory integrations. @module */

export {
  buildMemoryConsolidationInstruction,
  isEditoriallyVisible,
  parseConsolidateMemoryInput,
  proposalDrafts,
  renderLongTermMemory,
  selectLongTermMemoryRange as selectEventLongTermMemoryRange,
  stableMemoryRecordId,
} from "./consolidation/index.ts";
export type {
  MemoryRecordProjection,
  MemoryRecordRelation,
  MemorySourceMessage,
  MemorySpaceDescriptor,
  RetrievedMemoryRecord,
  SelectedMemoryRange,
} from "./consolidation/index.ts";
export {
  CORE_MEMORY_KINDS,
  defaultMemoryLifecycle,
  defineMemoryKind,
  MEMORY_FORMS,
  MEMORY_LIFECYCLES,
  MEMORY_RELATION_TYPES,
  memoryLifecycleAllows,
  memorySourceKey,
} from "./ontology/index.ts";
export type {
  AssertionMemoryDraft,
  ConsolidateMemoryInput,
  EntityMemoryDraft,
  InquiryMemoryDraft,
  IntentMemoryDraft,
  MemoryDraftBase,
  MemoryEpistemic,
  MemoryForm,
  MemoryKindDefinition,
  MemoryLifecycleDraft,
  MemoryLifecycleStatus,
  MemoryNodeRef,
  MemoryProvenance,
  MemoryRecord,
  MemoryRelationDraft,
  MemoryRelationType,
  MemoryTemporal,
  OccurrenceMemoryDraft,
  ProcedureMemoryDraft,
  ProposedMemoryRef,
} from "./ontology/index.ts";
export type {
  CreateLongTermMemoryPluginOptions,
  MemoryAdapters,
  MemoryEmbed,
  MemoryEmbeddingInput,
  MemoryResources,
  MemoryRuntimeContext,
} from "./contracts/index.ts";
