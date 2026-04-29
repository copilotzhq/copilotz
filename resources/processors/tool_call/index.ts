import { generateAllApiTools } from "@/runtime/api/index.ts";
import { generateAllMcpTools } from "@/runtime/mcp/index.ts";
import { getUserExternalId } from "@/runtime/memory/identity.ts";

import type {
  Agent,
  ChatContext,
  CopilotzDb,
  Event,
  EventProcessor,
  NewEvent,
  ProcessorDeps,
  Tool,
  ToolResultEventPayload,
  ToolHistoryVisibility,
} from "@/types/index.ts";
import type { ExecutableTool } from "./types.ts";
import type { ToolInvocation } from "@/runtime/llm/types.ts";
import {
  DEFAULT_TOOL_HISTORY_VISIBILITY,
  projectToolResultForHistory,
} from "./history-policy.ts";

import Ajv from "npm:ajv@^8.17.1";
import addFormats from "npm:ajv-formats@^3.0.1";
import { resolveAssetIdForStore } from "@/runtime/storage/assets.ts";

export interface ToolCallPayload {
  agent: { id?: string; name: string }; // agent that requested the tool
  senderId: string;
  senderType: "user" | "agent" | "tool" | "system";
  toolCall: ToolInvocation;
}

export interface ToolResultPayload {
  agent: { id?: string; name: string }; // agent that requested the tool
  toolCallId: string;
  tool: { id: string; name?: string | null };
  args: unknown;
  status: "completed" | "failed" | "cancelled";
  output?: unknown;
  projectedOutput?: unknown;
  error?: unknown;
  // Optional convenience content (already formatted) for logs/messages
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

export interface ToolExecutionContext extends ChatContext {
  senderId?: string;
  senderType?: "user" | "agent" | "tool" | "system";
  threadId?: string;
  /** The external ID of the human user in this conversation. Resolved from thread metadata by the framework. */
  userExternalId?: string;
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
  // Collections is inherited from ChatContext, but we re-declare for clarity
  // collections?: CollectionsManager;
}

type ProcessedToolCallResult = {
  tool_call_id?: string;
  name: string;
  status?: "completed" | "failed" | "cancelled";
  output?: unknown;
  error?: unknown;
  historyVisibility?: ToolHistoryVisibility;
  projectedOutput?: unknown;
};

type ToolCancelReason = "timeout" | "abort" | string;

function createToolCancellation() {
  let cancelled = false;
  let reason: ToolCancelReason | undefined = undefined;
  const callbacks = new Set<() => void>();

  const onCancel = (cb: () => void): (() => void) => {
    if (cancelled) {
      try {
        cb();
      } catch { /* ignore */ }
      return () => {};
    }
    callbacks.add(cb);
    return () => callbacks.delete(cb);
  };

  const cancel = (r: ToolCancelReason): void => {
    if (cancelled) return;
    cancelled = true;
    reason = r;
    for (const cb of Array.from(callbacks)) {
      try {
        cb();
      } catch { /* ignore */ }
    }
    callbacks.clear();
  };

  return {
    get cancelled() {
      return cancelled;
    },
    get reason() {
      return reason;
    },
    onCancel,
    cancel,
  };
}

function resolveToolTimeoutMs(
  toolKey: string,
  context: ToolExecutionContext,
): number | undefined {
  const overrides = context.toolExecutionTimeoutsMs;
  if (
    overrides && typeof overrides === "object" &&
    Object.prototype.hasOwnProperty.call(overrides, toolKey)
  ) {
    return overrides[toolKey];
  }
  return context.toolExecutionTimeoutMs;
}

function assertToolCallPayload(
  payload: unknown,
): asserts payload is ToolCallPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid tool call payload");
  }
  const value = payload as Record<string, unknown>;
  const agentObj = value.agent as Record<string, unknown> | undefined;
  if (!agentObj || typeof agentObj.name !== "string") {
    throw new Error("Invalid tool call payload: agent.name");
  }
  if (typeof value.senderId !== "string") {
    throw new Error("Invalid tool call payload: senderId");
  }
  if (
    typeof value.senderType !== "string" ||
    !["user", "agent", "tool", "system"].includes(value.senderType)
  ) {
    throw new Error("Invalid tool call payload: senderType");
  }
  const call = value.toolCall as Record<string, unknown> | undefined;
  if (!call || typeof call !== "object") {
    throw new Error("Invalid tool call payload: toolCall");
  }
  const tool = call.tool as Record<string, unknown> | undefined;
  if (!tool || typeof tool !== "object") {
    throw new Error("Invalid tool call payload: toolCall.tool");
  }
  if (typeof tool.id !== "string") {
    throw new Error("Invalid tool call payload: toolCall.tool.id");
  }
  if (typeof call.args !== "string" && typeof call.args !== "object") {
    throw new Error("Invalid tool call payload: toolCall.args");
  }
}

const hasExecute = (tool: unknown): tool is ExecutableTool =>
  Boolean(
    tool &&
      typeof tool === "object" &&
      typeof (tool as { execute?: unknown }).execute === "function",
  );

export const toolCallProcessor: EventProcessor<ToolCallPayload, ProcessorDeps> =
  {
    shouldProcess: () => true,
    process: async (event: Event, deps: ProcessorDeps) => {
      const { db, thread, context } = deps;
      assertToolCallPayload(event.payload);
      const payload = event.payload;

      const threadId = typeof event.threadId === "string"
        ? event.threadId
        : undefined;
      if (!threadId) {
        throw new Error("Invalid thread id for tool call event");
      }

      const availableAgents = context.agents || [];
      const eventMetadata =
        event.metadata && typeof event.metadata === "object" &&
          !Array.isArray(event.metadata)
          ? event.metadata as Record<string, unknown>
          : null;
      const replyToParticipantId =
        typeof eventMetadata?.replyToParticipantId === "string"
          ? eventMetadata.replyToParticipantId
          : null;
      const replyToTargetQueue =
        Array.isArray(eventMetadata?.replyToTargetQueue)
          ? eventMetadata.replyToTargetQueue.filter((
            candidate,
          ): candidate is string => typeof candidate === "string")
          : [];
      // Agent may be absent if filtered out by env config — fall back to payload data
      const agent =
        availableAgents.find((a: Agent) =>
          (payload.agent.id && a.id === payload.agent.id) ||
          a.name === payload.agent.name
        ) ?? null;

      // Build tools
      const userTools = (context.tools || []).filter(hasExecute);
      const apiTools = context.apis
        ? generateAllApiTools(context.apis).filter(hasExecute)
        : [];
      const mcpTools = context.mcpServers
        ? (await generateAllMcpTools(context.mcpServers)).filter(hasExecute)
        : [];
      const allTools: ExecutableTool[] = [
        ...userTools,
        ...apiTools,
        ...mcpTools,
      ];

      // If agent not found, allow all tools; otherwise respect agent.allowedTools
      const allowedKeys = agent && Array.isArray(agent.allowedTools)
        ? agent.allowedTools
        : agent?.allowedTools === null
          ? []
          : allTools.map((t) => t.key);
      const agentTools =
        allowedKeys.map((key: string) => allTools.find((t) => t.key === key))
          .filter(hasExecute) || [];

      // Resolve the human user's external ID from normalized thread metadata
      const resolvedUserExternalId = getUserExternalId(thread?.metadata) ?? undefined;

      const results = await processToolCalls(
        [payload.toolCall],
        agentTools,
        {
          ...context,
          senderId:
            (agent ? (agent.id ?? agent.name) : payload.senderId) as string,
          senderType: "agent",
          threadId,
          userExternalId: resolvedUserExternalId,
          agents: availableAgents,
          tools: allTools,
          db,
          resolveAsset: async (ref: string) => {
            if (!context.assetStore) {
              throw new Error("Asset store is not configured");
            }
            const id = resolveAssetIdForStore(ref, context.assetStore);
            return await context.assetStore.get(id);
          },
        },
      );

      const result = results[0];
      const call = payload.toolCall;
      const callId = call.id || `${call.tool.id}_${Date.now()}`;

      // Emit a terminal tool result event; a dedicated tool_result processor
      // turns it into the persisted/history NEW_MESSAGE artifact.
      const output = result.output;
      const error = result.error;
      const finishedAt = new Date().toISOString();

      let content: string;
      if (error) {
        content = `tool error: ${
          String(error)
        }\n\nPlease review the error above and try again with the correct format.`;
      } else if (typeof output !== "undefined") {
        try {
          content = typeof output === "string"
            ? output
            : JSON.stringify(output);
        } catch {
          content = String(output);
        }
      } else {
        content = `No output returned`;
      }
      // Extract batch info from toolCall cleanly
      const batchId = call.batchId ?? null;
      const batchSize = call.batchSize ?? null;
      const batchIndex = call.batchIndex ?? null;

      const toolResultPayload: ToolResultEventPayload = {
        agent: { id: payload.agent.id, name: payload.agent.name },
        toolCallId: callId,
        tool: { id: call.tool.id, name: call.tool.name },
        args: call.args,
        status: result.status ??
          (error ? "failed" : "completed"),
        ...(typeof output !== "undefined" ? { output } : {}),
        ...(typeof result.projectedOutput !== "undefined"
          ? { projectedOutput: result.projectedOutput }
          : {}),
        ...(typeof error !== "undefined" ? { error } : {}),
        content,
        historyVisibility: result.historyVisibility ??
          DEFAULT_TOOL_HISTORY_VISIBILITY,
        batchId,
        batchSize,
        batchIndex,
        finishedAt,
      };

      const producedEvents: NewEvent[] = [
        {
          threadId,
          type: "TOOL_RESULT",
          payload: toolResultPayload,
          parentEventId: typeof event.id === "string" ? event.id : undefined,
          traceId: typeof event.traceId === "string"
            ? event.traceId
            : undefined,
          priority: typeof event.priority === "number"
            ? event.priority
            : undefined,
          metadata: replyToParticipantId || replyToTargetQueue.length > 0
            ? {
              replyToParticipantId,
              replyToTargetQueue,
            }
            : undefined,
        },
      ];

      return { producedEvents };
    },
  };

/**
 * Calculate Levenshtein distance between two strings (for typo detection)
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix = Array(str2.length + 1).fill(null).map(() =>
    Array(str1.length + 1).fill(null)
  );

  for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1, // insertion
        matrix[j - 1][i] + 1, // deletion
        matrix[j - 1][i - 1] + indicator, // substitution
      );
    }
  }

  return matrix[str2.length][str1.length];
}

export const processToolCalls = async (
  toolCalls: ToolInvocation[],
  agentTools: ExecutableTool[] = [],
  context: ToolExecutionContext = {},
): Promise<ProcessedToolCallResult[]> => {
  const availableTools = agentTools.map((t) => t.key).join(", ");

  const results = await Promise.all(
    toolCalls.map(async (toolCall) => {
      // Handle malformed tool calls gracefully
      let name: string;
      let argsString: string;

      try {
        // Check if tool call has proper structure
        if (!toolCall.tool || !toolCall.tool.id) {
          // Check if it looks like the agent tried to call a tool directly
          const potentialToolName = Object.keys(toolCall).find((key) =>
            agentTools.some((tool) => tool.key === key)
          );

          let suggestion = "";
          if (potentialToolName) {
            suggestion =
              `\n\nDid you mean to call "${potentialToolName}"? Use this format:\n<function_calls>\n<invoke name="${potentialToolName}">\n${
                JSON.stringify(toolCall)
              }\n</invoke>\n</function_calls>`;
          } else {
            suggestion =
              `\n\nCorrect format example:\n<function_calls>\n<invoke name="create_thread">\n{"name": "My Thread", "participants": ["Agent1"]}\n</invoke>\n</function_calls>`;
          }

          return {
            tool_call_id: toolCall.id || "unknown",
            name: "unknown",
            historyVisibility: DEFAULT_TOOL_HISTORY_VISIBILITY,
            error:
              `MALFORMED TOOL CALL: Expected tool key. Available tools: [${availableTools}].${suggestion}`,
          };
        }

        name = toolCall.tool.id;
        const rawArgs = toolCall.args;
        argsString = typeof rawArgs === "string"
          ? rawArgs
          : JSON.stringify(rawArgs || {});

        // Validate name exists
        if (!name) {
          return {
            tool_call_id: toolCall.id || "unknown",
            name: "unknown",
            historyVisibility: DEFAULT_TOOL_HISTORY_VISIBILITY,
            error:
              `MISSING TOOL NAME: You must specify a tool name. Available tools: [${availableTools}]. Your call was: ${
                JSON.stringify(toolCall)
              }`,
          };
        }
      } catch (error) {
        return {
          tool_call_id: toolCall.id || "unknown",
          name: "unknown",
          historyVisibility: DEFAULT_TOOL_HISTORY_VISIBILITY,
          error: `INVALID TOOL CALL STRUCTURE: ${
            error instanceof Error ? error.message : String(error)
          }. Available tools: [${availableTools}]`,
        };
      }

      // Find the tool
      const tool = agentTools.find((t) => t.key === name);

      if (!tool) {
        // Find similar tool names (typo detection)
        const similarTools = agentTools.filter((t) =>
          t.key.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(t.key.toLowerCase()) ||
          levenshteinDistance(t.key.toLowerCase(), name.toLowerCase()) <= 2
        );

        let suggestion = "";
        if (similarTools.length > 0) {
          suggestion = `\n\nDid you mean: ${
            similarTools.map((t) => `"${t.key}"`).join(", ")
          }?`;
        } else {
          suggestion =
            `\n\nExample usage:\n<tool_calls>\n{"function": {"name": "${
              agentTools[0]?.key || "tool_name"
            }", "arguments": {...}}}\n</tool_calls>`;
        }

        return {
          tool_call_id: toolCall.id,
          name,
          historyVisibility: DEFAULT_TOOL_HISTORY_VISIBILITY,
          error:
            `TOOL NOT FOUND: "${name}" is not available. Available tools: [${availableTools}].${suggestion}`,
        };
      }

      // Parse arguments
      let args;
      try {
        args = JSON.parse(argsString);
      } catch (e) {
        return {
          tool_call_id: toolCall.id,
          name,
          historyVisibility: tool.historyPolicy?.visibility ??
            DEFAULT_TOOL_HISTORY_VISIBILITY,
          error:
            `INVALID JSON ARGUMENTS: The arguments must be valid JSON. Your arguments: ${argsString}. Error: ${
              e instanceof Error ? e.message : String(e)
            }`,
        };
      }

      // Validate tool call structure
      const validation = validateToolCall({ name, arguments: args }, tool);
      if (!validation.valid) {
        return {
          tool_call_id: toolCall.id,
          name,
          historyVisibility: tool.historyPolicy?.visibility ??
            DEFAULT_TOOL_HISTORY_VISIBILITY,
          error:
            `VALIDATION ERROR: ${validation.error}. Please check the tool's required parameters and try again.`,
        };
      }

      // Execute the tool
      const cancellation = createToolCancellation();
      const timeoutMs = resolveToolTimeoutMs(name, context);

      const toolContext: ToolExecutionContext = {
        ...context,
        onCancel: cancellation.onCancel,
        cancelled: false,
        cancelReason: undefined,
      };

      const cancelWithContext = (reason: ToolCancelReason) => {
        toolContext.cancelled = true;
        toolContext.cancelReason = reason;
        cancellation.cancel(reason);
      };

      let timer: number | undefined = undefined;
      if (
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) &&
        timeoutMs > 0
      ) {
        timer = setTimeout(() => cancelWithContext("timeout"), timeoutMs) as unknown as number;
      }

      const cancelPromise = new Promise<never>((_, reject) => {
        toolContext.onCancel?.(() => {
          const r = toolContext.cancelReason ?? "cancelled";
          reject(new Error(`Tool execution cancelled (${r})`));
        });
      });

      try {
        const execPromise = Promise.resolve().then(() =>
          tool.execute(args, toolContext)
        );
        const output = await Promise.race([execPromise, cancelPromise]);

        const { visibility, projectedOutput } = await projectToolResultForHistory(
          tool,
          args,
          output,
          undefined,
        );

        return {
          tool_call_id: toolCall.id,
          name,
          status: "completed",
          output,
          historyVisibility: visibility,
          ...(typeof projectedOutput !== "undefined"
            ? { projectedOutput }
            : {}),
        } satisfies ProcessedToolCallResult;
      } catch (error) {
        const isTimeout = Boolean(
          cancellation.cancelled && cancellation.reason === "timeout",
        );
        const errorMessage = isTimeout
          ? `EXECUTION CANCELLED: Tool execution timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s`
          : `EXECUTION ERROR: ${
            error instanceof Error ? error.message : String(error)
          }`;

        const { visibility, projectedOutput } = await projectToolResultForHistory(
          tool,
          args,
          undefined,
          errorMessage,
        );

        return {
          tool_call_id: toolCall.id,
          name,
          status: isTimeout ? "cancelled" : "failed",
          error: errorMessage,
          historyVisibility: visibility,
          ...(typeof projectedOutput !== "undefined"
            ? { projectedOutput }
            : {}),
        } satisfies ProcessedToolCallResult;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );

  return results;
};

// Create Ajv instance - using type assertions due to npm module import compatibility
const createAjv = () => {
  // deno-lint-ignore no-explicit-any
  const instance = new (Ajv as any)({
    strict: false,
    allErrors: true,
  });
  // deno-lint-ignore no-explicit-any
  (addFormats as any)(instance);

  // Register x-ui as a known no-op keyword to support frontend rendering hints
  instance.addKeyword("x-ui");

  return instance;
};
const ajv = createAjv();

interface ValidationResult {
  valid: boolean;
  error?: string;
}

interface ToolCallValidation {
  name: string;
  arguments: unknown;
}

export const validateToolCall = (
  toolCall: ToolCallValidation,
  tool: Tool,
): ValidationResult => {
  // If no input schema is defined, any input is valid
  if (!tool.inputSchema) {
    return { valid: true };
  }

  // Handle undefined or null arguments
  const args = toolCall.arguments || {};

  const schemaProperties = tool.inputSchema.properties &&
      typeof tool.inputSchema.properties === "object"
    ? tool.inputSchema.properties as Record<string, unknown>
    : undefined;
  const requiredFields = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required
    : undefined;

  // If the schema has no properties and no required fields, accept empty arguments
  if (
    tool.inputSchema.type === "object" &&
    (!schemaProperties || Object.keys(schemaProperties).length === 0) &&
    (!requiredFields || requiredFields.length === 0)
  ) {
    return { valid: true };
  }

  try {
    const validate = ajv.compile(tool.inputSchema);
    const valid = validate(args);

    if (!valid) {
      const errorMessage = ajv.errorsText(validate.errors);
      return { valid: false, error: errorMessage };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Schema validation error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
};

export const { shouldProcess, process } = toolCallProcessor;
