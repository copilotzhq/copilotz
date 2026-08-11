export {
  DEFAULT_LONG_TERM_MEMORY_CONFIG,
  type LongTermMemoryConfig,
} from "./resources.ts";
export {
  brainNodeCollection,
  longTermMemoryCollection,
  memorySpaceAccessCollection,
  memorySpaceCollection,
} from "./collections.ts";
export {
  applyContinuityPatch,
  buildContinuityRetrievalTexts,
  buildMemoryConsolidationInstruction,
  createEmptyContinuity,
  createWorkingMemoryNodeDrafts,
  extractVisibleBrainNodeIds,
  MEMORY_RELATION_TYPES,
  parseMemoryConsolidationProposal,
  readContinuity,
  renderLongTermMemory,
  selectLongTermMemoryRange as selectEventLongTermMemoryRange,
  stableMemoryNodeId,
} from "./consolidation.ts";
export type {
  LongTermMemoryContinuity,
  LongTermMemoryContinuityPatch,
  MemoryBrainNode,
  MemoryBrainRelation,
  MemoryConsolidationNode,
  MemoryConsolidationProposal,
  MemoryConsolidationRelation,
  MemoryRelationType,
  MemorySourceMessage,
  MemorySpaceDescriptor,
  RetrievedMemoryBrainNode,
  SelectedMemoryRange,
  SourcedContinuityValue,
  WorkingMemoryNodeDraft,
} from "./consolidation.ts";
export { createLongTermMemoryPlugin } from "./plugin.ts";
export type {
  CreateLongTermMemoryPluginOptions,
  LongTermMemoryResource,
  MemoryConsolidator,
  MemoryConsolidatorInput,
  MemoryConsolidatorResult,
  MemoryEmbed,
  MemoryEmbeddingInput,
  ResolveMemoryLlmConfig,
} from "./types.ts";
