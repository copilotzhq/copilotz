/**
 * Email: sending it, and signing in with it.
 *
 * **`email`** is the app's email port: `email.send` `{ to, subject, text,
 * html?, from?, replyTo?, attachments? }` (trusted code's, unrecorded)
 * sends through the adapter the `email` resource names: `resend` (Resend's
 * API, with its `apiKey`), `smtp` (a mail server: its `smtp` settings, on
 * Node, Deno and Bun, not workerd), `sendmail` (a sendmail program: its
 * `sendmail` settings, `{ path?, args?, timeout? }`, same platforms), or `console`, which writes each message
 * to the log, for a laptop (an app whose `links` origin is public doesn't
 * start with it). A message is from the resource's `from`, or from another
 * address its `senders` allow; files go as MIME parts (base64, 10 MiB in
 * all; one with an `id` is inline: the HTML says `cid:id`). `mime` writes
 * a message's source, for an adapter of your own. An adapter of your own is an `email` adapter (`EmailAdapter`, in
 * the contract).
 *
 * **`emailSignIn`** (with identity and `email`) signs people in with an
 * email and a password, or a code sent to it:
 *
 * - **Making an account:** `email.sign-up` sends a six-digit code, its
 *   password waiting for it; `email.verify` with the code makes the account
 *   and signs in. An address that has one gets a word saying so instead,
 *   with the same answer. `signUp: false` leaves only invitations.
 * - **Signing in:** `email.sign-in`, refused with `unverified` (and a new
 *   code sent) for an address not confirmed yet, the page's cue to ask for
 *   the code. With `signInByCode`, by a code instead: `email.code` sends
 *   one to an address someone has (with sign-up, to any), and `email.enter`
 *   signs in with it, confirming the address.
 * - **A new password:** `email.forgot` sends a code, answering the same for
 *   an address nobody has; `email.reset` with it sets the password, ends
 *   every other session and signs in.
 * - **Invitations:** trusted code (a webhook, once someone bought) calls
 *   `email.invite` for an address: its person, answered at once, and a link
 *   that works once for a day (`/#email-invite=<token>`), where they choose
 *   a password and arrive signed in (`email.accept`).
 * - **Moving in:** `email.import` brings a person with their password's
 *   hash as another app kept it (bcrypt's `$2a$`, `$2b$` or `$2y$`, as Rails,
 *   PHP and Parse keep it; Copilotz 0.x's `salt:hash` hex, PBKDF2-SHA256 at
 *   100,000), hashed again our way at their first sign-in.
 *
 * - **Per host:** an app serving brands on hosts of their own says, per
 *   host, its name, sender, words and where links go (`hosts`); the page's
 *   steps say the host it was served on, and an invitation takes one.
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
import { codeAction, enterAction } from "./actions/code.ts";
import { importAction } from "./actions/import.ts";
import { acceptAction, invitationAction, inviteAction } from "./actions/invite.ts";
import { pruneAction } from "./actions/prune.ts";
import { forgotAction, resetAction } from "./actions/reset.ts";
import { sendAction } from "./actions/send.ts";
import { signInAction } from "./actions/sign-in.ts";
import { signUpAction, verifyAction } from "./actions/sign-up.ts";
import { captureEmail } from "./adapters/capture.ts";
import { consoleEmail } from "./adapters/console.ts";
import { resend } from "./adapters/resend.ts";
import { sendmail } from "./adapters/sendmail.ts";
import { smtp } from "./adapters/smtp.ts";
import { code } from "./collections/code.ts";
import { login } from "./collections/login.ts";
import { rate } from "./collections/rate.ts";
import { MESSAGES } from "./resources/messages.ts";
import {
  acceptRoute,
  codeRoute,
  enterRoute,
  forgotRoute,
  invitationRoute,
  resetRoute,
  signInRoute,
  signUpRoute,
  verifyRoute,
} from "./routes/sign-in.ts";
import { allowed } from "./shared/addresses.ts";
import type { EmailSettings, EmailSignInSettings } from "./contract.ts";

export * from "./contract.ts";
export { type CapturedMail, captureEmail } from "./adapters/capture.ts";
export { mime, quotedPrintable, typeOf } from "./shared/mime.ts";
export { passwordSignIn } from "./password.ts";
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
  adapters: {
    email: {
      resend,
      smtp,
      sendmail,
      console: consoleEmail,
      // Each executor gets its own mailbox when its registry is assembled.
      get capture() {
        return captureEmail();
      },
    },
  },
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
    if (settings.adapter === "smtp" && (!settings.smtp?.host || !settings.from)) {
      throw new Error("the email resource's smtp adapter needs its from, and smtp: { host }");
    }
    if (settings.adapter === "sendmail" && !settings.from) {
      throw new Error("the email resource's sendmail adapter needs its from");
    }
    for (const sender of settings.senders ?? []) {
      if (typeof sender !== "string" || !/@[^\s@]+\.[^\s@]+>?\s*$/.test(sender.trim())) {
        throw new Error(
          `the email resource's senders are addresses, or @domain: "${String(sender)}" isn't`,
        );
      }
    }
    const origin = publicOrigin(merged.resources);
    if (settings.adapter === "capture" && origin && settings.capture?.allowPublicOrigin !== true) {
      throw new Error(
        `the capture email adapter keeps messages locally, but the app's links origin (${origin}) is public. Use a delivery adapter, or set email.capture.allowPublicOrigin for a test`,
      );
    }
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
    "email.code": codeAction,
    "email.enter": enterAction,
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
    "/signin/email/code": codeRoute,
    "/signin/email/enter": enterRoute,
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
    // A host's sender is one the email resource allows, or its messages would never go.
    const settings = merged.resources.emailSignIn as Partial<EmailSignInSettings> | undefined;
    const mail = merged.resources.email as EmailSettings | undefined;
    for (const [host, here] of Object.entries(settings?.hosts ?? {})) {
      if (here?.from && mail && !allowed(mail, here.from)) {
        throw new Error(
          `emailSignIn.hosts["${host}"].from (${here.from}) isn't an address the email ` +
            "resource allows: add it to its senders",
        );
      }
    }
  },
});
