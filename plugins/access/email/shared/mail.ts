/**
 * Sending one of sign-in's messages: its words (the `emailSignIn` resource's
 * `messages`, with what the host the page was served on changes: `hosts`),
 * its blanks filled, from the app's sender or that host's, through the
 * app's email port (`email.send`, the `email` plugin's).
 */
import { type Context, failure } from "../../../../runtime/mod.ts";
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

/**
 * What a message that couldn't go answers, the same words for every address, so the page says it
 * ("couldn't send it now") instead of "sent".
 */
export const NOT_SENT = "The message couldn't be sent right now. Try again in a few minutes.";

/** How long after a message failed to go every send is refused alike. */
export const FAILING_MS = 5 * 60_000;

/** Until when sends have been failing, by the runtime's resources (one runtime, its memory). */
const failing = new WeakMap<object, number>();

const unavailable = () => failure("unavailable", NOT_SENT, { public: true });

/**
 * Throws `unavailable` while messages have been failing to go (`FAILING_MS` after one failed),
 * before anything about the address is looked up: whether it has an account, it's refused alike.
 */
export function mustSend(ctx: Pick<Context, "resources">): void {
  if (Date.now() < (failing.get(ctx.resources) ?? 0)) throw unavailable();
}

/**
 * Sends a message (`mail`); one that doesn't go is logged, remembered (every send is refused
 * alike for a while: `mustSend`), and refused, `unavailable`, in words the page shows.
 */
export async function deliver(...args: Parameters<typeof mail>): Promise<void> {
  const [ctx, kind] = args;
  try {
    await mail(...args);
    failing.delete(ctx.resources);
  } catch (error) {
    failing.set(ctx.resources, Date.now() + FAILING_MS);
    console.error(`email-sign-in: a ${kind} message didn't go:`, (error as Error).message);
    throw unavailable();
  }
}
