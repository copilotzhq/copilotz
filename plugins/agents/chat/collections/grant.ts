/**
 * What a person let an agent do without asking again: one kind of work
 * (`work`) on one thing (`on`: a computer's desk, a place a share goes), in
 * one conversation (`thread`), always, one exact thing once (`once`, the
 * detail it was for; used up when it's done), or whenever what they set up
 * runs (`origin` and `rev`: a routine, as it was when they said yes). It's
 * theirs (`owner`): it lets only what they'd be asked. The plugin that
 * asks adds what it needs of its own (computers: `computer`).
 */
import { defineCollection, type Infer, people } from "../../../../runtime/mod.ts";

const grantSchema = {
  type: "object",
  properties: {
    /** Who said yes. */
    owner: { type: "string" },
    agent: { type: "string" },
    /** What kind of work it lets: a computer's `terminal`, `jobs`, `writes`; a `share`. */
    work: { type: "string" },
    /** What it's for: a desk; a place. */
    on: { type: "string" },
    /** Only in this conversation. */
    thread: { type: "string" },
    /** Only this, once. */
    once: { type: "string" },
    /** Only when this runs (chat's `originKey`), at this version of it. */
    origin: { type: "string" },
    rev: { type: "integer" },
    at: { type: "string" },
  },
  required: ["owner", "agent", "work", "on", "at"],
} as const;

export const grant = defineCollection({
  schema: grantSchema,
  indexes: [["on", "agent", "work"], ["origin"]],
  queries: {
    /** What the asker has let agents do. */
    mine: {
      allow: people,
      run: (grants) => grants.find({}, { sort: { at: 1 } }),
    },
    /** What the asker lets for what they set up to run, at any version of it. */
    forOrigin: {
      allow: people,
      run: (grants, params: { origin: string }) => grants.find({ origin: params.origin }),
    },
  },
});

export type Grant = Infer<typeof grantSchema> & { _id: string };
