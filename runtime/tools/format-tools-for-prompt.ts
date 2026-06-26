import type { ToolDefinition } from "@/runtime/llm/types.ts";
import { generateAgentTypesFromSchema } from "@/runtime/tools/schema-to-agent-types.ts";

type PromptTool = {
  key: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown> | null;
};

const typeCache = new Map<string, string>();

function pascalCase(input: string): string {
  const parts = String(input)
    .replace(/[\[\].{}]/g, " ")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const out = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return out || "Tool";
}

function cacheKey(toolKey: string, schema: Record<string, unknown>): string {
  return `${toolKey}:${JSON.stringify(schema)}`;
}

function renderInputTypes(
  tool: PromptTool,
  schema: Record<string, unknown>,
): string {
  const key = cacheKey(tool.key, schema);
  const cached = typeCache.get(key);
  if (cached) return cached;

  let inputTypes: string;
  try {
    inputTypes = generateAgentTypesFromSchema(schema, {
      rootName: `${pascalCase(tool.key)}Input`,
      moduleName: tool.name,
    });
  } catch {
    inputTypes = [
      "/** Tool input could not be rendered from schema. */",
      "export type ToolInput = Record<string, unknown>;",
      "",
    ].join("\n");
  }

  typeCache.set(key, inputTypes);
  return inputTypes;
}

/** Build LLM tool definitions with generated TypeScript input types for the prompt catalog. */
export function formatToolsForPrompt(tools: PromptTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const schema = tool.inputSchema && typeof tool.inputSchema === "object"
      ? tool.inputSchema
      : { type: "object", properties: {} };

    return {
      type: "function" as const,
      function: {
        name: tool.key,
        description: tool.description,
        inputTypes: renderInputTypes(tool, schema),
      },
    };
  });
}
