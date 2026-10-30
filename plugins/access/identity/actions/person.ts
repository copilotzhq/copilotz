/**
 * People, as sign-in knows them: `person.set` keeps what a sign-in method
 * verified about someone (their email, their name), and `person.email` says
 * the email someone proved, for plugins that match people by it (an
 * invitation). Both are the system's: a person never sets their own email.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Person } from "../collections/person.ts";

export const setPerson = defineAction({
  description: "Keeps what a sign-in verified about a person: their email, their name",
  input: {
    type: "object",
    properties: {
      person: { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
      picture: { type: "string" },
    },
    required: ["person"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const people = ctx.db.collection<Person>("person");
    const known = await people.findOne({ _id: input.person });
    await people.updateOne({ _id: input.person }, {
      $set: {
        ...(input.email ? { email: input.email.trim().toLowerCase() } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.picture ? { picture: input.picture } : {}),
        at: known?.at ?? new Date().toISOString(),
      },
    }, { upsert: true });
    return { new: !known };
  },
});

export const emailOf = defineAction({
  description: "The email a person proved when they signed in, if any",
  input: {
    type: "object",
    properties: { person: { type: "string" } },
    required: ["person"],
    additionalProperties: false,
  },
  record: false,
  run: async (ctx, input) => {
    const found = await ctx.as().db.collection<Person>("person").findOne({ _id: input.person });
    return { email: found?.email?.toLowerCase() ?? null };
  },
});
