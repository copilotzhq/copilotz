/**
 * Identity: who people are and what proves it. People sign in with a
 * method (a plugin, such as Google's), which makes a session. (Code acting
 * as someone calls with a developer key, the api plugin's: every key has a
 * scope.) Hosts ask who a secret proves once per connection, and act as
 * that:
 *
 * ```ts
 * const actor = await runtime.query("credential.actor", { secret });  // null: nobody
 * await runtime.call("chat.send", { text }, { actor });
 * ```
 *
 * A browser keeps its session in an httpOnly, Secure cookie (`session`,
 * `__Host-session` wherever it's Secure): a sign-in route sets it from a
 * sign-in's session (`signedIn`), this plugin's `who` says who it is
 * (`credential.actor`), and `POST /signout` ends it (see routes/session.ts).
 * Secrets are kept only as hashes; deleting a credential revokes it. People
 * and credentials change only through these Actions, never directly from
 * outside (`direct`): a session proves someone, and an email is what
 * invitations find people by.
 *
 * A sign-in method keeps what it verified about someone (`person.set`: their
 * email), and plugins that match people by email ask for it (`person.email`).
 * Each person reads only their own: nobody learns who else has an account.
 */
import { type Actor, definePlugin, failure, type Plugin } from "../../../runtime/mod.ts";
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
  // Nobody outside changes either directly.
  guard: (actor, { collection, access, direct }) => {
    if (collection !== "credential" && collection !== "person") return undefined;
    if (direct && access === "write") {
      throw failure("forbidden", "People and their sessions change through their Actions.", {
        public: true,
      });
    }
    if (actor.kind !== "person") return { _id: { $in: [] } };
    return collection === "credential" ? { person: actor.id } : { _id: actor.id };
  },
});
