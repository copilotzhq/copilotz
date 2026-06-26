import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { formatToolsForPrompt } from "./format-tools-for-prompt.ts";
import { generateAgentTypesFromSchema } from "./schema-to-agent-types.ts";
import {
  formatMessages,
  generateToolSystemPrompt,
} from "@/runtime/llm/utils.ts";

Deno.test("generateAgentTypesFromSchema renders nested oneOf action unions", () => {
  const output = generateAgentTypesFromSchema({
    type: "object",
    required: ["actions"],
    properties: {
      actions: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                action: { const: "exec" },
                command: { type: "string", description: "Shell command." },
              },
              required: ["action", "command"],
            },
            {
              type: "object",
              properties: {
                action: { const: "read" },
                path: { type: "string", description: "File path." },
              },
              required: ["action", "path"],
            },
          ],
        },
      },
    },
  }, { rootName: "SandboxInput", moduleName: "Sandbox Session" });

  assertStringIncludes(output, "export interface SandboxInput");
  assertStringIncludes(output, "export type");
  assertStringIncludes(output, "Valid when action=");
});

Deno.test("formatToolsForPrompt generates TypeScript catalog entries", () => {
  const tools = formatToolsForPrompt([{
    key: "get_current_time",
    name: "Current Time",
    description: "Returns the current time.",
    inputSchema: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone." },
      },
    },
  }]);

  assertEquals(tools.length, 1);
  assertEquals(tools[0]?.function.name, "get_current_time");
  assertStringIncludes(tools[0]?.function.inputTypes ?? "", "export interface");
  assertStringIncludes(tools[0]?.function.inputTypes ?? "", "timezone?: string");
});

Deno.test("generateToolSystemPrompt renders typescript catalog sections", () => {
  const prompt = generateToolSystemPrompt([{
    type: "function",
    function: {
      name: "example_tool",
      description: "Example tool.",
      inputTypes: "export interface ExampleToolInput { id: string; }\n",
    },
  }]);

  assertStringIncludes(prompt, "### example_tool");
  assertStringIncludes(prompt, "Example tool.");
  assertStringIncludes(prompt, "```typescript");
  assertStringIncludes(prompt, "export interface ExampleToolInput");
  assertEquals(prompt.includes('"type":"function"'), false);
});

Deno.test("formatMessages prepends typescript tool catalog into system prompt", () => {
  const formatted = formatMessages({
    messages: [{ role: "system", content: "You are North." }],
    tools: [{
      type: "function",
      function: {
        name: "kanban",
        description: "Manage kanban cards.",
        inputTypes: "export interface KanbanInput { action: string; }\n",
      },
    }],
  });

  const system = formatted[0]?.content;
  assertEquals(typeof system, "string");
  assertStringIncludes(system as string, "=== TOOL CATALOG (read-only) ===");
  assertStringIncludes(system as string, "### kanban");
  assertStringIncludes(system as string, "You are North.");
});
