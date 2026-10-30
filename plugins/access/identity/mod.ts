/**
 * Identity: who people are and what proves it. People sign in with a
 * method (a plugin, such as Google's), which makes a session; people make
 * keys for code acting as them. Hosts ask who a secret proves once per
 * connection, and act as that:
 *
 * ```ts
 * const actor = await runtime.query("credential.actor", { secret });  // null: nobody
 * await runtime.call("chat.send", { text }, { actor });
 * ```
 *
 * A browser keeps its session in an httpOnly, Secure cookie its host sets
 * from `session.start`'s result; a key goes in an Authorization header.
 * Secrets are kept only as hashes; deleting a credential revokes it.
 *
 * A sign-in method keeps what it verified about someone (`person.set`: their
 * email), and plugins that match people by email ask for it (`person.email`).
 * Each person reads only their own: nobody learns who else has an account.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { createKey, revokeKey } from "./actions/key.ts";
import { emailOf, setPerson } from "./actions/person.ts";
import { endSession, revokeCredentials, startSession } from "./actions/session.ts";
import { credential } from "./collections/credential.ts";
import { person } from "./collections/person.ts";

export * from "./contract.ts";
export { hash } from "./collections/credential.ts";

export const identity: Plugin = definePlugin({
  name: "identity",
  collections: { person, credential },
  actions: {
    "session.start": startSession,
    "session.end": endSession,
    "credential.revoke": revokeCredentials,
    "key.create": createKey,
    "key.revoke": revokeKey,
    "person.set": setPerson,
    "person.email": emailOf,
  },
  // Each person sees only themselves, and their own credentials.
  guard: (actor, { collection }) =>
    collection === "credential"
      ? { person: actor.id }
      : collection === "person"
      ? { _id: actor.id }
      : undefined,
});
