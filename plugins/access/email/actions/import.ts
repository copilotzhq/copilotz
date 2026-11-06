/**
 * `email.import` `{ person, email, hash, name?, at? }`: someone moving in from
 * another app with their password as it was hashed there: the person (by the
 * id the importer chose), their address confirmed, and their login with
 * that hash, kept as it is (legacy `salt:hash` hex, or ours: see
 * shared/password.ts). It's made again, stronger, the first time they sign
 * in. Run again, it updates what it made; an address that's someone else's
 * already is refused. The system's alone (a migration), and unrecorded: its
 * input holds the hash.
 */
import { defineAction, failure } from "../../../../runtime/mod.ts";
import type { Login } from "../collections/login.ts";
import { EMAIL, emailIn, NAME } from "../shared/inputs.ts";
import { readable } from "../shared/password.ts";
import { keepPerson } from "../shared/people.ts";

export const importAction = defineAction({
  description: "Brings in a person with a confirmed address and their password's hash as it is",
  record: false,
  input: {
    type: "object",
    properties: {
      person: { type: "string", minLength: 1, maxLength: 200 },
      email: EMAIL,
      hash: { type: "string", maxLength: 300 },
      name: NAME,
      /** When they came, as the other app had it (ISO 8601). */
      at: { type: "string", maxLength: 40 },
    },
    required: ["person", "email", "hash"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const email = emailIn(input.email);
    if (!readable(input.hash)) {
      throw failure("invalid", `${email}: not a password hash email sign-in reads`);
    }
    const logins = ctx.as().db.collection<Login>("email_login");
    const login = await logins.findOne({ _id: email });
    if (login && login.person !== input.person) {
      throw failure("invalid", `${email} is someone else's already (${login.person})`);
    }
    const now = new Date().toISOString();
    await logins.updateOne({ _id: email }, {
      $set: {
        person: input.person,
        verified: true,
        hash: input.hash,
        changed: login?.hash === input.hash ? login.changed ?? now : now,
        at: login?.at ?? input.at ?? now,
      },
    }, { upsert: true });
    await keepPerson(ctx, input.person, { email, name: input.name, at: input.at });
    return { person: input.person, new: !login };
  },
});
