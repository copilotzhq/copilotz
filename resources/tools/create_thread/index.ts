import type {
  BackgroundThreadInput,
  Tool,
  ToolExecutionContext,
} from "@/types/resources.ts";

function inputOf(value: unknown): BackgroundThreadInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("create_thread requires an object input.");
  }
  const input = value as Record<string, unknown>;
  const participants = Array.isArray(input.participants)
    ? input.participants.filter((item): item is string =>
      typeof item === "string" && item.trim().length > 0
    )
    : [];
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new TypeError("create_thread requires a name.");
  }
  if (!participants.length) {
    throw new TypeError("create_thread requires at least one participant.");
  }
  return {
    name: input.name,
    participants,
    ...(typeof input.initialMessage === "string"
      ? { initialMessage: input.initialMessage }
      : {}),
    ...(typeof input.description === "string"
      ? { description: input.description }
      : {}),
    ...(input.metadata && typeof input.metadata === "object" &&
        !Array.isArray(input.metadata)
      ? { metadata: input.metadata as Record<string, unknown> }
      : {}),
  };
}

const createThread: Tool = {
  resourceType: "tools",
  id: "create_thread",
  key: "create_thread",
  name: "Create background thread",
  description:
    "Start an explicitly separate child-thread conversation. This is background work, not a private consultation in the current thread.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "Child thread name" },
      participants: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
        description: "Agent IDs or names participating in the child thread",
      },
      initialMessage: {
        type: "string",
        description: "Optional public opening message sent to the first agent",
      },
      description: { type: "string" },
      metadata: { type: "object" },
    },
    required: ["name", "participants"],
  },
  execute(input: unknown, context: ToolExecutionContext) {
    return context.createThread(inputOf(input));
  },
};

export default createThread;
