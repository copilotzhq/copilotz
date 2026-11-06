/**
 * The email plugins' contract: what other plugins may import. The shape of a
 * message (`email.send`'s input), of an adapter of the `email` port (to send
 * another way than Resend's), and of both plugins' settings. They reach the
 * rest by name: `email.send`, `email.invite`, `email.import`.
 */

/** A message to send: `email.send`'s input, and what an adapter is handed. */
export type EmailMessage = {
  /** One address. */
  to: string;
  subject: string;
  /** The message as plain text: every message has it. */
  text: string;
  /** The same, as HTML, for mail apps that show it. */
  html?: string;
};

/**
 * An adapter of the `email` port: sends one message, with the app's settings
 * (`from`, its key) and the `fetch` plugin code calls out with (`ctx.fetch`,
 * which tests replace). It throws when the message didn't go.
 */
export type EmailAdapter = {
  send(
    message: EmailMessage,
    use: { from: string; settings: EmailSettings; fetch: typeof fetch },
  ): Promise<{ id?: string }>;
};

/** The `email` resource: how the app sends email. */
export type EmailSettings = {
  /**
   * Which adapter sends: `resend` (Resend's API), or `console` on a laptop,
   * which writes each message to the log (refused where the app's `links`
   * origin is public: a code in a log is a way in).
   */
  adapter: string;
  /** Who messages are from: `"Co-Cr.ia <noreply@example.com>"`. */
  from?: string;
  /** Where replies go, when not to `from`. */
  replyTo?: string;
  /** The adapter's key (Resend's). */
  apiKey?: string;
};

/**
 * One message the sign-in sends, as words with blanks: `{app}`, `{email}`,
 * and per message `{code}` and `{minutes}` (a code), or `{link}` and
 * `{hours}` (an invitation). In `html`, what fills a blank is escaped.
 */
export type EmailWords = { subject: string; text: string; html?: string };

/** The `emailSignIn` resource: what email sign-in says, and whether people make accounts. */
export type EmailSignInSettings = {
  /**
   * Whether people make an account themselves (`POST /signin/email/sign-up`);
   * else only an invitation makes one (`email.invite`). Yes unless said.
   */
  signUp?: boolean;
  /** What messages call the app (`{app}`): the host of the `links` origin unless said. */
  app?: string;
  /**
   * The messages, by what they're for: a sign-up's code (`verify`), a new
   * password's (`reset`), an invitation's link (`invite`), and a sign-up for
   * an address that has an account already (`exists`). English unless the
   * app says; a later plugin patches one word of one.
   */
  messages: {
    verify: EmailWords;
    reset: EmailWords;
    invite: EmailWords;
    exists: EmailWords;
  };
  /**
   * How much one address, and one caller, may ask (`too_many` past it):
   * messages to an address an hour (`sends`, 5); tries at a password, a code
   * or a link for an address in 15 minutes (`tries`, 10); and everything one
   * caller (by network address) asks in 15 minutes (`address`, 30).
   */
  limits?: { sends?: number; tries?: number; address?: number };
};

/** What a sign-in that ends signed in answers (the route sets the session in its cookie). */
export type SignedInByEmail = { person: string; session: string; new?: boolean };
