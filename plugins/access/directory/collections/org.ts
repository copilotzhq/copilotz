/**
 * Orgs, as the directory routes them: a name, a kind (`personal` for the one
 * everyone has, `team` for those people make), who made it, and where its
 * rows live (`placement`: the schema it shares, or has to itself). An org's
 * own data (its people's roles, its spaces) lives in the org, never here.
 * `summary` is what the org last reported, for the platform console.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const orgSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    kind: { type: "string", enum: ["personal", "team"] },
    /** Who made it (a person, by their sign-in id). */
    by: { type: "string" },
    placement: {
      type: "object",
      properties: { schema: { type: "string" } },
      required: ["schema"],
    },
    /** A suspended org lets nobody in. */
    suspended: { type: "boolean" },
    summary: {
      type: "object",
      properties: {
        people: { type: "number" },
        spaces: { type: "number" },
        active: { type: "string" },
        at: { type: "string" },
      },
    },
    at: { type: "string" },
  },
  required: ["name", "kind", "by", "placement", "at"],
} as const;

export const org = defineCollection({
  schema: orgSchema,
  indexes: [["by"]],
  queries: {
    /**
     * An org as the directory opens it (its name, kind, placement, and
     * whether it's suspended), or null. The system's: the directory's routes
     * ask it for every request they forward, and the app, to open an org.
     */
    info: async (orgs, params: { org: string }) => {
      const found = await orgs.findOne({ _id: String(params.org ?? "") });
      return found
        ? {
          id: found._id,
          name: found.name,
          kind: found.kind,
          placement: found.placement,
          ...(found.suspended ? { suspended: true } : {}),
        }
        : null;
    },
  },
});

export type Org = Infer<typeof orgSchema> & { _id: string };
