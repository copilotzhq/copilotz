/**
 * Which tier applies where (`modelChoice`): the org's (`_id: "org"`, with
 * `cap`, the highest tier its members may choose), a space's (`space:<id>`),
 * a conversation's (`thread:<id>`) and a person's own default for new chats
 * (`person:<id>`), which also keeps the order their plans run in
 * (`harnesses`). Each a tier by its name, never a copy: changing a tier
 * moves everyone on it. Changed only through `tiers.choose`, `tiers.cap` and
 * `tiers.harnesses`, which say who may; read by `_id`, so a turn's asking costs what the owner
 * has cached.
 *
 * Queries, for front ends, as the person looking:
 * - `offered` `{ space?, thread? }`: the org's tiers with each kind of
 *   work's chain and a typical message's price at this org's prices, the
 *   kinds and the app's agents of each, what each level chose, and what
 *   applies there. Anyone in the org reads it; a space's and a
 *   conversation's, those who reach them.
 * - `agent` `{ agent, space?, thread? }`: one agent there: its kind, the tier
 *   in force and its chain in it.
 * - `harnesses` `{}`: the app's plans the person looking orders (those a
 *   tier's model runs on), in their order, each with whether they have it.
 */
import { defineCollection, forbidden, people, type ReadContext } from "copilotz";
import { harnessesShown } from "../shared/plans.ts";
import { agentAt, shownAt } from "../shared/shown.ts";

const choiceSchema = {
  type: "object",
  properties: {
    /** The space or conversation it's for, or the person whose default it is; none: the org's. */
    space: { type: "string" },
    thread: { type: "string" },
    person: { type: "string" },
    /** A tier by its name; none: the one above. */
    tier: { type: "string" },
    /** The org's: the highest tier its members may choose; none: any. */
    cap: { type: "string" },
    /** A person's: the order their plans run in (providers with `harness`); none: the app's. */
    harnesses: { type: "array", items: { type: "string" } },
    at: { type: "string" },
  },
  required: ["at"],
} as const;

export type ModelChoice = {
  _id: string;
  space?: string;
  thread?: string;
  person?: string;
  tier?: string;
  cap?: string;
  harnesses?: string[];
  at: string;
};

/** Only someone who reaches the space or the conversation reads what it chose: the rules say. */
async function reached(ctx: ReadContext, where: { space?: string; thread?: string }) {
  if (where.space && !await ctx.db.collection("space").findOne({ _id: where.space })) {
    throw forbidden("You can't read that space.");
  }
  if (where.thread && !await ctx.db.collection("thread").findOne({ _id: where.thread })) {
    throw forbidden("You can't read that conversation.");
  }
}

export const modelChoice = defineCollection({
  schema: choiceSchema,
  queries: {
    offered: {
      allow: people,
      run: async (_, params: { space?: string; thread?: string }, ctx) => {
        const where = {
          ...(params.space ? { space: params.space } : {}),
          ...(params.thread ? { thread: params.thread } : {}),
        };
        await reached(ctx, where);
        return await shownAt(ctx, where);
      },
    },
    agent: {
      allow: people,
      run: async (_, params: { agent: string; space?: string; thread?: string }, ctx) => {
        const where = {
          ...(params.space ? { space: params.space } : {}),
          ...(params.thread ? { thread: params.thread } : {}),
        };
        await reached(ctx, where);
        return await agentAt(ctx, params.agent, where);
      },
    },
    harnesses: { allow: people, run: (_, __, ctx) => harnessesShown(ctx) },
  },
});
