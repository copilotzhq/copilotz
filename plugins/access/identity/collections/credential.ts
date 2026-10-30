/**
 * Credentials: what a connection shows to be someone. A session (from a
 * sign-in) or a key (made by a person, for code acting as them). Only a
 * hash of each secret is kept: the secret is shown once, when it's made.
 * Deleting one revokes it.
 */
import { defineCollection, type Infer } from "../../../../runtime/mod.ts";

const credentialSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["session", "key"] },
    /** Whom it proves. */
    person: { type: "string" },
    /** A key's name, so its person knows it again. */
    name: { type: "string" },
    /** The first characters of its secret, to tell keys apart. */
    hint: { type: "string" },
    expires: { type: "string" },
    /** A session of platform staff's, who reach the whole org. */
    staff: { type: "boolean" },
    at: { type: "string" },
  },
  required: ["kind", "person", "at"],
} as const;

export const credential = defineCollection({
  schema: credentialSchema,
  indexes: [["person"]],
  queries: {
    /**
     * Who a secret proves, if anyone: a person (`key` says which of their
     * keys). Hosts ask once per connection.
     */
    actor: async (credentials, params: { secret: string }) => {
      const found = await credentials.findOne({ _id: await hash(params.secret) });
      if (!found || (found.expires && found.expires < new Date().toISOString())) return null;
      return {
        kind: "person",
        id: found.person,
        ...(found.kind === "key" ? { key: found._id.slice(0, 12) } : {}),
        ...(found.staff ? { staff: true } : {}),
      };
    },
    /** A person's keys, without their secrets. */
    keys: {
      allow: (actor) => actor.kind === "person",
      run: (credentials, params: { person: string }) =>
        credentials.find({ person: params.person, kind: "key" }, { sort: { at: 1 } }),
    },
  },
});

export type Credential = Infer<typeof credentialSchema> & { _id: string };

/** A secret as it's kept: its SHA-256, hex. */
export async function hash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new secret: 32 random bytes, base64url, with a prefix saying what it is. */
export function secret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  }`;
}
