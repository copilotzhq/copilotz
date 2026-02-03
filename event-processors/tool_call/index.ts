
// Import Generators
import { generateAllApiTools } from "@/event-processors/tool_call/generators/api-generator.ts";
import { generateAllMcpTools } from "@/event-processors/tool_call/generators/mcp-generator.ts";

// Import Native Tools Registry
import { getNativeTools } from "./native-tools-registry/index.ts";

// Import Types
import type {
  Event,
  EventProcessor,
  NewEvent,
  Tool,
  ProcessorDeps,
  ChatContext,
  Agent,
  CopilotzDb,
} from "@/interfaces/index.ts";
import type { ExecutableTool } from "./types.ts";
import type { ToolCall } from "@/connectors/llm/types.ts";

import Ajv from "npm:ajv@^8.17.1";
import addFormats from "npm:ajv-formats@^3.0.1";
import { resolveAssetIdForStore } from "@/utils/assets.ts";

// Tool call with optional id (before being sent to LLM)
export type ToolCallInput = Omit<ToolCall, 'id'> & { id?: string };

export interface ToolCallPayload {
  agentName: string; // agent that requested the tool
  senderId: string;
  senderType: "user" | "agent" | "tool" | "system";
  call: ToolCallInput;
}

export interface ToolResultPayload {
  agentName: string; // agent that requested the tool
  callId: string;
  output?: unknown;
  error?: unknown;
  // Optional convenience content (already formatted) for logs/messages
  content?: string;
}

export interface ToolExecutionContext extends ChatContext {
  senderId?: string;
  senderType?: "user" | "agent" | "tool" | "system";
  threadId?: string;
  agents?: Agent[];
  db?: CopilotzDb;
  embeddingConfig?: {
    provider: "openai" | "ollama" | "cohere";
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  // Collections is inherited from ChatContext, but we re-declare for clarity
  // collections?: CollectionsManager;
}

function assertToolCallPayload(payload: unknown): asserts payload is ToolCallPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid tool call payload");
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.agentName !== "string") throw new Error("Invalid tool call payload: agentName");
  if (typeof value.senderId !== "string") throw new Error("Invalid tool call payload: senderId");
  if (
    typeof value.senderType !== "string" ||
    !["user", "agent", "tool", "system"].includes(value.senderType)
  ) {
    throw new Error("Invalid tool call payload: senderType");
  }
  const call = value.call as Record<string, unknown> | undefined;
  const fn = call?.function as Record<string, unknown> | undefined;
  if (!call || typeof call !== "object") throw new Error("Invalid tool call payload: call");
  if (!fn || typeof fn !== "object") throw new Error("Invalid tool call payload: call.function");
  if (typeof fn.name !== "string") throw new Error("Invalid tool call payload: function.name");
  if (typeof fn.arguments !== "string") {
    throw new Error("Invalid tool call payload: function.arguments");
  }
}


const hasExecute = (tool: unknown): tool is ExecutableTool =>
  Boolean(
    tool &&
    typeof tool === "object" &&
    typeof (tool as { execute?: unknown }).execute === "function",
  );

export const toolCallProcessor: EventProcessor<ToolCallPayload, ProcessorDeps> = {
  shouldProcess: () => true,
  process: async (event: Event, deps: ProcessorDeps) => {
    const { db, thread: _thread, context } = deps;
    assertToolCallPayload(event.payload);
    const payload = event.payload;

    const threadId = typeof event.threadId === "string" ? event.threadId : undefined;
    if (!threadId) {
      throw new Error("Invalid thread id for tool call event");
    }

    const availableAgents = context.agents || [];
    const agent = availableAgents.find(a => a.name === payload.agentName);
    if (!agent) return { producedEvents: [] };

    // Build tools
    const nativeToolsArray = Object.values(getNativeTools()).filter(hasExecute);
    const userTools = (context.tools || []).filter(hasExecute);
    const apiTools = context.apis
      ? generateAllApiTools(context.apis).filter(hasExecute)
      : [];
    const mcpTools = context.mcpServers
      ? (await generateAllMcpTools(context.mcpServers)).filter(hasExecute)
      : [];
    const allTools: ExecutableTool[] = [
      ...nativeToolsArray,
      ...userTools,
      ...apiTools,
      ...mcpTools,
    ];

    const allowedKeys = Array.isArray(agent.allowedTools) && agent.allowedTools.length > 0
      ? agent.allowedTools
      : allTools.map((t) => t.key);
    const agentTools =
      allowedKeys.map((key: string) => allTools.find((t) => t.key === key)).filter(hasExecute) || [];

    const results = await processToolCalls(
      [payload.call],
      agentTools,
      {
        ...context,
        senderId: agent.name,
        senderType: "agent",
        threadId,
        agents: availableAgents,
        tools: allTools,
        db,
        resolveAsset: async (ref: string) => {
          if (!context.assetStore) throw new Error("Asset store is not configured");
          const id = resolveAssetIdForStore(ref, context.assetStore);
          return await context.assetStore.get(id);
        },
      }
    );

    const result = results[0];
    const call = payload.call;
    const callId = call.id || `${call.function.name}_${Date.now()}`;

    // Schedule a follow-up message event to let the agent continue after tool result
    const output = result.output;
    const error = result.error;

    let content: string;
    if (error) {
      content = `tool error: ${String(error)}\n\nPlease review the error above and try again with the correct format.`;
    } else if (typeof output !== "undefined") {
      try {
        content = typeof output === "string" ? output : JSON.stringify(output);
      } catch {
        content = String(output);
      }
    } else {
      content = `No output returned`;
    }
    // Extract batch info from payload
    const payloadWithBatch = payload as typeof payload & {
      batchId?: string | null;
      batchSize?: number | null;
      batchIndex?: number | null;
    };
    const batchId = payloadWithBatch.batchId ?? null;
    const batchSize = payloadWithBatch.batchSize ?? null;
    const batchIndex = payloadWithBatch.batchIndex ?? null;

    // Enqueue a MESSAGE event
    const producedEvents: NewEvent[] = [
      {
        threadId,
        type: "NEW_MESSAGE",
        payload: {
          content,
          sender: {
            type: "tool",
            id: payload.senderId,
            name: payload.senderId,
          },
          metadata: {
            toolCalls: [
              {
                name: call.function.name,
                args: call.function.arguments,
                output,
                id: callId,
                status: error ? "failed" : "completed",
              },
            ],
            // Include batch info for aggregation in NEW_MESSAGE processor
            batchId,
            batchSize,
            batchIndex,
          },
        },
        parentEventId: typeof event.id === "string" ? event.id : undefined,
        traceId: typeof event.traceId === "string" ? event.traceId : undefined,
        priority: typeof event.priority === "number" ? event.priority : undefined,
      }
    ];

    return { producedEvents };
  }
};


/**
 * Calculate Levenshtein distance between two strings (for typo detection)
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

  for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,     // insertion
        matrix[j - 1][i] + 1,     // deletion
        matrix[j - 1][i - 1] + indicator // substitution
      );
    }
  }

  return matrix[str2.length][str1.length];
}

export const processToolCalls = async (
  toolCalls: ToolCallInput[],
  agentTools: ExecutableTool[] = [],
  context: ToolExecutionContext = {}
) => {
  const availableTools = agentTools.map(t => t.key).join(", ");

  const results = await Promise.all(
    toolCalls.map(async (toolCall) => {
      // Handle malformed tool calls gracefully
      let name: string;
      let argsString: string;

      try {
        // Check if tool call has proper structure
        if (!toolCall.function) {
          // Check if it looks like the agent tried to call a tool directly
          const potentialToolName = Object.keys(toolCall).find(key =>
            agentTools.some(tool => tool.key === key)
          );

          let suggestion = "";
          if (potentialToolName) {
            suggestion = `\n\nDid you mean to call "${potentialToolName}"? Use this format:\n<tool_calls>\n{"function": {"name": "${potentialToolName}", "arguments": ${JSON.stringify(toolCall)}}}\n</tool_calls>`;
          } else {
            suggestion = `\n\nCorrect format example:\n<tool_calls>\n{"function": {"name": "create_thread", "arguments": {"name": "My Thread", "participants": ["Agent1"]}}}\n</tool_calls>`;
          }

          return {
            tool_call_id: toolCall.id || "unknown",
            name: "unknown",
            error: `MALFORMED TOOL CALL: Expected format {"function": {"name": "tool_name", "arguments": "..."}}. Available tools: [${availableTools}].${suggestion}`
          };
        }

        name = toolCall.function.name;
        argsString = toolCall.function.arguments;

        // Validate name exists
        if (!name) {
          return {
            tool_call_id: toolCall.id || "unknown",
            name: "unknown",
            error: `MISSING TOOL NAME: You must specify a tool name. Available tools: [${availableTools}]. Your call was: ${JSON.stringify(toolCall)}`
          };
        }

      } catch (error) {
        return {
          tool_call_id: toolCall.id || "unknown",
          name: "unknown",
          error: `INVALID TOOL CALL STRUCTURE: ${error instanceof Error ? error.message : String(error)}. Available tools: [${availableTools}]`
        };
      }

      // Find the tool
      const tool = agentTools.find((t) => t.key === name);

      if (!tool) {
        // Find similar tool names (typo detection)
        const similarTools = agentTools.filter(t =>
          t.key.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(t.key.toLowerCase()) ||
          levenshteinDistance(t.key.toLowerCase(), name.toLowerCase()) <= 2
        );

        let suggestion = "";
        if (similarTools.length > 0) {
          suggestion = `\n\nDid you mean: ${similarTools.map(t => `"${t.key}"`).join(", ")}?`;
        } else {
          suggestion = `\n\nExample usage:\n<tool_calls>\n{"function": {"name": "${agentTools[0]?.key || 'tool_name'}", "arguments": {...}}}\n</tool_calls>`;
        }

        return {
          tool_call_id: toolCall.id,
          name,
          error: `TOOL NOT FOUND: "${name}" is not available. Available tools: [${availableTools}].${suggestion}`,
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
          error: `INVALID JSON ARGUMENTS: The arguments must be valid JSON. Your arguments: ${argsString}. Error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      // Validate tool call structure
      const validation = validateToolCall({ name, arguments: args }, tool);
      if (!validation.valid) {
        return {
          tool_call_id: toolCall.id,
          name,
          error: `VALIDATION ERROR: ${validation.error}. Please check the tool's required parameters and try again.`,
        };
      }

      // Execute the tool
      try {
        const output = await tool.execute(args, context);

        return {
          tool_call_id: toolCall.id,
          name,
          output,
        };

      } catch (error) {
        return {
          tool_call_id: toolCall.id,
          name,
          error: `EXECUTION ERROR: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    })
  );

  return results;
};

// Create Ajv instance - using type assertions due to npm module import compatibility
const createAjv = () => {
  // deno-lint-ignore no-explicit-any
  const instance = new (Ajv as any)();
  // deno-lint-ignore no-explicit-any
  (addFormats as any)(instance);
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

export const validateToolCall = (toolCall: ToolCallValidation, tool: Tool): ValidationResult => {
  // If no input schema is defined, any input is valid
  if (!tool.inputSchema) {
    return { valid: true };
  }

  // Handle undefined or null arguments
  const args = toolCall.arguments || {};

  const schemaProperties =
    tool.inputSchema.properties && typeof tool.inputSchema.properties === "object"
      ? tool.inputSchema.properties as Record<string, unknown>
      : undefined;
  const requiredFields = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required
    : undefined;

  // If the schema has no properties and no required fields, accept empty arguments
  if (tool.inputSchema.type === 'object' &&
    (!schemaProperties || Object.keys(schemaProperties).length === 0) &&
    (!requiredFields || requiredFields.length === 0)) {
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
      error: `Schema validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
};