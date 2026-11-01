/**
 * Keys: a person makes one for code that acts as them (a script, a CI job),
 * sees its secret once, and revokes it by name.
 */
import { defineAction, inPerson, people } from "../../../../runtime/mod.ts";
import { hash, secret } from "../collections/credential.ts";

export const createKey = defineAction({
  description: "Makes a key that acts as you; its secret is shown once",
  // Unrecorded: its result is the secret, which must never land in the log.
  record: false,
  input: {
    type: "object",
    properties: { name: { type: "string", minLength: 1 } },
    required: ["name"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const made = secret("key");
    await ctx.as().db.collection("credential").insertOne({
      _id: await hash(made),
      kind: "key",
      person: ctx.actor!.id,
      name: input.name,
      hint: made.slice(0, 8),
      at: new Date().toISOString(),
    });
    return { key: made };
  },
});

export const revokeKey = defineAction({
  description: "Revokes one of your keys, by name",
  input: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const removed = await ctx.as().db.collection("credential").deleteMany({
      person: ctx.actor!.id,
      kind: "key",
      name: input.name,
    });
    return { revoked: removed.acknowledged ? removed.deletedCount : 0 };
  },
});
