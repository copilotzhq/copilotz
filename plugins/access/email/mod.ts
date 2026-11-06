/**
 * Email: sending it, and signing in with it.
 *
 * **`email`** is the app's email port: `email.send` `{ to, subject, text,
 * html? }` (trusted code's, unrecorded) sends through the adapter the
 * `email` resource names: `resend` (Resend's API, with its `apiKey`), or
 * `console`, which writes each message to the log, for a laptop (an app
 * whose `links` origin is public doesn't start with it). An adapter of
 * your own is an `email` adapter (`EmailAdapter`, in the contract).
 *
 * **`emailSignIn`** (with identity and `email`) signs people in with an
 * email and a password:
 *
 * - **Making an account:** `email.sign-up` sends a six-digit code, its
 *   password waiting for it; `email.verify` with the code makes the account
 *   and signs in. An address that has one gets a word saying so instead,
 *   with the same answer. `signUp: false` leaves only invitations.
 * - **Signing in:** `email.sign-in`, refused with `unverified` (and a new
 *   code sent) for an address not confirmed yet, the page's cue to ask for
 *   the code.
 * - **A new password:** `email.forgot` sends a code, answering the same for
 *   an address nobody has; `email.reset` with it sets the password, ends
 *   every other session and signs in.
 * - **Invitations:** trusted code (a webhook, once someone bought) calls
 *   `email.invite` for an address: its person, answered at once, and a link
 *   that works once for a day (`/#email-invite=<token>`), where they choose
 *   a password and arrive signed in (`email.accept`).
 * - **Moving in:** `email.import` brings a person with their password's
 *   hash as another app kept it (legacy `salt:hash` hex, PBKDF2-SHA256 at
 *   100,000), made stronger at their first sign-in.
 *
 * Passwords are hashed with PBKDF2-SHA256 on WebCrypto, in six stages of
 * 100,000 (workerd's most for one): `pbkdf2-sha256$6x100000$<salt>$<hash>`
 * (see shared/password.ts). Codes and links' tokens are kept only as HMACs
 * under the app's secret (`links.secret`), each used once, codes for 15
 * minutes and five wrong tries. Messages to an address, tries at it, and
 * what one caller asks are limited (`too_many`). Hashes are a private field
 * (no event, no actor's read), and every Action whose input or answer holds
 * a secret is unrecorded. Only the system reads the plugin's collections.
 *
 * Its routes (see routes/sign-in.ts) are `GET /signin/email`, which tells
 * the page it's here, `POST /signin/email` and its steps under it, each one
 * that ends signed in setting the session's cookie (identity's `signedIn`).
 * The page's sign-in screen offers it.
 *
 * ```ts
 * plugins: [...access, email, emailSignIn, definePlugin({
 *   name: "app",
 *   resources: {
 *     links: { origin: "https://app.example.com", secret: env.LINKS_SECRET },
 *     email: { adapter: "resend", from: "App <noreply@example.com>", apiKey: env.RESEND_API_KEY },
 *     emailSignIn: { app: "App", messages: { verify: { subject: "{code} é o seu código" } } },
 *   },
 * })]
 * const { person } = await runtime.call("email.invite", { email: "ana@example.com" });
 * ```
 */
import { definePlugin, linksOf, nearby, type Plugin } from "../../../runtime/mod.ts";
import { importAction } from "./actions/import.ts";
import { acceptAction, invitationAction, inviteAction } from "./actions/invite.ts";
import { pruneAction } from "./actions/prune.ts";
import { forgotAction, resetAction } from "./actions/reset.ts";
import { sendAction } from "./actions/send.ts";
import { signInAction } from "./actions/sign-in.ts";
import { signUpAction, verifyAction } from "./actions/sign-up.ts";
import { consoleEmail } from "./adapters/console.ts";
import { resend } from "./adapters/resend.ts";
import { code } from "./collections/code.ts";
import { login } from "./collections/login.ts";
import { rate } from "./collections/rate.ts";
import { MESSAGES } from "./resources/messages.ts";
import {
  acceptRoute,
  forgotRoute,
  invitationRoute,
  resetRoute,
  signInRoute,
  signUpRoute,
  verifyRoute,
} from "./routes/sign-in.ts";
import type { EmailSettings } from "./contract.ts";

export * from "./contract.ts";
export { hashPassword, verifyPassword } from "./shared/password.ts";
export { INVITE_FRAGMENT } from "./actions/invite.ts";

/** The app's origin, when its `links` resource says it's somewhere public (not this machine's network). */
const publicOrigin = (resources: Record<string, unknown>): string | undefined => {
  const origin = (resources.links as { origin?: unknown } | undefined)?.origin;
  if (typeof origin !== "string" || !origin) return undefined;
  try {
    return nearby(new URL(origin).hostname) ? undefined : origin;
  } catch {
    return origin;
  }
};

export const email: Plugin = definePlugin({
  name: "email",
  actions: { "email.send": sendAction },
  adapters: { email: { resend, console: consoleEmail } },
  check(merged) {
    const settings = merged.resources.email as Partial<EmailSettings> | undefined;
    const adapters = Object.keys(merged.adapters.email ?? {});
    if (!settings?.adapter || !adapters.includes(settings.adapter)) {
      throw new Error(
        `set the email resource's adapter: ${adapters.join(" or ")} (console on a laptop)`,
      );
    }
    if (settings.adapter === "resend" && (!settings.apiKey || !settings.from)) {
      throw new Error("the email resource's resend adapter needs its apiKey and from");
    }
    const origin = publicOrigin(merged.resources);
    if (settings.adapter === "console" && origin) {
      throw new Error(
        `the console email adapter writes codes to the log, for a laptop, but the app's links ` +
          `origin (${origin}) is public: send with resend (or an adapter of your own)`,
      );
    }
  },
});

/** Only the system reads or writes these: addresses' hashes, codes and links waiting, counters. */
const SYSTEM_ONLY = ["email_login", "email_code", "email_rate"];

export const emailSignIn: Plugin = definePlugin({
  name: "email-sign-in",
  requires: ["identity", "email"],
  collections: { email_login: login, email_code: code, email_rate: rate },
  actions: {
    "email.sign-up": signUpAction,
    "email.verify": verifyAction,
    "email.sign-in": signInAction,
    "email.forgot": forgotAction,
    "email.reset": resetAction,
    "email.invite": inviteAction,
    "email.invitation": invitationAction,
    "email.accept": acceptAction,
    "email.import": importAction,
    "email.prune": pruneAction,
  },
  schedules: { "email.prune": { every: "10m", call: "email.prune", input: {} } },
  routes: {
    "/signin/email": signInRoute,
    "/signin/email/sign-up": signUpRoute,
    "/signin/email/verify": verifyRoute,
    "/signin/email/forgot": forgotRoute,
    "/signin/email/reset": resetRoute,
    "/signin/email/invitation": invitationRoute,
    "/signin/email/accept": acceptRoute,
  },
  resources: { emailSignIn: { messages: MESSAGES } },
  // Nobody but the system reads or writes them: every actor's ops find nothing.
  guard: (_actor, { collection }) =>
    SYSTEM_ONLY.includes(collection) ? { _id: { $in: [] } } : undefined,
  check(merged) {
    if (!linksOf(merged.resources)) {
      throw new Error(
        "emailSignIn needs the links resource ({ origin, secret }): its links go to the " +
          "origin, and its codes are kept sealed with the secret",
      );
    }
  },
});
