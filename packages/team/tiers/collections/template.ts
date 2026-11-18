/**
 * The org's tiers, as it keeps them (`tierTemplate`, one per tier, by its
 * name): its version of one of the app's (kinds' chains changed, a title, or
 * `off`: taken away), or one it made (`made`, whole). Changed only through
 * `tiers.save`, `tiers.remove` and `tiers.restore`, by the org's owners and
 * admins; everyone in the org reads them, through `modelChoice.offered`.
 */
import { defineCollection } from "copilotz";

export const tierTemplate = defineCollection({
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      order: { type: "number" },
      /** Kinds of work's chains, by kind. */
      agents: { type: "object" },
      off: { type: "boolean" },
      made: { type: "boolean" },
      at: { type: "string" },
    },
    required: ["at"],
  },
});

/**
 * Kinds of work an org added (`tierKind`, by name): what it's called, and
 * the app's kind it starts from, whose chain it takes in any tier that
 * doesn't name it. Through `tiers.kind`, by owners and admins.
 */
export const tierKind = defineCollection({
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      base: { type: "string" },
      at: { type: "string" },
    },
    required: ["title", "base", "at"],
  },
});
