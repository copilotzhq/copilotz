/**
 * `email.sign-in` `{ email, password }`: a session for whoever's address and
 * password these are. A password hashed the old way (or weaker than now) is
 * hashed again, now that it's typed. An address not confirmed yet, whose
 * sign-up this password is, is refused with `unverified`, and a new code
 * goes to it (unless several went this hour: then the last one still works),
 * for the page to ask for it. Anything else is one refusal (`unauthorized`),
 * as slow for an address nobody has, so it says nothing about who has one.
 * The route passes who calls (`address`) for the limits. Unrecorded: its
 * input holds the password, its answer the session.
 */
import { defineAction, failure } from "../../../../runtime/mod.ts";
import type { Code } from "../collections/code.ts";
import type { Login } from "../collections/login.ts";
import { issue } from "../shared/codes.ts";
import { ADDRESS, EMAIL, emailIn, PASSWORD } from "../shared/inputs.ts";
import { aSend, aTry } from "../shared/limits.ts";
import { mail } from "../shared/mail.ts";
import { hashPassword, noPassword, stale, verifyPassword } from "../shared/password.ts";
import { sessionFor } from "../shared/people.ts";
import { linksFor } from "../shared/settings.ts";

const WRONG = "That email and password don't match.";

export const signInAction = defineAction({
  description: "Signs in with an email and a password: the person, and a new session",
  record: false,
  input: {
    type: "object",
    properties: { email: EMAIL, password: PASSWORD, address: ADDRESS },
    required: ["email", "password"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const email = emailIn(input.email);
    await aTry(ctx, { email, address: input.address });
    const db = ctx.as().db;
    const logins = db.collection<Login>("email_login");
    const login = await logins.findOne({ _id: email });
    if (login?.hash && login.verified) {
      if (!await verifyPassword(input.password, login.hash)) {
        throw failure("unauthorized", WRONG, { public: true });
      }
      if (stale(login.hash)) {
        await logins.updateOne({ _id: email }, {
          $set: { hash: await hashPassword(input.password) },
        });
      }
      return { person: login.person, session: await sessionFor(ctx, login.person) };
    }
    // Not confirmed yet: a sign-up waiting with this password gets a new code.
    const waiting = await db.collection<Code>("email_code")
      .find({ email, purpose: "verify" }).sort({ at: -1 }).toArray();
    for (const signUp of waiting) {
      if (!signUp.pending || !await verifyPassword(input.password, signUp.pending)) continue;
      const room = await aSend(ctx, { email }).then(() => true, (error) => {
        if ((error as { code?: string }).code === "too_many") return false;
        throw error;
      });
      if (room) await mail(ctx, "verify", email, { code: await issue(ctx, linksFor(ctx), signUp) });
      throw failure(
        "unverified",
        room
          ? "Confirm your email first: we've sent a new code to it."
          : "Confirm your email first: enter the code we sent to it.",
        { public: true },
      );
    }
    if (!waiting.length) await noPassword(input.password);
    throw failure("unauthorized", WRONG, { public: true });
  },
});
