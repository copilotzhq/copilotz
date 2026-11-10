/**
 * People, as sign-in knows them: `person.set` keeps what a sign-in method
 * verified about someone (their email, their name), and `person.email` says
 * the email someone proved, for plugins that match people by it (an
 * invitation). Both are the system's: a person never sets their own email.
 * Their name is theirs, though (`person.rename`): once they've chosen it (or
 * chosen none), sign-ins keep it as they left it.
 */
import { defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import type { Person } from "../collections/person.ts";

/** The longest name someone gives themselves, in characters, once it's one line. */
const LONGEST = 80;

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
        // A name they chose themselves stays.
        ...(input.name && !known?.named ? { name: input.name } : {}),
        ...(input.picture ? { picture: input.picture } : {}),
        at: known?.at ?? new Date().toISOString(),
      },
    }, { upsert: true });
    return { new: !known };
  },
});

/**
 * `person.rename` `{ name }`: the name a person goes by, which everyone sees
 * (their menu, home's greeting, the people beside them, agents). Theirs
 * alone: always their own, never through a key or an agent. One line (runs
 * of spaces, tabs and breaks are one space), trimmed; empty, they have none.
 */
export const renamePerson = defineAction({
  description: "Sets the name you go by; an empty one clears it",
  input: {
    type: "object",
    // Room for the spaces around it; the name itself is checked below, in words people read.
    properties: { name: { type: "string", maxLength: 200 } },
    required: ["name"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const name = input.name.replace(/[\s\p{Cc}]+/gu, " ").trim();
    if ([...name].length > LONGEST) {
      throw failure("invalid", `A name is at most ${LONGEST} characters.`, { public: true });
    }
    const people = ctx.as().db.collection<Person>("person");
    const known = await people.findOne({ _id: ctx.actor!.id });
    const now = new Date().toISOString();
    await people.updateOne({ _id: ctx.actor!.id }, {
      $set: { ...(name ? { name } : {}), named: now, at: known?.at ?? now },
      ...(name ? {} : { $unset: { name: "" } }),
    }, { upsert: true });
    return { name: name || null };
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
