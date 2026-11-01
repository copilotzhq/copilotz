/**
 * `api_key.create`: a person makes a key for code that calls the app as
 * them, in one space they reach, doing only what it lists. The secret is
 * returned once and kept nowhere: this call isn't recorded (an Action's
 * result goes in the log), and the key's record (`api_key.created`, who
 * made it, when) holds its hash. A key can't make keys.
 */
import { defineAction, inPerson, invalid } from "../../../../runtime/mod.ts";
import { hash, secret } from "../shared/secret.ts";

/** Names of what a key may do: `chat.send`, `message.conversation`, `thread`. */
const names = {
  type: "array",
  maxItems: 200,
  uniqueItems: true,
  items: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,120}$" },
} as const;

export const createAction = defineAction({
  description: "Makes a developer key that acts as you in one space; its secret is shown once",
  input: {
    type: "object",
    properties: {
      /** The space it works in. */
      in: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1, maxLength: 80 },
      actions: names,
      queries: names,
      views: names,
    },
    required: ["in", "name"],
    additionalProperties: false,
  },
  record: false,
  allow: inPerson,
  run: async (ctx, input) => {
    const name = input.name.trim();
    if (!name) throw invalid("A key needs a name, to know it by.");
    const lists = {
      actions: input.actions ?? [],
      queries: input.queries ?? [],
      views: input.views ?? [],
    };
    if (!lists.actions.length && !lists.queries.length && !lists.views.length) {
      throw invalid("A key does something: pick at least one Action, query or View.");
    }
    // Only in a space they reach: read as them, under the rules.
    if (!await ctx.db.collection("space").findOne({ _id: input.in })) {
      throw Object.assign(new Error("You aren't in that space."), { code: "forbidden" });
    }
    const made = secret();
    const id = await hash(made);
    await ctx.db.collection("api_key").insertOne({
      _id: id,
      person: ctx.actor!.id,
      in: input.in,
      name,
      hint: made.slice(0, 8),
      ...lists,
      at: new Date().toISOString(),
    });
    return { key: made, id, hint: made.slice(0, 8) };
  },
});
