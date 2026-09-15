/** One durable Space attachment per collection record. @module */
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import { timestampsSchema } from "../internal/schema.ts";

export function spaceAttachmentId(
  collection: string,
  recordId: string,
): string {
  return `space-attachment:${encodeURIComponent(collection)}:${
    encodeURIComponent(recordId)
  }`;
}

function validateIdentity(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (
    data.id !==
      spaceAttachmentId(String(data.collection), String(data.recordId))
  ) {
    throw new Error(
      "Space attachment identity must match its collection and record.",
    );
  }
  return data;
}

export const spaceAttachmentCollection: CollectionDefinition = defineCollection(
  {
    name: "spaceAttachment",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        namespace: { type: "string" },
        collection: { type: "string", minLength: 1 },
        recordId: { type: "string", minLength: 1 },
        spaceId: { type: "string", minLength: 1 },
        ...timestampsSchema,
      },
      required: [
        "id",
        "namespace",
        "collection",
        "recordId",
        "spaceId",
        "createdAt",
        "updatedAt",
      ],
    } as const,
    indexes: ["spaceId", ["spaceId", "collection"]],
    relations: {
      space: relation.belongsTo("space", "spaceId", "spaceAttachment"),
    },
    beforeCreate: validateIdentity,
    beforeUpdate: validateIdentity,
    queries: {
      bySpace: { filter: ({ input }) => ({ spaceId: String(input.spaceId) }) },
    },
  },
);
