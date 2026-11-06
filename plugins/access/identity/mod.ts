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
 * A browser keeps its session in an httpOnly, Secure cookie (`session`,
 * `__Host-session` wherever it's Secure): a sign-in route sets it from a
 * sign-in's session (`signedIn`), this plugin's `who` says who it is
 * (`credential.actor`), and `POST /signout` ends it (see routes/session.ts);
 * a key goes in an Authorization header. Secrets are kept only as hashes;
 * deleting a credential revokes it.
 *
 * A sign-in method keeps what it verified about someone (`person.set`: their
 * email), and plugins that match people by email ask for it (`person.email`).
 * Each person reads only their own: nobody learns who else has an account.
 */
import { type Actor, definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { createKey, revokeKey } from "./actions/key.ts";
import { emailOf, setPerson } from "./actions/person.ts";
import { endSession, revokeCredentials, startSession } from "./actions/session.ts";
import { credential } from "./collections/credential.ts";
import { person } from "./collections/person.ts";
import { SESSION } from "./contract.ts";
import { me, signOut } from "./routes/session.ts";

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
  // A request is the person its session cookie proves. The cookie is the host's alone
  // (`__Host-session` wherever it's Secure): no other host under the domain (a preview's) can put
  // a session of its choosing in its place.
  who: (_request, { cookies, query }) => {
    const secret = cookies.get(SESSION);
    return secret ? query<Actor | null>("credential.actor", { secret }) : null;
  },
  routes: { "/signout": signOut, "/me": me },
  // Each person sees only themselves, and their own credentials: nobody else does, whatever their id.
  guard: (actor, { collection }) => {
    if (collection !== "credential" && collection !== "person") return undefined;
    if (actor.kind !== "person") return { _id: { $in: [] } };
    return collection === "credential" ? { person: actor.id } : { _id: actor.id };
  },
});
