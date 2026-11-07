/**
 * The email plugins' settings, as each reads its own resource: how mail goes
 * (`email`), and what sign-in says and allows (`emailSignIn`), with its
 * messages' blanks filled.
 */
import { linksOf, type LinksSettings, type Resources } from "../../../../runtime/mod.ts";
import type { EmailSettings, EmailSignInSettings, EmailWords } from "../contract.ts";

/** How the app sends email: the `email` resource. */
export const emailOf = (ctx: { resources: Resources }): EmailSettings =>
  (ctx.resources.email ?? {}) as EmailSettings;

/** What email sign-in says and allows: the `emailSignIn` resource. */
export const signInOf = (ctx: { resources: Resources }): EmailSignInSettings =>
  ctx.resources.emailSignIn as EmailSignInSettings;

/** The app's `links` (its origin, and the secret codes are kept under): checked at start. */
export const linksFor = (ctx: { resources: Resources }): LinksSettings => {
  const links = linksOf(ctx.resources);
  if (!links) throw new Error("Email sign-in needs the links resource: { origin, secret }");
  return links;
};

/** What messages call the app: `emailSignIn.app`, else the links origin's host. */
export const appOf = (ctx: { resources: Resources }): string =>
  signInOf(ctx).app || new URL(linksFor(ctx).origin).host;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Words with their blanks filled (`{code}`…); in HTML, what fills them escaped. Unknown blanks stay. */
export function filled(words: EmailWords, blanks: Record<string, string>) {
  const fill = (text: string, html: boolean) =>
    text.replace(/\{(\w+)\}/g, (blank, name: string) => {
      const value = blanks[name];
      return value === undefined ? blank : html ? escape(value) : value;
    });
  return {
    subject: fill(words.subject, false),
    text: fill(words.text, false),
    ...(words.html ? { html: fill(words.html, true) } : {}),
  };
}
