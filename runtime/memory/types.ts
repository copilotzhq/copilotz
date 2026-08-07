import type { Agent } from "../resources/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  LlmAttempt,
  Participant,
} from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import type { CopilotzEvent } from "../events/index.ts";
import type {
  ChatMessage,
  ChatResponse,
  ProviderConfig,
} from "../llm/types.ts";
import type { LlmChat } from "../workflows/index.ts";
import type {
  MemoryConsolidationProposal,
  MemorySourceMessage,
  MemorySpaceDescriptor,
} from "./consolidation.ts";
import type { LongTermMemoryConfig } from "./resources.ts";

export type MemoryEmbeddingInput = Readonly<{
  agent: Agent;
  thread: ConversationThread;
  checkpointId: string;
  context: CopilotzProcessorContext;
}>;

export type MemoryEmbed = (
  texts: readonly string[],
  input: MemoryEmbeddingInput,
) => Promise<readonly (readonly number[])[]>;

export type ResolveMemoryLlmConfig = (
  input: Readonly<{
    agent: Agent;
    participant: Participant;
    attempt: LlmAttempt;
    thread: ConversationThread;
    messages: readonly ChatMessage[];
    sourceEvent: CopilotzEvent;
    context: CopilotzProcessorContext;
    baseConfig: ProviderConfig;
  }>,
) => ProviderConfig | Promise<ProviderConfig>;

export type MemoryConsolidatorInput = Readonly<{
  agent: Agent;
  participant: Participant;
  attempt: LlmAttempt;
  thread: ConversationThread;
  messages: readonly ChatMessage[];
  sourceMessages: readonly MemorySourceMessage[];
  spaces: readonly MemorySpaceDescriptor[];
  olderNodeIds: ReadonlySet<string>;
  previousContent?: string;
  sourceEvent: CopilotzEvent;
  context: CopilotzProcessorContext;
}>;

export type MemoryConsolidatorResult = Readonly<{
  proposal: MemoryConsolidationProposal;
  response?: ChatResponse;
}>;

export type MemoryConsolidator = (
  input: MemoryConsolidatorInput,
) => Promise<MemoryConsolidatorResult>;

export type CreateLongTermMemoryPluginOptions = Readonly<{
  id?: string;
  version?: string;
  enabled?: boolean;
  config?: Partial<LongTermMemoryConfig>;
  chat?: LlmChat;
  env?: Readonly<Record<string, string>>;
  resolveLlmConfig?: ResolveMemoryLlmConfig;
  consolidate?: MemoryConsolidator;
  embed?: MemoryEmbed;
}>;

export type LongTermMemoryResource = Readonly<{
  id: string;
  name: "long_term";
  kind: "long_term";
  enabled: boolean;
  config: LongTermMemoryConfig;
  contribute(
    input: Readonly<{
      agent: Agent;
      participant: Participant;
      thread: ConversationThread;
      history: readonly ConversationMessage[];
      sourceEvent: CopilotzEvent;
      context: CopilotzProcessorContext;
    }>,
  ): Promise<
    | Readonly<{
      resourceId: string;
      section?: string;
      historyAfterMessageId?: string;
    }>
    | null
  >;
}>;
