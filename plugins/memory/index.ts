/**
 * Public semantic-memory plugin API.
 *
 * @module
 */

export {
  DEFAULT_LONG_TERM_MEMORY_CONFIG,
  type LongTermMemoryConfig,
} from "./resources/config/index.ts";
export {
  longTermMemoryCollection,
  memoryRecordCollection,
  memorySpaceAccessCollection,
  memorySpaceCollection,
} from "./collections/index.ts";
export {
  buildMemoryConsolidationInstruction,
  parseConsolidateMemoryInput,
  proposalDrafts,
  renderLongTermMemory,
  selectLongTermMemoryRange as selectEventLongTermMemoryRange,
  stableMemoryRecordId,
} from "./authoring/consolidation/index.ts";
export type {
  MemoryRecordProjection,
  MemoryRecordRelation,
  MemorySourceMessage,
  MemorySpaceDescriptor,
  RetrievedMemoryRecord,
  SelectedMemoryRange,
} from "./authoring/consolidation/index.ts";
export {
  CORE_MEMORY_KINDS,
  defaultMemoryLifecycle,
  defineMemoryKind,
  MEMORY_FORMS,
  MEMORY_LIFECYCLES,
  MEMORY_RELATION_TYPES,
  memoryLifecycleAllows,
  memorySourceKey,
} from "./authoring/ontology/index.ts";
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
} from "./authoring/ontology/index.ts";
export {
  CONSOLIDATE_MEMORY_ACTION_ID,
  createLongTermMemoryPlugin,
} from "./plugin.ts";
export type { LongTermMemoryPlugin } from "./plugin.ts";
export type {
  ConsolidateMemoryActionInput,
  ConsolidateMemoryActionResult,
} from "./actions/consolidate-memory/index.ts";
export type {
  MemoryActionCallers,
  MemoryActionContext,
  MemoryProcessorContext,
} from "./internal/implementation.ts";
export type {
  CreateLongTermMemoryPluginOptions,
  MemoryAdapters,
  MemoryEmbed,
  MemoryEmbeddingInput,
  MemoryResources,
  MemoryRuntimeContext,
} from "./authoring/contracts/index.ts";
export * from "./authoring/index.ts";
