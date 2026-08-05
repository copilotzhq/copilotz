import type { Tool } from "@/types/resources.ts";

/**
 * Public multi-agent conversation capability. Execution is handled by the
 * built-in tool processor so the question and answer become regular messages.
 */
const ask: Tool = {
  resourceType: "tools",
  id: "ask",
  key: "ask",
  name: "Ask an agent",
  description:
    "Ask another agent in this thread. The question and answer are public conversation messages. Use the target agent id and a complete question.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      agent: { type: "string", description: "Target agent id or name" },
      message: { type: "string", description: "Complete question" },
    },
    required: ["agent", "message"],
  },
};

export default ask;
