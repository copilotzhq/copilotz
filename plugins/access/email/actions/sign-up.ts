/**
 * Making an account with an email and a password, in two steps:
 *
 * - `email.sign-up` `{ email, password, name? }`: the password, hashed,
 *   waits with the name for the address to be confirmed, and a six-digit
 *   code goes to it (the `verify` message). Nobody is made yet: identity's
 *   `person.email` is an address someone proved. An address that has an
 *   account already gets a word saying so instead (`exists`), and the answer
 *   is the same, so it says nothing about who has one. Each sign-up waits
 *   on its own (the latest three; a week): whoever confirms with a code
 *   confirms the password that code came with, so a stranger signing up
 *   with someone's address can't choose their password.
 * - `email.verify` `{ email, code }`: the code confirms its sign-up: the
 *   person (who the address already was, or someone new), their login with
 *   that password, and a session.
 *
 * The route passes who calls (`address`) for the limits. Unrecorded: inputs
 * hold passwords and codes, and answers sessions.
 */
import { defineAction, failure } from "../../../../runtime/mod.ts";
import type { Code } from "../collections/code.ts";
import type { Login } from "../collections/login.ts";
import { CODE_MINUTES, codeText, newCode, newToken, redeem, seal } from "../shared/codes.ts";
import {
  ADDRESS,
  CODE,
  codeIn,
  EMAIL,
  emailIn,
  NAME,
  PASSWORD,
  passwordIn,
} from "../shared/inputs.ts";
import { aSend, aTry } from "../shared/limits.ts";
import { mail } from "../shared/mail.ts";
import { hashPassword } from "../shared/password.ts";
import { keepPassword, keepPerson, personFor, sessionFor } from "../shared/people.ts";
import { linksFor, signInOf } from "../shared/settings.ts";

/** How long a sign-up waits for its address to be confirmed, and how many at once. */
const WAITS = 7 * 86_400_000;
const AT_ONCE = 3;

/** A code that doesn't confirm anything. */
export const WRONG_CODE = "That code isn't right, or it has expired. Check the latest email, " +
  "or ask for a new code.";

export const signUpAction = defineAction({
  description: "Starts an account: a code to the address, its password waiting for it",
  record: false,
  input: {
    type: "object",
    properties: { email: EMAIL, password: PASSWORD, name: NAME, address: ADDRESS },
    required: ["email", "password"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    if (signInOf(ctx).signUp === false) {
      throw failure("forbidden", "Accounts here are made by invitation.", { public: true });
    }
    const email = emailIn(input.email);
    const password = passwordIn(input.password);
    await aSend(ctx, { email, address: input.address });
    const links = linksFor(ctx);
    // Hashed either way, so an address with an account answers as soon as one without.
    const pending = await hashPassword(password);
    const db = ctx.as().db;
    const login = await db.collection<Login>("email_login").findOne({ _id: email });
    if (login?.hash && login.verified) {
      await mail(ctx, "exists", email);
      return { email };
    }
    const codes = db.collection<Code>("email_code");
    const older = await codes.find({ email, purpose: "verify" }).sort({ at: -1 }).toArray();
    for (const old of older.slice(AT_ONCE - 1)) await codes.deleteOne({ _id: old._id });
    const now = Date.now();
    const code = newCode();
    const name = input.name?.trim();
    await codes.insertOne({
      _id: newToken(16),
      email,
      purpose: "verify",
      hash: await seal(links, codeText("verify", email, code)),
      pending,
      ...(name ? { name } : {}),
      tries: 0,
      expires: new Date(now + CODE_MINUTES * 60_000).toISOString(),
      until: new Date(now + WAITS).toISOString(),
      at: new Date(now).toISOString(),
    });
    await mail(ctx, "verify", email, { code });
    return { email };
  },
});

export const verifyAction = defineAction({
  description: "Confirms an address with its code: the account, and a session",
  record: false,
  input: {
    type: "object",
    properties: { email: EMAIL, code: CODE, address: ADDRESS },
    required: ["email", "code"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const email = emailIn(input.email);
    await aTry(ctx, { email, address: input.address });
    const waiting = await redeem(ctx, linksFor(ctx), "verify", email, codeIn(input.code));
    if (!waiting?.pending) throw failure("invalid", WRONG_CODE, { public: true });
    const login = await ctx.as().db.collection<Login>("email_login").findOne({ _id: email });
    const { person, new: made } = await personFor(ctx, email, login);
    // A password set since (a reset) stays: this sign-up waited from before it.
    const hash = login?.verified && login.hash ? login.hash : waiting.pending;
    await keepPassword(ctx, email, person, hash, login);
    await keepPerson(ctx, person, { email, name: waiting.name });
    return { person, session: await sessionFor(ctx, person), new: made };
  },
});
