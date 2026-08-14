export {
  DEFAULT_LONG_TERM_MEMORY_CONFIG,
  type LongTermMemoryConfig,
} from "./resources.ts";
export {
  longTermMemoryCollection,
  memoryRecordCollection,
  memorySpaceAccessCollection,
  memorySpaceCollection,
} from "./collections.ts";
export {
  buildMemoryConsolidationInstruction,
  parseConsolidateMemoryInput,
  proposalDrafts,
  renderLongTermMemory,
  selectLongTermMemoryRange as selectEventLongTermMemoryRange,
  stableMemoryRecordId,
} from "./consolidation.ts";
export type {
  MemoryRecordProjection,
  MemoryRecordRelation,
  MemorySourceMessage,
  MemorySpaceDescriptor,
  RetrievedMemoryRecord,
  SelectedMemoryRange,
} from "./consolidation.ts";
export {
  CORE_MEMORY_KINDS,
  defaultMemoryLifecycle,
  defineMemoryKind,
  MEMORY_FORMS,
  MEMORY_LIFECYCLES,
  MEMORY_RELATION_TYPES,
  memoryLifecycleAllows,
  memorySourceKey,
} from "./ontology.ts";
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
  MemorySourceRef,
  MemoryTemporal,
  OccurrenceMemoryDraft,
  ProcedureMemoryDraft,
  ProposedMemoryRef,
} from "./ontology.ts";
export { createLongTermMemoryPlugin } from "./plugin.ts";
export type {
  CreateLongTermMemoryPluginOptions,
  MemoryEmbed,
  MemoryEmbeddingInput,
  ResolveMemoryLlmConfig,
} from "./types.ts";
