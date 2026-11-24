/**
 * Signing in with a code sent to the address, with no password, when the
 * app says (`emailSignIn.signInByCode`):
 *
 * - `email.code` `{ email }`: a six-digit code goes to an address someone
 *   has (a login, invited or not, or a person a sign-in verified it for), in
 *   place of one sent before (the `signin` message); with sign-up on, to any
 *   address, whose code then makes an account. The answer is the same
 *   whether or not the address has one, and so are the limits. A message
 *   that didn't go is refused (`unavailable`, which the page says), and for a
 *   while after, every address is refused alike; the code sent before stays
 *   good until a new one went.
 * - `email.enter` `{ email, code, name? }`: the code proves the address is
 *   theirs: the person (who it already was, or someone new, with the name
 *   given), their address confirmed, and a session. Their password, if they
 *   have one, stays as it is; without one, they sign in by code alone (or
 *   choose one with `email.forgot`).
 *
 * The route passes who calls (`address`) for the limits, and the host the
 * page was served on (`host`) for what the message says. Unrecorded: inputs
 * hold codes, answers sessions.
 */
import { defineAction, failure, type Resources } from "../../../../runtime/mod.ts";
import type { Person } from "../../identity/contract.ts";
import type { Code } from "../collections/code.ts";
import type { Login } from "../collections/login.ts";
import { CODE_MINUTES, codeText, newCode, newToken, redeem, seal } from "../shared/codes.ts";
import { ADDRESS, CODE, codeIn, EMAIL, emailIn, HOST, NAME } from "../shared/inputs.ts";
import { aSend, aTry, byEmail } from "../shared/limits.ts";
import { deliver, mustSend } from "../shared/mail.ts";
import { keepPerson, personFor, sessionFor } from "../shared/people.ts";
import { linksFor, signInOf } from "../shared/settings.ts";
import { WRONG_CODE } from "./sign-up.ts";

/** Refuses unless the app lets people sign in by a code. */
const offered = (ctx: { resources: Resources }) => {
  if (!signInOf(ctx).signInByCode) {
    throw failure("forbidden", "Signing in by a code isn't offered here.", { public: true });
  }
};

export const codeAction = defineAction({
  description:
    "Sends a code to sign in with to an address, if it's someone's (or, with sign-up, anyone's)",
  record: false,
  input: {
    type: "object",
    properties: { email: EMAIL, address: ADDRESS, host: HOST },
    required: ["email"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    offered(ctx);
    const email = emailIn(input.email);
    await aSend(ctx, { account: email, address: input.address });
    mustSend(ctx);
    const db = ctx.as().db;
    const known = await db.collection<Login>("email_login").findOne({ _id: email }) ??
      await db.collection<Person>("person").findOne({ email });
    if (!known && signInOf(ctx).signUp === false) return { email };
    const codes = db.collection<Code>("email_code");
    const now = Date.now();
    const code = newCode();
    const expires = new Date(now + CODE_MINUTES * 60_000).toISOString();
    const id = newToken(16);
    await codes.insertOne({
      _id: id,
      email,
      purpose: "signin",
      hash: await seal(linksFor(ctx), codeText("signin", email, code)),
      tries: 0,
      expires,
      until: expires,
      at: new Date(now).toISOString(),
    });
    // The one sent before stays good until this one went.
    try {
      await deliver(ctx, "signin", email, { code }, input.host);
    } catch (error) {
      await codes.deleteOne({ _id: id });
      throw error;
    }
    await codes.deleteMany({ email, purpose: "signin", _id: { $ne: id } });
    return { email };
  },
});

export const enterAction = defineAction({
  description: "Signs in with the code sent to the address: the person, and a new session",
  record: false,
  input: {
    type: "object",
    properties: { email: EMAIL, code: CODE, name: NAME, address: ADDRESS },
    required: ["email", "code"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    offered(ctx);
    const email = emailIn(input.email);
    await aTry(ctx, { account: email, address: input.address }, byEmail(ctx));
    if (!await redeem(ctx, linksFor(ctx), "signin", email, codeIn(input.code))) {
      throw failure("invalid", WRONG_CODE, { public: true });
    }
    const db = ctx.as().db;
    const logins = db.collection<Login>("email_login");
    const login = await logins.findOne({ _id: email });
    const { person, new: made } = await personFor(ctx, email, login);
    const now = new Date().toISOString();
    // The address is theirs: confirmed, and whatever password it has stays.
    await logins.updateOne({ _id: email }, {
      $set: { person, verified: true, at: login?.at ?? now },
    }, { upsert: true });
    await db.collection("email_code").deleteMany({ email, purpose: "signin" });
    await keepPerson(ctx, person, { email, name: input.name });
    return { person, session: await sessionFor(ctx, person), new: made };
  },
});
