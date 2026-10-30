/**
 * Sessions: `session.start` makes one for a person a sign-in method has
 * verified (the system calls it: a sign-in plugin's Action, never a person);
 * `session.end` ends the one a person shows.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { hash, secret } from "../collections/credential.ts";

/** How long a session lasts unless its sign-in says (30 days). */
const LASTS = 30 * 86_400_000;

export const startSession = defineAction({
  description: "Starts a session for a verified person; its secret is returned once",
  input: {
    type: "object",
    // `staff`: platform staff entering an org, who reach all of it (on the record as them).
    properties: { person: { type: "string" }, ms: { type: "number" }, staff: { type: "boolean" } },
    required: ["person"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const made = secret("ses");
    const now = Date.now();
    await ctx.db.collection("credential").insertOne({
      _id: await hash(made),
      kind: "session",
      person: input.person,
      hint: made.slice(0, 8),
      ...(input.staff ? { staff: true } : {}),
      expires: new Date(now + (input.ms ?? LASTS)).toISOString(),
      at: new Date(now).toISOString(),
    });
    return { session: made };
  },
});

export const endSession = defineAction({
  description: "Ends the session whose secret is shown",
  input: {
    type: "object",
    properties: { session: { type: "string" } },
    required: ["session"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const ended = await ctx.as().db.collection("credential").deleteOne({
      _id: await hash(input.session),
      person: ctx.actor!.id,
      kind: "session",
    });
    return { ended: ended.acknowledged ? ended.deletedCount : 0 };
  },
});

export const revokeCredentials = defineAction({
  description: "Ends every session and key of a person: they're out, wherever they're signed in",
  input: {
    type: "object",
    properties: { person: { type: "string" } },
    required: ["person"],
    additionalProperties: false,
  },
  // No `allow`: the system's (taking someone out of an org).
  run: async (ctx, input) => {
    const ended = await ctx.db.collection("credential").deleteMany({ person: input.person });
    return { ended: ended.deletedCount };
  },
});
