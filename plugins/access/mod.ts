/**
 * Access: who can see and do what (see design/access.md).
 *
 * - `spaces`: spaces, members, reach, and the rules every collection that
 *   shares its documents keeps to;
 * - `identity`: people and their sessions, and who a secret proves;
 * - `contacts`: people outside the org who talk to its agents (a WhatsApp
 *   customer), each in chats shared with them alone;
 * - `googleSignIn`: sign-in with a Google ID token (the `google` resource
 *   names your client);
 * - `devSignIn`: sign-in by name, from this machine only, for trying things
 *   out;
 * - `emailSignIn`: sign-in with an email and a password (codes, resets and
 *   invitations by email), with `email`, the app's email port (Resend's, or
 *   the log on a laptop);
 * - `accounts`: outside accounts people connect for their agents to use (a
 *   ChatGPT plan, as a model provider); its front end is `accountsWeb`
 *   (accounts/web.tsx);
 * - `directory`: who signs in and which orgs they belong to, for apps that
 *   serve many orgs (see design/tenancy.md).
 *
 *   plugins: [...access, googleSignIn, { name: "app", resources: { shared: { note: {} } } }]
 *
 * Who a request is comes from here too: identity's `who` (its session's
 * cookie: a person), beside the web interface's lines' (`webLines`: a
 * visitor); and how people sign in, Google's, email's and dev sign-in's routes.
 */
import type { Plugin } from "../../runtime/mod.ts";
import { contacts } from "./contacts/mod.ts";
import { identity } from "./identity/mod.ts";
import { spaces } from "./spaces/mod.ts";

export * from "./spaces/mod.ts";
export * from "./identity/mod.ts";
export * from "./contacts/mod.ts";
export * from "./google/mod.ts";
export * from "./dev/mod.ts";
export * from "./email/mod.ts";
export * from "./accounts/mod.ts";
export * from "./directory/mod.ts";

/**
 * Spaces, identity and contacts, which every app with people has; Google
 * sign-in is added beside them.
 */
export const access: Plugin[] = [spaces, identity, contacts];
