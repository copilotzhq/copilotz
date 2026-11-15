/**
 * Signing in by an identifier and a password (password sign-in):
 *
 * - `password.sign-in` `{ identifier, password }`: a session for whoever's
 *   identifier and password these are. A hash another app made (bcrypt), or
 *   one weaker than now, is made again now that the password is typed.
 *   Anything else is one refusal (`unauthorized`), as slow for an identifier
 *   nobody has, so it says nothing about who has one.
 * - `password.change` `{ password, new }`: a person signed in changes their
 *   own, with the one they have: every session of theirs ends, and a new
 *   one starts. Theirs alone (`inPerson`).
 *
 * The route passes who calls (`address`) for the limits, counted by
 * identifier (`password_rate`). Unrecorded: inputs hold passwords, answers
 * sessions.
 */
import { defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import type { PasswordLogin } from "../collections/password-login.ts";
import { IDENTIFIER, identifierIn } from "../shared/identifiers.ts";
import { ADDRESS, PASSWORD, passwordIn } from "../shared/inputs.ts";
import { aTry, byIdentifier } from "../shared/limits.ts";
import { hashPassword, noPassword, stale, verifyPassword } from "../shared/password.ts";
import { sessionFor } from "../shared/people.ts";
import { passwordOf } from "../shared/settings.ts";

const WRONG = "That username and password don't match.";

export const passwordSignInAction = defineAction({
  description: "Signs in with an identifier and a password: the person, and a new session",
  record: false,
  input: {
    type: "object",
    properties: { identifier: IDENTIFIER, password: PASSWORD, address: ADDRESS },
    required: ["identifier", "password"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const identifier = identifierIn(input.identifier, passwordOf(ctx).ignore);
    await aTry(ctx, { account: identifier, address: input.address }, byIdentifier(ctx));
    const logins = ctx.as().db.collection<PasswordLogin>("password_login");
    const login = await logins.findOne({ _id: identifier });
    if (!login?.hash) {
      await noPassword(input.password);
      throw failure("unauthorized", WRONG, { public: true });
    }
    if (!await verifyPassword(input.password, login.hash)) {
      throw failure("unauthorized", WRONG, { public: true });
    }
    if (stale(login.hash)) {
      await logins.updateOne({ _id: identifier }, {
        $set: { hash: await hashPassword(input.password) },
      });
    }
    return { person: login.person, session: await sessionFor(ctx, login.person) };
  },
});

export const passwordChangeAction = defineAction({
  description: "Changes your password, with the one you have: your other sessions end",
  record: false,
  input: {
    type: "object",
    properties: { password: PASSWORD, new: PASSWORD, address: ADDRESS },
    required: ["password", "new"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const person = ctx.actor!.id;
    const system = ctx.as();
    const logins = system.db.collection<PasswordLogin>("password_login");
    const login = await logins.findOne({ person });
    if (!login) {
      throw failure("not_found", "You don't sign in here with a password.", { public: true });
    }
    await aTry(ctx, { account: login._id, address: input.address }, byIdentifier(ctx));
    if (!login.hash || !await verifyPassword(input.password, login.hash)) {
      throw failure("unauthorized", "That isn't your password.", { public: true });
    }
    const hash = await hashPassword(passwordIn(input.new));
    await logins.updateOne({ _id: login._id }, {
      $set: { hash, changed: new Date().toISOString() },
    });
    // A password replaced: wherever else they were signed in, they're out.
    await system.call("credential.revoke", { person });
    return { person, session: await sessionFor(system, person) };
  },
});
