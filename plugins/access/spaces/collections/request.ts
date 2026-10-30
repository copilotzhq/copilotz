/**
 * Access requests: someone (usually through their agent) asks to be let into
 * a space. Its managers see them and grant or deny them.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const requestSchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    /** Who would be let in: `person:ana`. */
    member: { type: "string" },
    /** Who asked for them: an agent, or themselves. */
    by: { type: "string" },
    reason: { type: "string" },
    at: { type: "string" },
  },
  required: ["space", "member", "at"],
} as const;

export const request = defineCollection({
  schema: requestSchema,
  indexes: [["space"], ["member"]],
  queries: {
    /** Requests waiting on the actor: for spaces they manage, oldest first. */
    open: {
      allow: (actor) => actor.kind === "person",
      run: (requests) => requests.find({}, { sort: { at: 1 } }),
    },
  },
});

export type Request = Infer<typeof requestSchema> & { _id: string };
