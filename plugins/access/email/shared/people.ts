/**
 * Who an address is, as identity knows people: the person its login says;
 * else someone a sign-in already verified it for (a Google sign-in with that
 * email: proving the inbox again is the same person, now with a password);
 * else someone new (`email:<random>`, or the id the caller chose). And what
 * a sign-in keeps of them (identity's `person`: their email, a name if they
 * had none), and the session it ends with.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Person } from "../../identity/contract.ts";
import type { Login } from "../collections/login.ts";
import { newToken } from "./codes.ts";

/** The person an address is (see above), and whether they're new. */
export async function personFor(
  ctx: Context,
  email: string,
  login: Login | null,
  chosen?: string,
): Promise<{ person: string; new: boolean }> {
  if (login) return { person: login.person, new: false };
  const known = await ctx.as().db.collection<Person>("person").findOne({ email }, {
    sort: { at: 1 },
  });
  if (known) return { person: known._id, new: false };
  return { person: chosen ?? `email:${newToken(12)}`, new: true };
}

/**
 * Keeps what a sign-in proved about a person: their email (identity's
 * `person.email`, what invitations find people by), the name they gave when
 * they have none (and never chose one: `person.rename`), and when they came
 * (`at`, kept from before; an import's).
 */
export async function keepPerson(
  ctx: Context,
  person: string,
  given: { email: string; name?: string; at?: string },
): Promise<void> {
  const people = ctx.as().db.collection<Person>("person");
  const known = await people.findOne({ _id: person });
  const name = given.name?.trim();
  await people.updateOne({ _id: person }, {
    $set: {
      email: given.email,
      ...(name && !known?.name && !known?.named ? { name } : {}),
      at: known?.at ?? given.at ?? new Date().toISOString(),
    },
  }, { upsert: true });
}

/** A new session for a person: what a sign-in that ends signed in answers. */
export async function sessionFor(ctx: Context, person: string): Promise<string> {
  const { session } = await ctx.call<{ session: string }>("session.start", { person });
  return session;
}

/**
 * An address's password set, by someone who proved the address is theirs (a
 * code, a link): its login is theirs, verified, with the new hash; and
 * nothing waits for it anymore (sign-ups, codes, links: all settled).
 */
export async function keepPassword(
  ctx: Context,
  email: string,
  person: string,
  hash: string,
  login: Login | null,
): Promise<void> {
  const db = ctx.as().db;
  const now = new Date().toISOString();
  await db.collection<Login>("email_login").updateOne({ _id: email }, {
    $set: {
      person,
      verified: true,
      hash,
      changed: hash === login?.hash ? login.changed ?? now : now,
      at: login?.at ?? now,
    },
  }, { upsert: true });
  await db.collection("email_code").deleteMany({ email });
}
