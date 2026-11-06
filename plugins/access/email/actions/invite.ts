/**
 * Accounts trusted code makes (a webhook, once someone bought): a link by
 * email where its person chooses a password and arrives signed in.
 *
 * - `email.invite` `{ email, name?, person? }`: the person this address is
 *   (who it already was; else someone new, by the id given or one made),
 *   answered at once so the caller can hand them what they bought. When
 *   they have no password yet, a link goes to the address (the `invite`
 *   message: `<links origin>/#email-invite=<token>`), working once, for a
 *   day; links sent before still work until one is used. Trusted code's:
 *   no actor calls it.
 * - `email.invitation` `{ token }`: which address a link is for, while it
 *   works: the page shows it as the person chooses their password.
 * - `email.accept` `{ token, password, name? }`: the link used: the password
 *   set (the address confirmed: it came by email), and a session.
 *
 * The token travels in the link's fragment, which browsers never send to a
 * server, and is kept only as its seal (see shared/codes.ts). The route
 * passes who calls (`address`) for the limits. Unrecorded: inputs hold
 * tokens and passwords, answers sessions.
 */
import { type Context, defineAction, failure } from "../../../../runtime/mod.ts";
import type { Code } from "../collections/code.ts";
import type { Login } from "../collections/login.ts";
import { LINK_HOURS, newToken, seal, sealsOf, tokenText } from "../shared/codes.ts";
import { ADDRESS, EMAIL, emailIn, NAME, PASSWORD, passwordIn } from "../shared/inputs.ts";
import { aTry } from "../shared/limits.ts";
import { mail } from "../shared/mail.ts";
import { hashPassword } from "../shared/password.ts";
import { keepPassword, keepPerson, personFor, sessionFor } from "../shared/people.ts";
import { linksFor } from "../shared/settings.ts";

/** Where in the page's address a link carries its token. */
export const INVITE_FRAGMENT = "email-invite";

const TOKEN = { type: "string", minLength: 20, maxLength: 200 } as const;

const EXPIRED = "This link has expired or has been used. Ask for a new one, or choose a " +
  'password with "Forgot your password?".';

/** The invitation a token is, while it works: else refused, saying so to anyone. */
async function invitationOf(ctx: Context, token: string): Promise<Code> {
  const found = await ctx.as().db.collection<Code>("email_code").findOne({
    _id: { $in: await sealsOf(linksFor(ctx), tokenText(token)) },
    purpose: "invite",
    expires: { $gt: new Date().toISOString() },
  });
  if (!found) throw failure("invalid", EXPIRED, { public: true });
  return found;
}

export const inviteAction = defineAction({
  description: "The person for an address, sent a link to choose a password when they have none",
  record: false,
  input: {
    type: "object",
    properties: {
      email: EMAIL,
      name: NAME,
      /** The id a new person gets (else one is made). */
      person: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["email"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const email = emailIn(input.email);
    const logins = ctx.as().db.collection<Login>("email_login");
    let login = await logins.findOne({ _id: email });
    if (login?.hash && login.verified) return { person: login.person, new: false, sent: false };
    let { person, new: made } = await personFor(ctx, email, login, input.person);
    if (!login) {
      try {
        await logins.insertOne({
          _id: email,
          person,
          verified: false,
          at: new Date().toISOString(),
        });
      } catch (error) {
        // Invited at once by another call: theirs stands.
        if ((error as { code?: string }).code !== "duplicate_key") throw error;
        login = await logins.findOne({ _id: email });
        person = login!.person;
        made = false;
      }
    }
    await keepPerson(ctx, person, { email, name: input.name });
    const links = linksFor(ctx);
    const token = newToken();
    const now = Date.now();
    const expires = new Date(now + LINK_HOURS * 3_600_000).toISOString();
    await ctx.as().db.collection<Code>("email_code").insertOne({
      _id: await seal(links, tokenText(token)),
      email,
      purpose: "invite",
      tries: 0,
      expires,
      until: expires,
      at: new Date(now).toISOString(),
    });
    await mail(ctx, "invite", email, { link: `${links.origin}/#${INVITE_FRAGMENT}=${token}` });
    return { person, new: made, sent: true };
  },
});

export const invitationAction = defineAction({
  description: "Which address an invitation's link is for, while it works",
  record: false,
  input: {
    type: "object",
    properties: { token: TOKEN, address: ADDRESS },
    required: ["token"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    await aTry(ctx, { address: input.address });
    return { email: (await invitationOf(ctx, input.token)).email };
  },
});

export const acceptAction = defineAction({
  description: "Uses an invitation's link: the password chosen, and a session",
  record: false,
  input: {
    type: "object",
    properties: { token: TOKEN, password: PASSWORD, name: NAME, address: ADDRESS },
    required: ["token", "password"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const password = passwordIn(input.password);
    await aTry(ctx, { address: input.address });
    const { email } = await invitationOf(ctx, input.token);
    const login = await ctx.as().db.collection<Login>("email_login").findOne({ _id: email });
    const { person, new: made } = await personFor(ctx, email, login);
    await keepPassword(ctx, email, person, await hashPassword(password), login);
    await keepPerson(ctx, person, { email, name: input.name });
    // A password replaced: wherever else they were signed in, they're out.
    if (login?.hash) await ctx.call("credential.revoke", { person });
    return { person, session: await sessionFor(ctx, person), new: made };
  },
});
