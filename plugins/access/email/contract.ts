/**
 * The email plugins' contract: what other plugins may import. The shape of a
 * message (`email.send`'s input), of an adapter of the `email` port (to send
 * another way than Resend's or SMTP), and of the plugins' settings. They
 * reach the rest by name: `email.send`, `email.invite`, `email.import`,
 * `password.set`, `password.import`.
 */

/**
 * A file sent with a message: its name as the reader sees it, its type
 * (`application/pdf`; else guessed from the name's ending, else
 * `application/octet-stream`), and its bytes in base64.
 */
export type EmailAttachment = {
  filename: string;
  contentType?: string;
  content: string;
  /**
   * Makes the file inline: its Content-ID, which the message's `html` points
   * to as `cid:logo` (`<img src="cid:logo">`). Letters, digits, `.`, `_`,
   * `-`, `+` (and one `@`). An inline file needs `html`; it counts in the
   * 10 files and 10 MiB, but not in the HTML's 500,000 characters.
   */
  id?: string;
};

/** A message to send: `email.send`'s input, and what an adapter is handed. */
export type EmailMessage = {
  /** One address. */
  to: string;
  subject: string;
  /** The message as plain text: every message has it. */
  text: string;
  /** The same, as HTML, for mail apps that show it. */
  html?: string;
  /**
   * Who it's from, when not the `email` resource's `from`: one of the
   * addresses it allows (its `from`, and its `senders`). A name may go with
   * it: `"Billing <billing@example.com>"`.
   */
  from?: string;
  /** Where replies go: this message's, else the `email` resource's. */
  replyTo?: string;
  /** Files sent with it (10 at most, 10 MiB in all). */
  attachments?: EmailAttachment[];
};

/**
 * An adapter of the `email` port: sends one message, from whom it's from
 * (the message's `from`, else the app's), with the app's settings (its key,
 * its SMTP server) and the `fetch` plugin code calls out with (`ctx.fetch`,
 * which tests replace). It throws when the message didn't go.
 */
export type EmailAdapter = {
  send(
    message: EmailMessage,
    use: { from: string; settings: EmailSettings; fetch: typeof fetch },
  ): Promise<{ id?: string }>;
};

/**
 * The `smtp` adapter's server: where it connects, and how it signs in. On
 * Node, Deno and Bun (it speaks over `node:net` and `node:tls`), not on
 * workerd.
 */
export type SmtpSettings = {
  /** The server: `smtp.example.com`. */
  host: string;
  /** Its port: 465 when `secure`, else 587. */
  port?: number;
  /**
   * TLS from the start (port 465). Else it starts plain and moves to TLS
   * with STARTTLS before anything is said: refused when the server doesn't
   * offer it, unless `starttls` is false.
   */
  secure?: boolean;
  /** False only for a server on this machine (a test's, Mailpit): it then stays plain. */
  starttls?: boolean;
  /** Who it signs in as (AUTH PLAIN or LOGIN, after TLS); none, it doesn't. */
  user?: string;
  password?: string;
  /** Certificates to trust besides the platform's (PEM): a relay with a private CA's. */
  ca?: string;
  /** What it calls itself to the server (EHLO): the `from` address's domain unless said. */
  name?: string;
  /** How long it waits for the server at each step (ms): 30,000. */
  timeout?: number;
};

/**
 * The `sendmail` adapter's program: it gets the whole message on its stdin,
 * run as `path -i -f <sender> [args…] -- <recipient>`, never through a
 * shell. On Node, Deno and Bun (it spawns a process), not on workerd.
 */
export type SendmailSettings = {
  /** The program: `/usr/sbin/sendmail` unless said. */
  path?: string;
  /** Arguments to add before `--` (`["-oi"]`); each is one argument as given. */
  args?: string[];
  /** How long it waits for the program to finish (ms): 30,000. */
  timeout?: number;
};

/** The `email` resource: how the app sends email. */
export type EmailSettings = {
  /**
   * Which adapter sends: `capture` (keeps messages for tests), `resend` (Resend's API), `smtp` (a mail server, on
   * Node, Deno and Bun), `sendmail` (a sendmail program, on Node, Deno and
   * Bun), or `console` on a laptop, which writes each message
   * to the log (refused where the app's `links` origin is public: a code in a
   * log is a way in).
   */
  adapter: string;
  /** With the capture adapter, also write each delivered message as an .eml file in this directory. */
  capture?: { directory?: string };
  /** Who messages are from: `"Example <noreply@example.com>"`. */
  from?: string;
  /**
   * Who else a message may be from (its own `from`): addresses
   * (`billing@example.com`), or every address at a domain (`@example.com`).
   * Any other is refused.
   */
  senders?: string[];
  /** Where replies go, when not to `from`. */
  replyTo?: string;
  /** The adapter's key (Resend's). */
  apiKey?: string;
  /**
   * The `smtp` adapter's server: `{ host, port?, secure?, starttls?, user?,
   * password?, ca?, name?, timeout? }` (see `SmtpSettings`). Its password is
   * a secret: keep it out of your code.
   */
  smtp?: SmtpSettings;
  /** The `sendmail` adapter's program (see `SendmailSettings`). */
  sendmail?: SendmailSettings;
};

/**
 * One message the sign-in sends, as words with blanks: `{app}`, `{email}`,
 * and per message `{code}` and `{minutes}` (a code), or `{link}` and
 * `{hours}` (an invitation). In `html`, what fills a blank is escaped.
 */
export type EmailWords = { subject: string; text: string; html?: string };

/** The messages email sign-in sends, by what they're for. */
export type EmailSignInMessages = {
  verify: EmailWords;
  reset: EmailWords;
  invite: EmailWords;
  exists: EmailWords;
  /** A code to sign in with (`signInByCode`); English unless the app says. */
  signin?: EmailWords;
};

/**
 * What email sign-in says on one host (a brand the app serves there): its
 * name, who its messages are from (one the `email` resource allows), its
 * messages' words, and where its links go (`https://<host>` unless said).
 */
export type EmailSignInHost = {
  app?: string;
  from?: string;
  messages?: { [K in keyof EmailSignInMessages]?: Partial<EmailWords> };
  origin?: string;
};

/** The `emailSignIn` resource: what email sign-in says, and whether people make accounts. */
export type EmailSignInSettings = {
  /**
   * Whether people make an account themselves (`POST /signin/email/sign-up`);
   * else only an invitation makes one (`email.invite`). Yes unless said.
   */
  signUp?: boolean;
  /**
   * Whether people may sign in with a code sent to their address, with no
   * password (`email.code`, then `email.enter`); with `signUp`, that makes
   * an account too. No unless said.
   */
  signInByCode?: boolean;
  /** What messages call the app (`{app}`): the host of the `links` origin unless said. */
  app?: string;
  /**
   * The messages, by what they're for: a sign-up's code (`verify`), a new
   * password's (`reset`), an invitation's link (`invite`), a sign-up for an
   * address that has an account already (`exists`), and a code to sign in
   * with (`signin`). English unless the app says; a later plugin patches one
   * word of one.
   */
  messages: EmailSignInMessages;
  /**
   * Per host the page is served on (a brand's: `"brand.example"`), what
   * changes there: its name, sender, words and links. The route says the
   * host; a host not here says what the rest does.
   */
  hosts?: Record<string, EmailSignInHost>;
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

/**
 * The `passwordSignIn` resource: how people sign in by an identifier (a
 * username, a badge number, a CPF) and a password.
 */
export type PasswordSignInSettings = {
  /**
   * Characters an identifier is read without, wherever it's typed or set:
   * `".-/"` for a CPF typed with its dots. Spaces never count, nor case.
   */
  ignore?: string;
  /**
   * How much one identifier, and one caller, may try (`too_many` past it):
   * tries at an identifier's password in 15 minutes (`tries`, 10), and all
   * one caller asks in 15 minutes (`address`, 30).
   */
  limits?: { tries?: number; address?: number };
};
