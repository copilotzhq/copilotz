/**
 * Sending one of sign-in's messages: its words (the `emailSignIn` resource's
 * `messages`), its blanks filled, through the app's email port
 * (`email.send`, the `email` plugin's).
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { EmailSignInSettings } from "../contract.ts";
import { CODE_MINUTES, LINK_HOURS } from "./codes.ts";
import { appOf, filled, signInOf } from "./settings.ts";

export async function mail(
  ctx: Context,
  which: keyof EmailSignInSettings["messages"],
  to: string,
  blanks: { code?: string; link?: string } = {},
): Promise<void> {
  const words = signInOf(ctx).messages[which];
  const message = filled(words, {
    app: appOf(ctx),
    email: to,
    minutes: String(CODE_MINUTES),
    hours: String(LINK_HOURS),
    ...blanks,
  });
  await ctx.call("email.send", { to, ...message });
}
