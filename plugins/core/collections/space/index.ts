/** Durable shared work context, owned by Core rather than the runtime. @module */
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "@copilotz/copilotz/collections";
import { timestampsSchema } from "../../shared/schema.ts";

export const spaceCollection: CollectionDefinition = defineCollection({
  name: "space",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      ownerId: { type: "string", minLength: 1 },
      memberIds: {
        type: "array",
        items: { type: "string", minLength: 1 },
        uniqueItems: true,
      },
      status: { enum: ["active", "archived"] },
      revision: { type: "integer", minimum: 0 },
      ...timestampsSchema,
    },
    required: [
      "id",
      "namespace",
      "name",
      "ownerId",
      "memberIds",
      "status",
      "revision",
      "createdAt",
      "updatedAt",
    ],
  } as const,
  defaults: { name: "", memberIds: [], status: "active", revision: 0 },
  indexes: ["status", "ownerId"],
  search: { enabled: true, fields: ["name"] },
  relations: {
    owner: relation.belongsTo("participant", "ownerId", "owns_space"),
    members: relation.hasMany(
      "participant",
      "memberIds",
      "space_member",
      "child-to-parent",
    ),
  },
  queries: { active: { filter: () => ({ status: "active" }) } },
  commands: {
    // Touching the Space fences attachments against concurrent archive/removal.
    touch: {
      mutate({ current, input }) {
        if (
          (input as { active?: boolean }).active && current.status !== "active"
        ) {
          throw new Error("Space is archived.");
        }
        return { set: { revision: Number(current.revision) + 1 } };
      },
    },
    member: {
      mutate({ current, input }) {
        const { participantId, remove } = input as {
          participantId: string;
          remove?: boolean;
        };
        if (remove && participantId === current.ownerId) {
          throw new Error("Cannot remove the Space owner.");
        }
        const members = current.memberIds as string[];
        return {
          set: {
            memberIds: remove
              ? members.filter((id) => id !== participantId)
              : [...new Set([...members, participantId])],
          },
        };
      },
    },
  },
});

export default spaceCollection;
