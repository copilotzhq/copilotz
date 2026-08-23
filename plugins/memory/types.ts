import type { RuntimeContextNamespaces } from "@copilotz/copilotz/actions";
import type {
  ConversationThread,
  Participant,
} from "@copilotz/copilotz/domain";
import type { CopilotzEvent } from "@copilotz/copilotz/events";
import type {
  AgentTextActionInput,
  ChatMessage,
  LlmResource,
  ProviderConfig,
} from "@copilotz/copilotz/llm";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type { Agent } from "@copilotz/copilotz/resources";
import type { MemoryKindDefinition } from "./ontology.ts";
import type { LongTermMemoryConfig } from "./resources.ts";

export type MemoryResources =
  & RuntimeContextNamespaces
  & Readonly<{
    agents: Readonly<Record<string, Agent | undefined>>;
    memoryKinds: Readonly<
      Record<string, MemoryKindDefinition | undefined>
    >;
  }>;

export type MemoryAdapters =
  & RuntimeContextNamespaces
  & Readonly<{
    llm: Readonly<Record<string, LlmResource | undefined>>;
    memoryEmbedding: Readonly<Record<string, MemoryEmbed | undefined>>;
  }>;

/** Composed context shape required by Memory-owned behavior. */
export type MemoryRuntimeContext = ProcessorContext<
  MemoryResources,
  MemoryAdapters
>;

export type MemoryEmbeddingInput = Readonly<{
  agent: Agent;
  thread: ConversationThread;
  checkpointId: string;
  context: MemoryRuntimeContext;
}>;

export type MemoryEmbed = (
  texts: readonly string[],
  input: MemoryEmbeddingInput,
) => Promise<readonly (readonly number[])[]>;

export type ResolveMemoryLlmConfig = (
  input: Readonly<{
    agent: Agent;
    participant: Participant;
    operation: AgentTextActionInput;
    thread: ConversationThread;
    messages: readonly ChatMessage[];
    sourceEvent: CopilotzEvent;
    context: MemoryRuntimeContext;
    baseConfig: ProviderConfig;
  }>,
) => ProviderConfig | Promise<ProviderConfig>;

export type CreateLongTermMemoryPluginOptions = Readonly<{
  id?: string;
  version?: string;
  enabled?: boolean;
  config?: Partial<LongTermMemoryConfig>;
  env?: Readonly<Record<string, string>>;
  resolveLlmConfig?: ResolveMemoryLlmConfig;
  embed?: MemoryEmbed;
  /** Number of internal contract-repair attempts after the initial call. */
  maxRepairAttempts?: number;
}>;
