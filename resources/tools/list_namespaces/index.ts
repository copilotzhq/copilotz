import type { ToolExecutionContext } from "@/runtime/tools/types.ts";

export default {
  key: "list_knowledge_spaces",
  name: "List Knowledge Spaces",
  description: "List knowledge_space nodes in the current tenant namespace.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  execute: async (
    _params: Record<string, never>,
    context?: ToolExecutionContext,
  ) => {
    const ops = context?.db?.ops;
    if (!ops) {
      throw new Error("Database operations not available in context");
    }

    const namespace = context?.namespace;
    if (!namespace) {
      throw new Error("Tenant namespace not available in context");
    }

    const spaces = await ops.getNodesByNamespace(namespace, "knowledge_space");

    if (spaces.length === 0) {
      return {
        knowledgeSpaces: [],
        message: "No knowledge spaces found.",
      };
    }

    return {
      knowledgeSpaces: spaces.map((space) => ({
        id: space.id,
        name: space.name,
        metadata: space.data ?? null,
        createdAt: space.createdAt ?? null,
        updatedAt: space.updatedAt ?? null,
      })),
      totalKnowledgeSpaces: spaces.length,
    };
  },
};
