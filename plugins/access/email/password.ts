/**
 * Password sign-in: people sign in by an identifier (a username, a badge
 * number, a CPF) and a password, with the identity plugin. For staff and
 * back-office apps, whose accounts an admin makes, or an import brings:
 * nobody signs up, and there's no email to reset by.
 *
 * - **Accounts** are trusted code's: `password.set` `{ person, identifier,
 *   password?, name? }` makes or changes one (an admin's screen calls it
 *   through an Action of the app's that says who may), `password.import`
 *   brings one with the hash another app kept (bcrypt's `$2a$`, `$2b$`,
 *   `$2y$`; hashed again our way at the first sign-in), and
 *   `password.remove` takes one away, with every session.
 * - **Signing in:** `password.sign-in` `{ identifier, password }`, one
 *   refusal for anything wrong (`unauthorized`), as slow for an identifier
 *   nobody has. An identifier is read without spaces and case, and without
 *   what the `passwordSignIn` resource says to `ignore` (`".-/"` for a CPF).
 * - **A new password:** the person signed in changes theirs
 *   (`password.change`, with the one they have); an admin sets one
 *   (`password.set`). Either ends their other sessions.
 *
 * It shares email sign-in's password hashing (PBKDF2-SHA256 in stages) and
 * its limits: tries at an identifier, and what one caller asks, in 15
 * minutes (`passwordSignIn.limits`). Hashes are a private field; Actions
 * whose input or answer holds a secret are unrecorded; only the system
 * reads its collections. Its routes: `GET /signin/password` (it's here, for
 * the page, which then offers it) and `POST /signin/password`, which sets the
 * session's cookie, and `POST /signin/password/change`.
 *
 * ```ts
 * plugins: [...access, passwordSignIn, definePlugin({
 *   name: "app",
 *   resources: { passwordSignIn: { ignore: ".-/" } },
 * })]
 * await runtime.call("password.set", { person: "emp-7", identifier: "ana", password, name: "Ana" });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { passwordChangeAction, passwordSignInAction } from "./actions/password-sign-in.ts";
import {
  passwordImportAction,
  passwordRemoveAction,
  passwordSetAction,
} from "./actions/password-accounts.ts";
import { passwordPruneAction } from "./actions/prune.ts";
import { passwordLogin } from "./collections/password-login.ts";
import { rate } from "./collections/rate.ts";
import { passwordChangeRoute, passwordRoute } from "./routes/password.ts";

/** Only the system reads or writes these: identifiers' hashes, and counters. */
const SYSTEM_ONLY = ["password_login", "password_rate"];

export const passwordSignIn: Plugin = definePlugin({
  name: "password-sign-in",
  requires: ["identity"],
  collections: { password_login: passwordLogin, password_rate: rate },
  actions: {
    "password.sign-in": passwordSignInAction,
    "password.change": passwordChangeAction,
    "password.set": passwordSetAction,
    "password.import": passwordImportAction,
    "password.remove": passwordRemoveAction,
    "password.prune": passwordPruneAction,
  },
  schedules: { "password.prune": { every: "10m", call: "password.prune", input: {} } },
  routes: { "/signin/password": passwordRoute, "/signin/password/change": passwordChangeRoute },
  resources: { passwordSignIn: {} },
  // Nobody but the system reads or writes them: every actor's ops find nothing.
  guard: (_actor, { collection }) =>
    SYSTEM_ONLY.includes(collection) ? { _id: { $in: [] } } : undefined,
});
