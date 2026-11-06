/**
 * A new password, by a code sent to the address:
 *
 * - `email.forgot` `{ email }`: a six-digit code goes to an address this app
 *   knows (it has a login, a sign-up waiting, or someone a sign-in verified
 *   it for), in place of one sent before (the `reset` message). The answer is
 *   the same whether or not it knows it, and so are the limits, so it says
 *   nothing about who has an account: a message that didn't go is logged,
 *   not said.
 * - `email.reset` `{ email, code, password }`: the code proves the address is
 *   theirs: the password is set (and the address confirmed), every other
 *   session of theirs ends, and a new one starts. A Google sign-in's person
 *   gets a password this way too.
 *
 * The route passes who calls (`address`) for the limits. Unrecorded: inputs
 * hold codes and passwords, and answers sessions.
 */
import { defineAction, failure } from "../../../../runtime/mod.ts";
import type { Person } from "../../identity/contract.ts";
import type { Code } from "../collections/code.ts";
import type { Login } from "../collections/login.ts";
import { CODE_MINUTES, codeText, newCode, newToken, redeem, seal } from "../shared/codes.ts";
import { ADDRESS, CODE, codeIn, EMAIL, emailIn, PASSWORD, passwordIn } from "../shared/inputs.ts";
import { aSend, aTry } from "../shared/limits.ts";
import { mail } from "../shared/mail.ts";
import { hashPassword } from "../shared/password.ts";
import { keepPassword, keepPerson, personFor, sessionFor } from "../shared/people.ts";
import { linksFor } from "../shared/settings.ts";
import { WRONG_CODE } from "./sign-up.ts";

export const forgotAction = defineAction({
  description: "Sends a code to choose a new password, if the address has an account",
  record: false,
  input: {
    type: "object",
    properties: { email: EMAIL, address: ADDRESS },
    required: ["email"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const email = emailIn(input.email);
    await aSend(ctx, { email, address: input.address });
    const db = ctx.as().db;
    const codes = db.collection<Code>("email_code");
    const known = await db.collection<Login>("email_login").findOne({ _id: email }) ??
      await codes.findOne({ email, purpose: "verify" }) ??
      await db.collection<Person>("person").findOne({ email });
    if (!known) return { email };
    await codes.deleteMany({ email, purpose: "reset" });
    const now = Date.now();
    const code = newCode();
    const expires = new Date(now + CODE_MINUTES * 60_000).toISOString();
    await codes.insertOne({
      _id: newToken(16),
      email,
      purpose: "reset",
      hash: await seal(linksFor(ctx), codeText("reset", email, code)),
      tries: 0,
      expires,
      until: expires,
      at: new Date(now).toISOString(),
    });
    try {
      await mail(ctx, "reset", email, { code });
    } catch (error) {
      console.error("email-sign-in: a reset code didn't go:", (error as Error).message);
    }
    return { email };
  },
});

export const resetAction = defineAction({
  description: "Sets a new password with the code sent to the address: a new session",
  record: false,
  input: {
    type: "object",
    properties: { email: EMAIL, code: CODE, password: PASSWORD, address: ADDRESS },
    required: ["email", "code", "password"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const email = emailIn(input.email);
    const password = passwordIn(input.password);
    await aTry(ctx, { email, address: input.address });
    if (!await redeem(ctx, linksFor(ctx), "reset", email, codeIn(input.code))) {
      throw failure("invalid", WRONG_CODE, { public: true });
    }
    const db = ctx.as().db;
    const login = await db.collection<Login>("email_login").findOne({ _id: email });
    // A sign-up still waiting gives its name.
    const signUp = login ? null : await db.collection<Code>("email_code")
      .findOne({ email, purpose: "verify" }, { sort: { at: -1 } });
    const { person, new: made } = await personFor(ctx, email, login);
    await keepPassword(ctx, email, person, await hashPassword(password), login);
    await keepPerson(ctx, person, { email, name: signUp?.name });
    // A password replaced: wherever else they were signed in, they're out.
    if (login?.hash) await ctx.call("credential.revoke", { person });
    return { person, session: await sessionFor(ctx, person), new: made };
  },
});
