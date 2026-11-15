/**
 * Sending one of sign-in's messages: its words (the `emailSignIn` resource's
 * `messages`, with what the host the page was served on changes: `hosts`),
 * its blanks filled, from the app's sender or that host's, through the
 * app's email port (`email.send`, the `email` plugin's).
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { EmailSignInHost, EmailSignInMessages, EmailSignInSettings } from "../contract.ts";
import { MESSAGES } from "../resources/messages.ts";
import { CODE_MINUTES, LINK_HOURS } from "./codes.ts";
import { appOf, filled, linksFor, signInOf } from "./settings.ts";

/** What a host the page was served on changes, if the app says (`emailSignIn.hosts`). */
export const hereOf = (
  settings: EmailSignInSettings,
  host: string | undefined,
): EmailSignInHost | undefined =>
  host && settings.hosts && Object.hasOwn(settings.hosts, host) ? settings.hosts[host] : undefined;

/**
 * Where links go for the host the page was served on: its `origin`, else
 * that host on the links origin's scheme; for a host the app doesn't name,
 * the links origin.
 */
export function originFor(ctx: Context, host?: string): string {
  const { origin } = linksFor(ctx);
  const here = hereOf(signInOf(ctx), host);
  if (!here) return origin;
  return here.origin?.replace(/\/+$/, "") ?? `${new URL(origin).protocol}//${host}`;
}

export async function mail(
  ctx: Context,
  which: keyof EmailSignInMessages,
  to: string,
  blanks: { code?: string; link?: string } = {},
  host?: string,
): Promise<void> {
  const settings = signInOf(ctx);
  const here = hereOf(settings, host);
  const words = { ...settings.messages[which] ?? MESSAGES[which]!, ...here?.messages?.[which] };
  const message = filled(words, {
    app: here?.app ?? appOf(ctx),
    email: to,
    minutes: String(CODE_MINUTES),
    hours: String(LINK_HOURS),
    ...blanks,
  });
  await ctx.call("email.send", { to, ...message, ...(here?.from ? { from: here.from } : {}) });
}
