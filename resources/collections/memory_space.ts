import { defineCollection, relation } from "@/database/collections/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

export default defineCollection({
  name: "memory_space",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      scopeType: { type: "string" },
      scopeId: { type: "string" },
      kind: { type: ["string", "null"] },
      ownerNodeId: { type: ["string", "null"] },
      threadId: { type: ["string", "null"] },
    },
    required: ["scopeType", "scopeId"],
  } as const,
  indexes: [["scopeType", "scopeId"], ["kind", "ownerNodeId"], "threadId"],
  relations: {
    brainNodes: relation.hasMany(
      "brain_node",
      "memorySpaceId",
      GRAPH_EDGE.HAS_BRAIN_NODE,
    ),
  },
});
