/**
 * Developer keys: what code shows to call the app (`Authorization: Bearer
 * <key>`). A key is its person's, works in one space (`in`) and does only
 * what it lists: Actions, queries and Views by name. Only a hash of its
 * secret is kept (its `_id`): the secret is shown once, when it's made.
 * Deleting one revokes it. Each person reads only their own.
 *
 * Shaped to fold into the identity plugin's credentials (a key there, with
 * `in` and the lists), so the two never differ in meaning.
 */
import { defineCollection, type Infer, inPerson } from "../../../../runtime/mod.ts";
import { hash } from "../shared/secret.ts";
import { isKey, type KeyActor } from "../shared/actor.ts";

const names = { type: "array", items: { type: "string" } } as const;

const keySchema = {
  type: "object",
  properties: {
    /** Whom it acts as. */
    person: { type: "string" },
    /** The space it works in: what it reaches, and where what it makes goes. */
    in: { type: "string" },
    /** What its person calls it ("Support bot"). */
    name: { type: "string" },
    /** The first characters of its secret, to tell keys apart. */
    hint: { type: "string" },
    /** What it may do: Actions, queries (`message.conversation`) and Views (`thread`), by name. */
    actions: names,
    queries: names,
    views: names,
    /** When it was last used (to the minute). */
    used: { type: "string" },
    at: { type: "string" },
  },
  required: ["person", "in", "name", "hint", "actions", "queries", "at"],
} as const;

export type ApiKey = Infer<typeof keySchema> & { _id: string };

/** What a secret proves: the key, and who calling with it is. */
export type Proven = { key: ApiKey; actor: KeyActor };

export const apiKey = defineCollection({
  schema: keySchema,
  indexes: [["person"]],
  queries: {
    /** The asker's keys (in a space, with `in`), newest first, without their secrets. */
    mine: {
      allow: inPerson,
      run: (keys, params: { in?: string } = {}) =>
        keys.find(params.in ? { in: params.in } : {}, { sort: { at: -1 } }),
    },
    /**
     * What a secret proves, if anything: the key and who calling with it is
     * (its person, narrowed to its space). The system's: the API asks it once
     * per request.
     */
    actor: async (keys, params: { secret: string }): Promise<Proven | null> => {
      const found = await keys.findOne({ _id: await hash(String(params.secret ?? "")) });
      if (!found) return null;
      return {
        key: found as ApiKey,
        actor: { kind: "person", id: found.person, key: found._id.slice(0, 12), within: found.in },
      };
    },
    /**
     * Documents of a collection by id, as the asker reads them (the rules,
     * without private fields): what the API's event stream shows of a change.
     */
    see: {
      allow: (actor) => isKey(actor),
      run: (_, params: { collection: string; ids: string[] }, ctx) =>
        ctx.db.collection(String(params.collection)).find({
          _id: { $in: (params.ids ?? []).map(String) },
        }),
    },
  },
});
