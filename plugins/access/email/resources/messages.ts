/**
 * What email sign-in says by email, in English: the `emailSignIn` resource's
 * `messages`, which an app replaces word for word (in pt-BR, say). The
 * blanks (`{app}`, `{code}`, `{link}`…) are filled as each goes; in the
 * HTML, escaped. The HTML is one plain card, inline-styled, as mail apps
 * want it.
 */
import type { EmailSignInSettings } from "../contract.ts";

/** A message's HTML: a heading, what it says, and what to act on, in one card. */
const card = (heading: string, body: string) =>
  `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f5f5f4;` +
  `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
  `color:#1c1917"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
  `<tr><td align="center"><table role="presentation" width="100%" cellpadding="0" ` +
  `cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e7e5e4;` +
  `border-radius:16px"><tr><td style="padding:32px 28px">` +
  `<p style="margin:0 0 20px;font-size:13px;font-weight:600;letter-spacing:.04em;` +
  `text-transform:uppercase;color:#78716c">{app}</p>` +
  `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3">${heading}</h1>${body}` +
  `</td></tr></table></td></tr></table></body></html>`;

const p = (text: string) =>
  `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#44403c">${text}</p>`;
const quiet = (text: string) =>
  `<p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#78716c">${text}</p>`;
const code = `<p style="margin:8px 0 20px;font-family:ui-monospace,SFMono-Regular,Menlo,` +
  `Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:.24em;color:#1c1917">` +
  `{code}</p>`;
const button = (label: string) =>
  `<p style="margin:8px 0 20px"><a href="{link}" style="display:inline-block;padding:12px 22px;` +
  `border-radius:10px;background:#1c1917;color:#ffffff;font-size:15px;font-weight:600;` +
  `text-decoration:none">${label}</a></p>`;

export const MESSAGES: EmailSignInSettings["messages"] = {
  verify: {
    subject: "{code} is your code for {app}",
    text: "Your code to confirm this email for {app}:\n\n{code}\n\n" +
      "It works for {minutes} minutes. If you didn't ask for it, ignore this email: " +
      "nothing happens without the code.",
    html: card(
      "Confirm your email",
      p("Enter this code where you're making your account:") + code +
        p("It works for {minutes} minutes.") +
        quiet("If you didn't ask for it, ignore this email: nothing happens without the code."),
    ),
  },
  reset: {
    subject: "{code} is your code to reset your password for {app}",
    text: "Your code to choose a new password for {app}:\n\n{code}\n\n" +
      "It works for {minutes} minutes. If you didn't ask for it, ignore this email: " +
      "your password stays as it is.",
    html: card(
      "Choose a new password",
      p("Enter this code where you asked to reset your password:") + code +
        p("It works for {minutes} minutes.") +
        quiet("If you didn't ask for it, ignore this email: your password stays as it is."),
    ),
  },
  invite: {
    subject: "Set your password for {app}",
    text: "Your account at {app} is ready. Choose a password to sign in:\n\n{link}\n\n" +
      "The link works once, for {hours} hours.",
    html: card(
      "Your account is ready",
      p("Choose a password for <b>{email}</b>, and you're in.") + button("Choose a password") +
        quiet(
          "The link works once, for {hours} hours. If you weren't expecting it, ignore this email.",
        ),
    ),
  },
  exists: {
    subject: "You already have an account at {app}",
    text: "Someone tried to make an account at {app} with this email, which has one already. " +
      'If it was you, sign in instead, or choose a new password with "Forgot your password?".' +
      "\n\nIf it wasn't you, ignore this email: nothing changed.",
    html: card(
      "You already have an account",
      p(
        "Someone tried to make an account at {app} with <b>{email}</b>, which has one already. " +
          "If it was you, sign in instead, or choose a new password with " +
          "<i>Forgot your password?</i>",
      ) + quiet("If it wasn't you, ignore this email: nothing changed."),
    ),
  },
};
