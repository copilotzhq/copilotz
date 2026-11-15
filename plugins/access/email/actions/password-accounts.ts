/**
 * Accounts by identifier, which trusted code makes: password sign-in has no
 * sign-up. An admin's screen calls these through an Action of the app's own
 * that says who may (`allow`, and the app's rule), and an import calls them
 * as the system.
 *
 * - `password.set` `{ person, identifier, password?, name? }`: the person's
 *   account: their identifier (moved there, when they had another), and
 *   their password when it's given (8 characters at least: a password
 *   replaced ends their sessions). Someone new is made under the id given,
 *   with the name (a name they chose stays theirs: `person.rename`).
 * - `password.import` `{ person, identifier, hash, name?, at? }`: someone
 *   moving in with the hash another app kept (bcrypt's `$2a$`, `$2b$` or
 *   `$2y$`, or one email sign-in reads), kept as it is and made again our
 *   way at their first sign-in.
 * - `password.remove` `{ person }`: their account goes, and every session.
 *
 * An identifier that's someone else's is refused (`invalid`). The system's
 * alone (no `allow`), and unrecorded: inputs hold passwords and hashes. What
 * they change in the plugin's records is on the record, without the hash.
 */
import { type Context, defineAction, failure } from "../../../../runtime/mod.ts";
import type { PasswordLogin } from "../collections/password-login.ts";
import { IDENTIFIER, identifierIn } from "../shared/identifiers.ts";
import { NAME, PASSWORD, passwordIn } from "../shared/inputs.ts";
import { hashPassword, readable } from "../shared/password.ts";
import { keepPerson } from "../shared/people.ts";
import { passwordOf } from "../shared/settings.ts";

const PERSON = { type: "string", minLength: 1, maxLength: 200 } as const;

/**
 * The person's account under `identifier`, with `hash` when given (else the
 * one they had), and them as identity knows them. Whether they're new, and
 * whether a password they had was replaced.
 */
async function keep(
  ctx: Context,
  given: { person: string; identifier: string; name?: string; at?: string },
  hash?: string,
): Promise<{ new: boolean; replaced: boolean }> {
  const identifier = identifierIn(given.identifier, passwordOf(ctx).ignore);
  const logins = ctx.as().db.collection<PasswordLogin>("password_login");
  const taken = await logins.findOne({ _id: identifier });
  if (taken && taken.person !== given.person) {
    throw failure("invalid", `"${identifier}" is someone else's.`, { public: true });
  }
  const had = taken ?? await logins.findOne({ person: given.person });
  if (had && had._id !== identifier) await logins.deleteOne({ _id: had._id });
  const now = new Date().toISOString();
  const kept = hash ?? had?.hash;
  await logins.replaceOne({ _id: identifier }, {
    _id: identifier,
    person: given.person,
    ...(kept
      ? { hash: kept, changed: hash && hash !== had?.hash ? now : had?.changed ?? now }
      : {}),
    at: had?.at ?? given.at ?? now,
  }, { upsert: true });
  await keepPerson(ctx, given.person, { name: given.name, at: given.at });
  return { new: !had, replaced: !!hash && !!had?.hash && hash !== had.hash };
}

export const passwordSetAction = defineAction({
  description: "Makes or changes someone's account by identifier, and their password when given",
  record: false,
  input: {
    type: "object",
    properties: { person: PERSON, identifier: IDENTIFIER, password: PASSWORD, name: NAME },
    required: ["person", "identifier"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const hash = input.password === undefined
      ? undefined
      : await hashPassword(passwordIn(input.password));
    const kept = await keep(ctx, input, hash);
    // A password replaced: wherever they were signed in, they're out.
    if (kept.replaced) await ctx.as().call("credential.revoke", { person: input.person });
    return { person: input.person, new: kept.new };
  },
});

export const passwordImportAction = defineAction({
  description: "Brings in someone by identifier with their password's hash as another app kept it",
  record: false,
  input: {
    type: "object",
    properties: {
      person: PERSON,
      identifier: IDENTIFIER,
      hash: { type: "string", maxLength: 300 },
      name: NAME,
      /** When they came, as the other app had it (ISO 8601). */
      at: { type: "string", maxLength: 40 },
    },
    required: ["person", "identifier", "hash"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    if (!readable(input.hash)) {
      throw failure("invalid", `${input.identifier}: not a password hash password sign-in reads`);
    }
    const kept = await keep(ctx, input, input.hash);
    return { person: input.person, new: kept.new };
  },
});

export const passwordRemoveAction = defineAction({
  description: "Removes someone's account by identifier: they sign in that way no more",
  record: false,
  input: {
    type: "object",
    properties: { person: PERSON },
    required: ["person"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const gone = await ctx.as().db.collection("password_login").deleteMany({
      person: input.person,
    });
    if (gone.deletedCount) await ctx.as().call("credential.revoke", { person: input.person });
    return { removed: gone.deletedCount > 0 };
  },
});
