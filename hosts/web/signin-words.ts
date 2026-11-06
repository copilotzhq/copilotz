/**
 * What the sign-in page says, as the app's: the `signInPage` resource of the
 * page's plugins (those `web({ plugins })` runs), merged over these defaults
 * in order, as the theme is. Its `words` patch one by one, by key: an app
 * gives its language (Co-Cr.ia's pt-BR) or changes one phrase. Its `about`,
 * the panel beside the form (a headline, its quieter end, and a few points),
 * is given whole: an app that gives one never shows Copilotz's pitch beside
 * its own, and `null` leaves the form alone. The logo over it is the
 * theme's (`theme.logo`), and the name the page's title.
 *
 * ```ts
 * definePlugin({
 *   name: "brand",
 *   resources: {
 *     signInPage: {
 *       about: { headline: "Seu conteúdo,", quiet: "com estratégia.", points: [{ icon: "sparkles", title: "…" }] },
 *       words: { signIn: "Entrar", email: "E-mail", password: "Senha" },
 *     },
 *   },
 * })
 * ```
 *
 * A word may have blanks (`{email}`, `{seconds}`, `{min}`, `{org}`, `{link}`),
 * filled where it shows; one an app leaves out stays English.
 */
import { definePlugin, type Plugins } from "../../runtime/mod.ts";
import { merge } from "../../runtime/registry.ts";
import type { IconName } from "./toolkit/icon.tsx";

/** Every phrase the sign-in page shows, in English. */
export const SIGN_IN_WORDS = {
  // The card, whatever the ways in.
  signIn: "Sign in",
  or: "or",
  signingIn: "Signing you in",
  opening: "Opening {org}",
  personalOrg: "your Personal org",
  noWay: "No way to sign in is configured.",
  failed: "Something went wrong. Try again.",
  offline: "Couldn't reach the server. Check your connection.",
  // What the first screen says under its heading, by the ways the app has.
  ledeGoogleEmail: "With Google, or with your email.",
  ledeEmail: "With your email and password.",
  ledeGoogleDev: "With Google, or by name on this machine.",
  ledeGoogle: "With your Google account.",
  ledeDev: "By name, on this machine.",
  googleFailed: "Google couldn't sign you in. Try again.",
  // Signing in by name, on this machine (dev).
  devLabel: "Your name or email",
  devHint:
    "Anyone you name here is a person in this app; with an email, invitations to it reach you.",
  devInvalid: "Use letters, digits, dots, dashes or underscores, or an email.",
  devPlaceholder: "e.g. ana, or ana@example.com",
  devSubmit: "Continue",
  devSubmitBeside: "Sign in by name",
  devInstead: "Sign in by name instead",
  devNote: "Signing in by name works on this machine only, for trying things out.",
  // Fields.
  email: "Email",
  emailPlaceholder: "you@example.com",
  password: "Password",
  newPassword: "New password",
  name: "Name",
  nameHint: "Optional: what people here see.",
  namePlaceholder: "Ana Lima",
  code: "Code",
  codeLabel: "Six-digit code",
  showPassword: "Show password",
  hidePassword: "Hide password",
  capsLock: "Caps Lock is on",
  atLeast: "At least {min} characters",
  // Signing in.
  forgot: "Forgot your password?",
  signingInBusy: "Signing in…",
  newHere: "New here?",
  createAccount: "Create an account",
  back: "Back",
  // Making an account.
  signUpTitle: "Create your account",
  signUpLede: "We'll email you a code to confirm your address.",
  signUp: "Create account",
  signUpBusy: "Creating your account…",
  haveAccount: "Already have an account?",
  // The code.
  codeTitle: "Check your email",
  codeLede: "We sent a 6-digit code to {email}. Enter it to confirm it's yours.",
  confirmFirst: "Confirm your email first.",
  confirm: "Confirm",
  confirmBusy: "Confirming…",
  otherEmail: "Use another email",
  noCode: "Didn't get it? Check your spam folder, or {link}",
  newCode: "send a new code",
  newCodeIn: "send a new code in {seconds}s",
  codeSent: "We've sent a new code.",
  codeNotSent: "We couldn't send a new code. If you have an account, sign in instead.",
  // A new password.
  forgotTitle: "Reset your password",
  forgotLede: "Enter your account's email, and we'll send you a code to choose a new password.",
  sendCode: "Send code",
  sending: "Sending…",
  resetTitle: "Choose a new password",
  resetLede: "If {email} has an account, we've sent it a 6-digit code.",
  reset: "Set password and sign in",
  saving: "Saving…",
  noResetCode: "Didn't get it? {link}",
  resetCode: "Send a new code",
  resetCodeIn: "Send a new code in {seconds}s",
  // Arriving by an invitation's link.
  inviteTitle: "Choose your password",
  inviteOpening: "Opening your invitation",
  inviteLede: "Welcome! Set a password for {email}, and you're in.",
  invite: "Set password and continue",
  toSignIn: "Go to sign in",
  // What's wrong, beside what it's about.
  enterEmail: "Enter your email address, such as ana@example.com.",
  enterPassword: "Enter your password.",
  tooShort: "Use at least {min} characters.",
  enterCode: "Enter the six digits from the email.",
  wrongPassword: "That email and password don't match.",
  wrongCode:
    "That code isn't right, or it has expired. Check the latest email, or ask for a new code.",
  linkExpired:
    'This link has expired or has been used. Ask for a new one, or choose a password with "Forgot your password?".',
  tooMany: "Too many tries for now. Wait a few minutes, then try again.",
  notSent: "We couldn't send the email. Try again in a moment.",
  byInvitation: "Accounts here are made by invitation.",
};

export type SignInWords = typeof SIGN_IN_WORDS;

/** One point the panel beside the form makes: an icon, a title, and a line under it. */
export type SignInPoint = { icon?: IconName; title: string; text?: string };

/** The panel beside the form: a headline, its quieter end, and the points under it. */
export type SignInAbout = { headline: string; quiet?: string; points?: SignInPoint[] };

/** The `signInPage` resource: what an app's sign-in page says. */
export type SignInPage = {
  /** Phrases, by key (see `SIGN_IN_WORDS`): those given replace the English ones. */
  words?: Partial<SignInWords>;
  /** The panel beside the form, whole; `null`: none, the form alone. */
  about?: SignInAbout | null;
};

/** Copilotz's pitch: what an app that says nothing shows. */
export const COPILOTZ_ABOUT: SignInAbout = {
  headline: "Your agents,",
  quiet: "with you and your team.",
  points: [
    {
      icon: "sparkles",
      title: "Agents that work with you",
      text:
        "In your conversations, on your computer, remembering what matters, and asking before anything they can't undo.",
    },
    {
      icon: "users",
      title: "Spaces for you and your team",
      text: "A Personal space that's yours alone, and shared spaces you invite people to.",
    },
    {
      icon: "building",
      title: "Every organization, one sign-in",
      text:
        "Your own, and your teams': switch between them in a click. Invitations wait for you here.",
    },
  ],
};

/** The defaults, as the first `signInPage` resource: the app's patch them as any later plugin's would. */
const defaults = definePlugin({
  name: "web-sign-in",
  resources: { signInPage: { words: SIGN_IN_WORDS, about: COPILOTZ_ABOUT } },
});

/** What the sign-in page says: every word, and the panel beside the form (or none). */
export type SignInSaid = { words: SignInWords; about: SignInAbout | null };

/**
 * The app's sign-in page: the English words with the plugins' `signInPage`
 * words merged over them in order; the panel, the last one given, whole.
 */
export function signInPageOf(plugins: Plugins): SignInSaid {
  const merged = merge([defaults, ...plugins], { elsewhere: true }).resources.signInPage as {
    words?: Partial<SignInWords>;
  };
  const words = { ...SIGN_IN_WORDS };
  for (const [key, value] of Object.entries(merged?.words ?? {})) {
    if (typeof value === "string" && key in words) words[key as keyof SignInWords] = value;
  }
  const given = [defaults, ...(plugins as unknown[]).flat(Infinity) as typeof defaults[]]
    .map((plugin) => plugin.resources?.signInPage as SignInPage | undefined);
  const last = given.findLast((page) =>
    page !== null && typeof page === "object" && "about" in page
  );
  return { words, about: last?.about ?? null };
}

/** A phrase with its blanks filled (`{email}` …); a blank nothing fills stays as it is. */
export const fill = (text: string, blanks: Record<string, string | number>): string =>
  text.replace(
    /\{(\w+)\}/g,
    (blank, name: string) => name in blanks ? String(blanks[name]) : blank,
  );
