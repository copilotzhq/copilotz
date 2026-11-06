/**
 * Developer keys: what code shows to call the app (`Authorization: Bearer
 * <key>`). A key is its person's, a member of one space (`in`, as
 * `key:<id>`, with its `role`), and may use only what its `scope` lists:
 * Actions, queries and Views, and collections read and written directly, by
 * name. Its id is the start of its secret's hash, and only that hash is kept
 * (`hash`, never read from outside): the secret is shown once, when it's made.
 *
 * Its record lives in its space (the spaces plugin's `shared`): whoever reads
 * the space sees its keys, and its managers revoke them; a key itself, or an
 * agent working for one, never reads or changes a key (shared/rules.ts).
 */
import { defineCollection, type Infer, inPerson, type Scope } from "../../../../runtime/mod.ts";
import { hash } from "../shared/secret.ts";
import { isKey, type KeyActor } from "../shared/actor.ts";

const names = { type: "array", items: { type: "string" } } as const;

/** The spaces plugin's own records, which live in spaces too (a space, its memberships…). */
export const PLACED = new Set(["space", "member", "request", "invitation"]);

const keySchema = {
  type: "object",
  properties: {
    /** The SHA-256 of its secret, hex: what a secret is looked up by. */
    hash: { type: "string" },
    /** Whom it acts as. */
    person: { type: "string" },
    /** The space it's a member of: what it reaches, and where what it makes goes. */
    in: { type: "string" },
    /** What its person calls it ("Support bot"). */
    name: { type: "string" },
    /** The first characters of its secret, to tell keys apart. */
    hint: { type: "string" },
    /** Its role in its space, as its scope says: `editor` when it calls or writes, else `viewer`. */
    role: { type: "string", enum: ["editor", "viewer"] },
    /** What it may use, by exact name. */
    scope: {
      type: "object",
      properties: { call: names, query: names, view: names, read: names, write: names },
      additionalProperties: false,
    },
    /** When it was last used (to the minute). */
    used: { type: "string" },
    at: { type: "string" },
  },
  required: ["hash", "person", "in", "name", "hint", "role", "scope", "at"],
} as const;

/** A key as it's read from outside: everything but its hash. */
export type ApiKey = {
  _id: string;
  person: string;
  in: string;
  name: string;
  hint: string;
  role: "editor" | "viewer";
  scope: Scope;
  used?: string;
  at: string;
};

/** A key as it's kept. */
export type StoredKey = Infer<typeof keySchema> & ApiKey;

/** A key's actor: its person, with which key it is and what it may use. */
export const actorOf = (key: Pick<ApiKey, "_id" | "person" | "scope">): KeyActor => ({
  kind: "person",
  id: key.person,
  key: key._id,
  scope: key.scope,
});

export const apiKey = defineCollection({
  schema: keySchema,
  indexes: [["hash"], ["person"], ["in"]],
  private: ["hash"],
  queries: {
    /** The asker's own keys (in a space, with `in`), newest first. */
    mine: {
      allow: inPerson,
      run: (keys, params: { in?: string } = {}, ctx) =>
        keys.find(
          { person: ctx.actor?.id ?? "", ...(params.in ? { in: params.in } : {}) },
          { sort: { at: -1 } },
        ),
    },
    /**
     * Who a secret proves, if anyone: the key's person, with the key and its
     * scope. The system's: the API asks it once per request.
     */
    actor: async (keys, params: { secret: string }): Promise<KeyActor | null> => {
      const found = await keys.findOne({ hash: await hash(String(params.secret ?? "")) });
      return found ? actorOf(found as StoredKey) : null;
    },
    /** A key by its id, without its hash: what the API says of the key calling. The system's. */
    get: async (keys, params: { key: string }): Promise<ApiKey | null> => {
      const found = await keys.findOne({ _id: String(params.key ?? "") });
      if (!found) return null;
      const { hash: _, ...key } = found as Record<string, unknown>;
      return key as ApiKey;
    },
    /**
     * Documents of a collection that lives in spaces, by id, as a key reads
     * them (the rules, without private fields): what the API's event stream
     * shows of a change. Only as the stream asks it, for the key without its
     * scope (the stream follows the rules): a key calling with its own scope
     * never runs it.
     */
    see: {
      allow: (actor) => isKey(actor) && actor.scope === undefined,
      run: (_, params: { collection: string; ids: string[] }, ctx) => {
        const collection = String(params.collection);
        const shared = (ctx.resources.shared ?? {}) as Record<string, unknown>;
        if (!PLACED.has(collection) && !Object.hasOwn(shared, collection)) return [];
        return ctx.db.collection(collection).find({
          _id: { $in: (params.ids ?? []).map(String) },
        });
      },
    },
  },
});
