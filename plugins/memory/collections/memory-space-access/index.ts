/** Thread-to-memory-space access collection definition. @module */
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    namespace: { type: "string" },
    threadId: { type: "string" },
    memorySpaceId: { type: "string" },
    access: { type: "string", enum: ["read", "read_write"] },
    defaultWrite: { type: "boolean" },
    metadata: { type: ["object", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["threadId", "memorySpaceId", "access", "defaultWrite"],
} as const;
export const memorySpaceAccessCollection: CollectionDefinition<typeof schema> =
  defineCollection({
    name: "memory_space_access",
    schema: schema,
    indexes: [["threadId", "memorySpaceId"], [
      "threadId",
      "access",
      "defaultWrite",
    ], "memorySpaceId"],
    relations: {
      thread: relation.belongsTo(
        "thread",
        "threadId",
        "has_memory_space_access",
      ),
      memorySpace: relation.belongsTo(
        "memory_space",
        "memorySpaceId",
        "grants_memory_space_access",
      ),
    },
  });

export default memorySpaceAccessCollection;
