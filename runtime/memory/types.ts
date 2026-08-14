import type { Agent } from "../resources/index.ts";
import type {
  ConversationThread,
  LlmAttempt,
  Participant,
} from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import type { CopilotzEvent } from "../events/index.ts";
import type { ChatMessage, ProviderConfig } from "../llm/types.ts";
import type { LlmChat } from "../workflows/index.ts";
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

export type CreateLongTermMemoryPluginOptions = Readonly<{
  id?: string;
  version?: string;
  enabled?: boolean;
  config?: Partial<LongTermMemoryConfig>;
  chat?: LlmChat;
  env?: Readonly<Record<string, string>>;
  resolveLlmConfig?: ResolveMemoryLlmConfig;
  embed?: MemoryEmbed;
  /** Number of internal contract-repair attempts after the initial call. */
  maxRepairAttempts?: number;
}>;
