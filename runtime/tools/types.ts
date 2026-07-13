import type {
  Agent,
  ChatContext,
  CopilotzDb,
  Tool,
  ToolHistoryVisibility,
} from "@/types/index.ts";
import type { ToolInvocation } from "@/runtime/llm/types.ts";

export type ToolExecutor = (
  args: unknown,
  context?: unknown,
) => Promise<unknown> | unknown;

export type ExecutableTool = Tool & {
  execute: ToolExecutor;
};

export interface ToolCallPayload {
  agent: { id?: string; name: string };
  senderId: string;
  senderType: "user" | "agent" | "tool" | "system" | "job";
  toolCall: ToolInvocation;
}

export interface ToolResultPayload {
  agent: { id?: string; name: string };
  toolCallId: string;
  tool: { id: string; name?: string | null };
  args: unknown;
  status: "completed" | "failed" | "cancelled";
  output?: unknown;
  error?: unknown;
  content?: string | null;
  historyVisibility?: ToolHistoryVisibility;
  batchId?: string | null;
  batchSize?: number | null;
  batchIndex?: number | null;
  startedAt?: string;
  finishedAt: string;
  durationMs?: number | null;
  resultMessageId?: string | null;
}

/** Context passed to native and user-defined tool execution handlers. */
export interface ToolExecutionContext extends ChatContext {
  /** Stable ID assigned to this individual tool invocation. */
  toolCallId?: string;
  /** Trace containing the tool invocation, when available. */
  traceId?: string;
  senderId?: string;
  senderType?: "user" | "agent" | "tool" | "system" | "job";
  threadId?: string;
  /** The external ID of the human user in this conversation. Resolved from thread metadata by the framework. */
  userExternalId?: string;
  /** Agent currently executing the tool, when available. */
  agent?: Agent | null;
  agents?: Agent[];
  db?: CopilotzDb;
  embeddingConfig?: {
    provider: "openai" | "ollama" | "cohere";
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  /**
   * Register a callback that will be invoked if the framework cancels
   * the current tool execution (e.g. due to timeout).
   *
   * @returns unsubscribe function
   */
  onCancel?: (cb: () => void) => () => void;
  /** Whether the current tool execution has been cancelled. */
  cancelled?: boolean;
  /** Optional cancellation reason (e.g. "timeout"). */
  cancelReason?: string;
}
