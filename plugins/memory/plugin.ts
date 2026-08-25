/**
 * Composes semantic-memory primitive leaves into one plugin.
 *
 * @module
 */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { llmPlugin } from "@copilotz/copilotz/llm";
import {
  CORE_MEMORY_KINDS,
  defineMemoryKind,
  type MemoryKindDefinition,
} from "./authoring/ontology/index.ts";
import type {
  CreateLongTermMemoryPluginOptions,
  MemoryEmbed,
} from "./authoring/contracts/index.ts";
import {
  modelSelection,
  nonNegativeInteger,
  normalizedConfig,
} from "./internal/implementation.ts";
import {
  CONSOLIDATE_MEMORY_ACTION_ID,
  createConsolidateMemoryAction,
  createInspectMemoryAction,
  createListKnowledgeSpacesAction,
  createMemoryMaintenanceAction,
  createSearchMemoryAction,
  createSetMemoryStatusAction,
  MAINTAIN_MEMORY_ACTION_ID,
} from "./actions/index.ts";
import {
  longTermMemoryCollection,
  memoryRecordCollection,
  memorySpaceAccessCollection,
  memorySpaceCollection,
} from "./collections/index.ts";
import {
  createMemoryReservationProcessor,
  createPrepareMemoryMaintenanceProcessor,
} from "./processors/index.ts";
import {
  createConsolidateMemoryTool,
  createInspectMemoryTool,
  createListKnowledgeSpacesTool,
  createMemoryContextResource,
  createSearchMemoryTool,
  createSetMemoryStatusTool,
} from "./resources/index.ts";

const DEFAULT_PLUGIN_ID = "@copilotz/core-long-term-memory";
const DEFAULT_PLUGIN_VERSION = "4.0.0";

export { CONSOLIDATE_MEMORY_ACTION_ID, MAINTAIN_MEMORY_ACTION_ID };

type LongTermMemoryCollections = Readonly<{
  memorySpace: typeof memorySpaceCollection;
  memorySpaceAccess: typeof memorySpaceAccessCollection;
  longTermMemory: typeof longTermMemoryCollection;
  memoryRecord: typeof memoryRecordCollection;
}>;

type LongTermMemoryActions = Readonly<{
  consolidate_memory: ReturnType<typeof createConsolidateMemoryAction>;
  maintainMemory: ReturnType<typeof createMemoryMaintenanceAction>;
  list_knowledge_spaces: ReturnType<
    typeof createListKnowledgeSpacesAction
  >;
  search_memory: ReturnType<typeof createSearchMemoryAction>;
  inspect_memory: ReturnType<typeof createInspectMemoryAction>;
  set_memory_status: ReturnType<typeof createSetMemoryStatusAction>;
}>;

type LongTermMemoryProcessors =
  | Readonly<Record<never, never>>
  | Readonly<{
    reserveMemory: ReturnType<typeof createMemoryReservationProcessor>;
    prepareMemoryMaintenance: ReturnType<
      typeof createPrepareMemoryMaintenanceProcessor
    >;
  }>;

type LongTermMemoryResources = Readonly<{
  promptContext: Readonly<
    Record<string, ReturnType<typeof createMemoryContextResource>>
  >;
  memoryKinds: Readonly<Record<string, MemoryKindDefinition>>;
  tools: Readonly<{
    consolidate_memory: ReturnType<typeof createConsolidateMemoryTool>;
    list_knowledge_spaces: ReturnType<
      typeof createListKnowledgeSpacesTool
    >;
    search_memory: ReturnType<typeof createSearchMemoryTool>;
    inspect_memory: ReturnType<typeof createInspectMemoryTool>;
    set_memory_status: ReturnType<typeof createSetMemoryStatusTool>;
  }>;
}>;

type LongTermMemoryAdapters = Readonly<{
  memoryEmbedding: Readonly<Record<string, MemoryEmbed | undefined>>;
}>;

export type LongTermMemoryPlugin = CopilotzPlugin<
  string,
  string,
  readonly [typeof llmPlugin],
  LongTermMemoryCollections,
  LongTermMemoryActions,
  LongTermMemoryProcessors,
  LongTermMemoryResources,
  LongTermMemoryAdapters
>;

export function createLongTermMemoryPlugin(
  options: CreateLongTermMemoryPluginOptions,
): LongTermMemoryPlugin {
  const enabled = options?.enabled !== false;
  const models = modelSelection(options?.models, "Memory LLM models");
  if (enabled && !models) {
    throw new TypeError(
      "Memory LLM models must be a non-empty array of aliases.",
    );
  }
  const config = normalizedConfig(options.config);
  const consolidateMemory = createConsolidateMemoryAction(config);
  const listMemorySpaces = createListKnowledgeSpacesAction();
  const searchMemory = createSearchMemoryAction();
  const inspectMemory = createInspectMemoryAction();
  const setMemoryStatus = createSetMemoryStatusAction();
  const consolidateTool = createConsolidateMemoryTool(consolidateMemory);
  const maintainMemory = createMemoryMaintenanceAction(
    models,
    consolidateTool,
    nonNegativeInteger(options.maxRepairAttempts, 1),
  );
  const context = createMemoryContextResource(enabled);
  const kinds = Object.freeze(CORE_MEMORY_KINDS.map(defineMemoryKind));
  return definePlugin({
    id: options.id ?? DEFAULT_PLUGIN_ID,
    version: options.version ?? DEFAULT_PLUGIN_VERSION,
    plugins: [llmPlugin] as const,
    collections: {
      memorySpace: memorySpaceCollection,
      memorySpaceAccess: memorySpaceAccessCollection,
      longTermMemory: longTermMemoryCollection,
      memoryRecord: memoryRecordCollection,
    },
    actions: {
      consolidate_memory: consolidateMemory,
      maintainMemory,
      list_knowledge_spaces: listMemorySpaces,
      search_memory: searchMemory,
      inspect_memory: inspectMemory,
      set_memory_status: setMemoryStatus,
    },
    processors: enabled
      ? {
        reserveMemory: createMemoryReservationProcessor(config),
        prepareMemoryMaintenance: createPrepareMemoryMaintenanceProcessor(),
      }
      : {},
    resources: {
      promptContext: { [context.id]: context },
      memoryKinds: Object.fromEntries(kinds.map((kind) => [kind.id, kind])),
      tools: {
        consolidate_memory: consolidateTool,
        list_knowledge_spaces: createListKnowledgeSpacesTool(listMemorySpaces),
        search_memory: createSearchMemoryTool(searchMemory),
        inspect_memory: createInspectMemoryTool(inspectMemory),
        set_memory_status: createSetMemoryStatusTool(setMemoryStatus),
      },
    },
    adapters: {
      memoryEmbedding: options.embed ? { default: options.embed } : {},
    },
  });
}
