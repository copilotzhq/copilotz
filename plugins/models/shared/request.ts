/** A model request, as the llm Actions take it. */
export const message = {
  type: "object",
  properties: {
    role: { enum: ["user", "assistant", "tool"] },
    text: { type: "string" },
    toolCalls: { type: "array" },
    toolCallId: { type: "string" },
  },
  required: ["role"],
} as const;

/** `model`, `instructions`, the conversation and the tools offered, and the tags its use carries. */
export const request = {
  model: { type: ["string", "object", "array"] },
  instructions: { type: "string" },
  messages: { type: "array", items: message },
  tools: { type: "array" },
  tags: { type: "object", additionalProperties: { type: "string" } },
} as const;
