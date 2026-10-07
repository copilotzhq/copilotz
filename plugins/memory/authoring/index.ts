/** Public memory notes, range selection and configuration contracts. @module */
export {
  buildMemoryConsolidationInstruction,
  memorySourceHandle,
  selectLongTermMemoryRange as selectEventLongTermMemoryRange,
} from "./consolidation/index.ts";
export type {
  MemorySourceMessage,
  MemorySpaceDescriptor,
  SelectedMemoryRange,
} from "./consolidation/index.ts";
export {
  MemoryProposalConflict,
  memoryProposalSchema,
  prepareMemoryProposal,
  renderMemoryNotes,
} from "./notes/index.ts";
export type { MemoryNote, MemoryProposal } from "./notes/index.ts";
export type {
  MemoryAdapters,
  MemoryEmbed,
  MemoryEmbeddingInput,
  MemoryResources,
  MemoryRuntimeContext,
} from "./contracts/index.ts";
