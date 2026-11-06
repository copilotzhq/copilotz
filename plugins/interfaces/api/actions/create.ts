/**
 * `api_key.create`: a person makes a key for code that calls the app as
 * them, in one space they reach, for what its scope lists. It's made a
 * member of that space (`key:<id>`), an editor when it may call or write,
 * else a viewer. The secret is returned once and kept nowhere: this call
 * isn't recorded (an Action's result goes in the log), and the key's record
 * keeps only its hash, which neither the log (`api_key.created`: who made
 * it, when) nor anyone outside reads. A key can't make keys.
 */
import { defineAction, forbidden, inPerson, invalid, type Scope } from "../../../../runtime/mod.ts";
import { may } from "../../../access/spaces/contract.ts";
import type { StoredKey } from "../collections/key.ts";
import { roleOf } from "../shared/actor.ts";
import { hash, secret } from "../shared/secret.ts";

/** Names of what a key may use, exactly: `chat.send`, `message.conversation`, `thread`, `note`. */
const names = {
  type: "array",
  maxItems: 200,
  uniqueItems: true,
  items: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,120}$" },
} as const;

const KINDS = ["call", "query", "view", "read", "write"] as const;

export const createAction = defineAction({
  description: "Makes a developer key that acts as you in one space; its secret is shown once",
  input: {
    type: "object",
    properties: {
      /** The space it works in. */
      in: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1, maxLength: 80 },
      /** What it may use: Actions it calls, queries, Views, collections it reads and writes. */
      scope: {
        type: "object",
        properties: { call: names, query: names, view: names, read: names, write: names },
        additionalProperties: false,
      },
    },
    required: ["in", "name", "scope"],
    additionalProperties: false,
  },
  record: false,
  allow: inPerson,
  run: async (ctx, input) => {
    const name = input.name.trim();
    if (!name) throw invalid("A key needs a name, to know it by.");
    // Only the lists it has: a key's scope says what it may use, and nothing else.
    const scope: Scope = Object.fromEntries(
      KINDS.flatMap((kind) => input.scope[kind]?.length ? [[kind, input.scope[kind]]] : []),
    );
    if (!Object.keys(scope).length) {
      throw invalid("A key does something: pick at least one Action, query, View or collection.");
    }
    // Only in a space they reach: read as them, under the rules.
    if (!await ctx.db.collection("space").findOne({ _id: input.in })) {
      throw forbidden("You aren't in that space.");
    }
    const role = roleOf(scope);
    // A key does at most what its person may: one that changes things, where they do.
    if (role === "editor" && !await may(ctx, "write", input.in)) {
      throw forbidden(
        "You only read in this space: a key of yours can only read here too. Pick queries alone.",
      );
    }
    const made = secret();
    const hashed = await hash(made);
    const key: StoredKey = {
      _id: hashed.slice(0, 12),
      hash: hashed,
      person: ctx.actor!.id,
      in: input.in,
      name,
      hint: made.slice(0, 8),
      role,
      scope,
      at: new Date().toISOString(),
    };
    const system = ctx.as();
    await system.db.collection("api_key").insertOne(key);
    try {
      // A member of its space, as the spaces plugin seats one.
      await system.call("member.set", {
        space: input.in,
        member: { kind: "key", id: key._id },
        role,
      });
    } catch (error) {
      await system.db.collection("api_key").deleteOne({ _id: key._id });
      throw error;
    }
    return { key: made, id: key._id, hint: key.hint, role };
  },
});
