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
  ToolHistoryVisibility,
  ToolResultEventPayload,
} from "@/types/index.ts";
import type { ExecutableTool } from "./types.ts";
import type { ToolInvocation } from "@/runtime/llm/types.ts";
import {
  DEFAULT_TOOL_HISTORY_VISIBILITY,
  projectToolResultForHistory,
} from "./history-policy.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";
import {
  pickRunSenderFromMetadata,
  withRunSenderMetadata,
} from "@/runtime/usage/attribution.ts";
import { createUsageService } from "@/runtime/collections/native.ts";

import Ajv from "npm:ajv@^8.17.1";
import addFormats from "npm:ajv-formats@^3.0.1";
import { resolveAssetIdForStore } from "@/runtime/storage/assets.ts";

export interface ToolCallPayload {
  agent: { id?: string; name: string }; // agent that requested the tool
  senderId: string;
  senderType: "user" | "agent" | "tool" | "system" | "job";
  toolCall: ToolInvocation;
}

export interface ToolResultPayload {
  agent: { id?: string; name: string }; // agent that requested the tool
  toolCallId: string;
  tool: { id: string; name?: string | null };
  args: unknown;
  status: "completed" | "failed" | "cancelled";
  output?: unknown;
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

/** Context passed to native and user-defined tool execution handlers. */
export interface ToolExecutionContext extends ChatContext {
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
};

type ToolCancelReason = "timeout" | "abort" | string;

function createToolCancellation() {
  let cancelled = false;
  let reason: ToolCancelReason | undefined = undefined;
  const callbacks = new Set<() => void>();

  const onCancel = (cb: () => void): () => void => {
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
    !["user", "agent", "tool", "system", "job"].includes(value.senderType)
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
      const eventType = (event as unknown as { type?: string }).type;
      const isLifecycleToolExecutionCreated =
        eventType === "tool_execution.created";
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
      const sourceMessageId = typeof eventMetadata?.sourceMessageId === "string"
        ? eventMetadata.sourceMessageId
        : null;
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

      const call = payload.toolCall;
      const callId = call.id || `${call.tool.id}_${Date.now()}`;
      let toolExecutionId: string | null = isLifecycleToolExecutionCreated &&
          typeof (event as unknown as { subjectId?: unknown }).subjectId ===
            "string"
        ? (event as unknown as { subjectId: string }).subjectId
        : null;
      if (isLifecycleToolExecutionCreated) {
        deps.emitToStream({
          ...event,
          type: "TOOL_CALL",
          payload,
        } as Event);
      }
      if (!isLifecycleToolExecutionCreated && db?.ops?.mutate?.toolExecutions) {
        try {
          const execution = await db.ops.mutate.toolExecutions.create({
            threadId,
            messageId: sourceMessageId,
            eventId: typeof event.id === "string" ? event.id : null,
            agentId: payload.agent.id ?? payload.agent.name,
            agentName: payload.agent.name,
            toolCallId: callId,
            tool: { id: call.tool.id, name: call.tool.name },
            args: call.args,
            status: "processing",
            namespace: context.namespace,
          });
          toolExecutionId = String(execution.id);
        } catch (error) {
          console.warn(
            "[TOOL_CALL] Failed to create tool_execution node:",
            error,
          );
        }
      }

      // Resolve the human user's external ID from normalized thread metadata
      const resolvedUserExternalId = getUserExternalId(thread?.metadata) ??
        undefined;

      const toolStartedMs = Date.now();
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
          agent,
          agents: availableAgents,
          tools: allTools,
          db,
          onCancel: deps.cancellation?.onCancel,
          cancelled: deps.cancellation?.isAborted(),
          cancelReason: deps.cancellation?.reason(),
          resolveAsset: async (ref: string) => {
            if (!context.assetStore) {
              throw new Error("Asset store is not configured");
            }
            const id = resolveAssetIdForStore(ref, context.assetStore);
            return await context.assetStore.get(id);
          },
        },
      );

      if (deps.cancellation?.isAborted()) {
        throw new Error("Tool execution cancelled by newer interrupting event");
      }

      const result = results[0];

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
      const terminalStatus = result.status ?? (error ? "failed" : "completed");

      const toolResultPayload: ToolResultEventPayload = {
        agent: { id: payload.agent.id, name: payload.agent.name },
        toolCallId: callId,
        tool: { id: call.tool.id, name: call.tool.name },
        args: call.args,
        status: terminalStatus,
        ...(typeof output !== "undefined" ? { output } : {}),
        ...(typeof error !== "undefined" ? { error } : {}),
        content,
        historyVisibility: result.historyVisibility ??
          DEFAULT_TOOL_HISTORY_VISIBILITY,
        batchId,
        batchSize,
        batchIndex,
        finishedAt,
      };

      const resultMetadata = withRunSenderMetadata(
        toolExecutionId || replyToParticipantId ||
            replyToTargetQueue.length > 0
          ? {
            ...(toolExecutionId ? { toolExecutionId } : {}),
            replyToParticipantId,
            replyToTargetQueue,
          }
          : undefined,
        pickRunSenderFromMetadata(eventMetadata),
      );

      if (toolExecutionId && db?.ops?.mutate?.toolExecutions) {
        const finishPatch = {
          status: terminalStatus,
          ...(typeof output !== "undefined" ? { output } : {}),
          ...(typeof error !== "undefined" ? { error } : {}),
          historyVisibility: result.historyVisibility ??
            DEFAULT_TOOL_HISTORY_VISIBILITY,
          finishedAt,
        };
        const mutationOptions = {
          threadId,
          traceId: typeof event.traceId === "string" ? event.traceId : null,
          causationId: typeof event.id === "string" ? event.id : null,
          namespace: context.namespace,
          status: isLifecycleToolExecutionCreated
            ? "pending" as const
            : undefined,
          priority: isLifecycleToolExecutionCreated
            ? EVENT_PRIORITIES.SETTLEMENT
            : undefined,
          metadata: isLifecycleToolExecutionCreated
            ? resultMetadata ?? null
            : null,
          eventPayload: isLifecycleToolExecutionCreated
            ? toolResultPayload as unknown as Record<string, unknown>
            : null,
        };
        try {
          if (terminalStatus === "failed" || terminalStatus === "cancelled") {
            await db.ops.mutate.toolExecutions.fail(
              toolExecutionId,
              finishPatch,
              mutationOptions,
            );
          } else {
            await db.ops.mutate.toolExecutions.complete(
              toolExecutionId,
              finishPatch,
              mutationOptions,
            );
          }
        } catch (toolExecutionError) {
          console.warn(
            "[TOOL_CALL] Failed to finalize tool_execution node:",
            toolExecutionError,
          );
        }

        // Record a unified usage ledger entry for this tool execution. Cost is
        // null by default (the framework only meters tools); deployments can
        // price tools via the `usage.resolveCost` hook.
        if (context.usage?.enabled !== false && db?.ops) {
          try {
            const usageService = createUsageService({
              collections: context.collections,
              ops: db.ops,
              usageOptions: context.usage,
            });
            await usageService.recordUsage({
              kind: "tool",
              resource: call.tool.id,
              operation: "tool.exec",
              status: terminalStatus,
              threadId,
              eventId: typeof event.id === "string" ? event.id : null,
              agentId: (payload.agent.id ?? payload.agent.name) ?? null,
              initiatedById: resolvedUserExternalId ?? null,
              metrics: {
                calls: 1,
                durationMs: Math.max(0, Date.now() - toolStartedMs),
              },
              dedupeKey: toolExecutionId,
            });
          } catch (usageError) {
            console.warn(
              "[TOOL_CALL] Failed to record tool usage:",
              usageError,
            );
          }
        }
      }

      if (toolExecutionId && isLifecycleToolExecutionCreated) {
        deps.emitToStream({
          ...event,
          type: "TOOL_RESULT",
          payload: toolResultPayload,
          parentEventId: typeof event.id === "string" ? event.id : null,
          priority: EVENT_PRIORITIES.SETTLEMENT,
          metadata: resultMetadata ?? null,
          status: "completed",
        } as Event);
        return { producedEvents: [] };
      }

      const producedEvents: NewEvent[] = [
        {
          threadId,
          type: "TOOL_RESULT",
          payload: toolResultPayload,
          parentEventId: typeof event.id === "string" ? event.id : undefined,
          traceId: typeof event.traceId === "string"
            ? event.traceId
            : undefined,
          priority: EVENT_PRIORITIES.SETTLEMENT,
          metadata: resultMetadata,
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
              `\n\nDid you mean to call "${potentialToolName}"? Use this format:\n<tool_calls>\n${
                JSON.stringify({
                  name: potentialToolName,
                  arguments: toolCall,
                })
              }\n</tool_calls>`;
          } else {
            suggestion =
              `\n\nCorrect format example:\n<tool_calls>\n{"name":"create_thread","arguments":{"name":"My Thread","participants":["Agent1"]}}\n</tool_calls>`;
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
          suggestion = `\n\nExample usage:\n<tool_calls>\n{"name":"${
            agentTools[0]?.key || "tool_name"
          }","arguments":{}}\n</tool_calls>`;
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
        agent: context.agent ?? null,
        onCancel: cancellation.onCancel,
        cancelled: false,
        cancelReason: undefined,
      };

      const cancelWithContext = (reason: ToolCancelReason) => {
        toolContext.cancelled = true;
        toolContext.cancelReason = reason;
        cancellation.cancel(reason);
      };

      const unsubscribeParentCancel = context.onCancel?.(() => {
        cancelWithContext(context.cancelReason ?? "abort");
      });
      if (context.cancelled) {
        cancelWithContext(context.cancelReason ?? "abort");
      }

      let timer: number | undefined = undefined;
      if (
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) &&
        timeoutMs > 0
      ) {
        timer = setTimeout(
          () => cancelWithContext("timeout"),
          timeoutMs,
        ) as unknown as number;
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

        const { visibility } = await projectToolResultForHistory(
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
        } satisfies ProcessedToolCallResult;
      } catch (error) {
        const isTimeout = Boolean(
          cancellation.cancelled && cancellation.reason === "timeout",
        );
        const errorMessage = isTimeout
          ? `EXECUTION CANCELLED: Tool execution timed out after ${
            Math.round((timeoutMs ?? 0) / 1000)
          }s`
          : `EXECUTION ERROR: ${
            error instanceof Error ? error.message : String(error)
          }`;

        const { visibility } = await projectToolResultForHistory(
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
        } satisfies ProcessedToolCallResult;
      } finally {
        if (timer) clearTimeout(timer);
        unsubscribeParentCancel?.();
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


export function formatDiscriminatedOneOfError(
  schema: any,
  args: any,
  toolName: string = "tool"
): string | null {
  if (!schema) return null;

  if (Array.isArray(schema.oneOf)) {
    let discriminatorName: string | null = null;
    const allowedValues: string[] = [];
    const branchMap = new Map<string, any>();

    const firstBranch = schema.oneOf[0];
    if (!firstBranch || !firstBranch.properties) {
      return null;
    }

    const candidates = Object.keys(firstBranch.properties).filter(key => {
      const prop = firstBranch.properties[key];
      return prop && typeof prop === "object" && "const" in prop && typeof prop.const === "string";
    });

    for (const candidate of candidates) {
      let isDiscriminator = true;
      const values: string[] = [];
      const tempBranchMap = new Map<string, any>();

      for (const branch of schema.oneOf) {
        if (!branch.properties || !branch.properties[candidate]) {
          isDiscriminator = false;
          break;
        }
        const prop = branch.properties[candidate];
        if (!prop || typeof prop !== "object" || !("const" in prop) || typeof prop.const !== "string") {
          isDiscriminator = false;
          break;
        }
        values.push(prop.const);
        tempBranchMap.set(prop.const, branch);
      }

      if (isDiscriminator) {
        discriminatorName = candidate;
        allowedValues.push(...values);
        for (const [k, v] of tempBranchMap.entries()) {
          branchMap.set(k, v);
        }
        break;
      }
    }

    if (!discriminatorName) {
      return null;
    }

    const val = args[discriminatorName];

    if (val === undefined || val === null) {
      return `Missing required field '${discriminatorName}'. Allowed ${discriminatorName}s: ${allowedValues.join(", ")}`;
    }

    if (typeof val !== "string" || !branchMap.has(val)) {
      return `Unknown ${discriminatorName} '${val}'. Allowed ${discriminatorName}s: ${allowedValues.join(", ")}`;
    }

    const branch = branchMap.get(val);
    
    if (branch && Array.isArray(branch.oneOf)) {
      const nestedError = formatDiscriminatedOneOfError(branch, args, toolName);
      if (nestedError) {
        return nestedError;
      }
    }

    const requiredFields = Array.isArray(branch.required) ? branch.required : [];
    let allowedFields = branch.properties ? Object.keys(branch.properties) : [];
    if (branch && Array.isArray(branch.oneOf)) {
      for (const subBranch of branch.oneOf) {
        if (subBranch.properties) {
          allowedFields = Array.from(new Set([...allowedFields, ...Object.keys(subBranch.properties)]));
        }
      }
    }
    
    const missingRequired: string[] = [];
    const unexpectedFields: string[] = [];

    for (const req of requiredFields) {
      if (!(req in args)) {
        missingRequired.push(req);
      }
    }

    for (const key of Object.keys(args)) {
      if (!allowedFields.includes(key)) {
        unexpectedFields.push(key);
      }
    }

    if (missingRequired.length > 0 || unexpectedFields.length > 0) {
      let msg = `Invalid arguments for ${toolName} ${discriminatorName} '${val}'.`;
      if (requiredFields.length > 0) {
        msg += ` Required: ${requiredFields.join(", ")}.`;
      }
      if (allowedFields.length > 0) {
        msg += ` Allowed: ${allowedFields.join(", ")}.`;
      }
      if (unexpectedFields.length > 0) {
        msg += ` Unexpected: ${unexpectedFields.join(", ")}.`;
      }
      return msg;
    }
  }

  return null;
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
  // ONLY if it does not contain any schema combinators (oneOf, anyOf, allOf, if, then, else, not)
  const hasCombinators = 
    "oneOf" in tool.inputSchema ||
    "anyOf" in tool.inputSchema ||
    "allOf" in tool.inputSchema ||
    "if" in tool.inputSchema ||
    "then" in tool.inputSchema ||
    "else" in tool.inputSchema ||
    "not" in tool.inputSchema;

  if (
    tool.inputSchema.type === "object" &&
    (!schemaProperties || Object.keys(schemaProperties).length === 0) &&
    (!requiredFields || requiredFields.length === 0) &&
    !hasCombinators
  ) {
    return { valid: true };
  }

  try {
    const validate = ajv.compile(tool.inputSchema);
    const valid = validate(args);

    if (!valid) {
      const formattedError = formatDiscriminatedOneOfError(tool.inputSchema, args, toolCall.name);
      const errorMessage = formattedError || ajv.errorsText(validate.errors);
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
