/**
 * Spaces: what documents live in, and what people and agents are members
 * of. A shared space, an org or someone's Personal space is a space; so is a
 * single document shared on its own (its members are on it directly).
 */
import { defineCollection, type Infer, people } from "../../../../runtime/mod.ts";
import { reachOf, type Verb } from "../shared/reach.ts";

const spaceSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    /** `shared`, `org`, `personal`… Only plugins give it meaning. */
    kind: { type: "string" },
    /** The person whose Personal space it is. */
    owner: { type: "string" },
    /** When it was archived (`space.archive`): listed apart, until it's brought back. */
    archived: { type: "string" },
    /** The agent that answers its new chats (`space.agent`): one working here. */
    agent: { type: "string" },
  },
  required: ["name", "kind"],
} as const;

export const space = defineCollection({
  schema: spaceSchema,
  queries: {
    /**
     * The spaces the actor reaches, by name, each with what they may do there
     * (`can`: `read`, `write`, `manage`), so a front end offers only that;
     * archived ones too, marked (`archived`), for a front end to list apart.
     */
    reached: {
      allow: people,
      run: async (spaces, _, ctx) => {
        const found = await spaces.find({}, { sort: { name: 1 } });
        if (!ctx.actor) return found;
        const reach = await reachOf(ctx.actor, ctx);
        return found.map((s) => ({ ...s, can: [...reach.get(s._id)?.can ?? []] }));
      },
    },
  },
});

export type Space = Infer<typeof spaceSchema> & { _id: string };

/** A space as `space.reached` answers: with what the asker may do there. */
export type Reached = Space & { can: Verb[] };
