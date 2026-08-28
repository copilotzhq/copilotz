/**
 * Public configuration and runtime contracts for semantic memory.
 *
 * @module
 */

import type { RuntimeContextNamespaces } from "@copilotz/copilotz/actions";
import type { ConversationThread } from "@copilotz/copilotz/core";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type { AgentResource } from "@copilotz/copilotz/core";
import type { MemoryKindDefinition } from "../ontology/index.ts";
import type { LongTermMemoryConfig } from "../../resources/config/index.ts";

export type MemoryResources =
  & RuntimeContextNamespaces
  & Readonly<{
    agents: Readonly<Record<string, AgentResource | undefined>>;
    memoryKinds: Readonly<
      Record<string, MemoryKindDefinition | undefined>
    >;
  }>;

export type MemoryAdapters =
  & RuntimeContextNamespaces
  & Readonly<{
    memoryEmbedding: Readonly<Record<string, MemoryEmbed | undefined>>;
  }>;

/** Composed context shape required by Memory-owned behavior. */
export type MemoryRuntimeContext = ProcessorContext<
  MemoryResources,
  MemoryAdapters
>;

export type MemoryEmbeddingInput = Readonly<{
  agent: AgentResource;
  thread: ConversationThread;
  checkpointId: string;
  context: MemoryRuntimeContext;
}>;

export type MemoryEmbed = (
  texts: readonly string[],
  input: MemoryEmbeddingInput,
) => Promise<readonly (readonly number[])[]>;

type LongTermMemoryPluginOptionsBase = Readonly<{
  id?: string;
  version?: string;
  config?: Partial<LongTermMemoryConfig>;
  embed?: MemoryEmbed;
}>;

/** Memory uses the target Agent's ordinary model selection and tool lifecycle. */
export type CreateLongTermMemoryPluginOptions =
  & LongTermMemoryPluginOptionsBase
  & Readonly<{ enabled?: boolean }>;
