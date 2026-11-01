/**
 * What a person let an agent do at a desk (a computer, in one space) without
 * asking again: in one conversation (`thread`), always, one exact thing once
 * (`once`, the detail it was for; used up when it's done), or whenever what
 * they set up runs (`origin` and `rev`: a routine, as it was when they said
 * yes). It's theirs (`owner`): it lets only what they'd be asked.
 */
import { defineCollection, type Infer, people } from "../../../../runtime/mod.ts";

const grantSchema = {
  type: "object",
  properties: {
    /** Who said yes. */
    owner: { type: "string" },
    desk: { type: "string" },
    computer: { type: "string" },
    agent: { type: "string" },
    /** What kind of work it lets: `terminal`, `jobs`, `writes`. */
    work: { type: "string" },
    /** Only in this conversation. */
    thread: { type: "string" },
    /** Only this, once. */
    once: { type: "string" },
    /** Only when this runs (chat's `originKey`), at this version of it. */
    origin: { type: "string" },
    rev: { type: "integer" },
    at: { type: "string" },
  },
  required: ["owner", "desk", "computer", "agent", "work", "at"],
} as const;

export const grant = defineCollection({
  schema: grantSchema,
  indexes: [["desk", "agent", "work"], ["computer"], ["origin"]],
  queries: {
    /** What the asker lets for what they set up to run, at any version of it. */
    forOrigin: {
      allow: people,
      run: (grants, params: { origin: string }) => grants.find({ origin: params.origin }),
    },
  },
});

export type Grant = Infer<typeof grantSchema> & { _id: string };
