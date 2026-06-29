export {
  contextGenerator,
  type LLMContextData,
} from "@/resources/processors/new_message/generators/context-generator.ts";
export {
  historyGenerator,
  type HistoryGeneratorOptions,
} from "@/resources/processors/new_message/generators/history-generator.ts";
export {
  generateRagContext,
  type RagContextOptions,
  type RagContextResult,
} from "@/resources/processors/new_message/generators/rag-context-generator.ts";
export {
  getUserExternalId,
  resolveParticipantCollection,
  setUserExternalId,
} from "./identity.ts";
export {
  getEnabledMemoryResources,
  getLongTermMemoryConfig,
  hasMemoryResource,
  isHistoryMemoryEnabled,
  isParticipantMemoryEnabled,
  isRetrievalMemoryEnabled,
  type LongTermMemoryConfig,
} from "./resources.ts";
export {
  findMemorySpace,
  getLatestReadyLongTermMemory,
  getLongTermMemoryData,
  getNextLongTermMemorySequence,
  getPendingLongTermMemory,
  limitHotHistoryByCharacters,
  loadMessagesInLongTermMemoryRange,
  type LongTermMemoryData,
  type LongTermMemoryRange,
  type LongTermMemoryRecord,
  type LongTermMemoryStatus,
  projectMessageForSharedMemory,
  selectLongTermMemoryRange,
  sliceMessagesAfterLongTermMemory,
} from "./long-term.ts";
