/**
 * Keeping a person's profile (how they show) from what sign-in verified
 * about them: their name, else their email's name; their picture.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Profile } from "../collections/profile.ts";

type Known = { _id: string; name?: string; email?: string; picture?: string };

/** What shows of someone: their name, else what's before the `@` of their email. */
export const shownOf = (person: Known) => ({
  ...(person.name?.trim()
    ? { name: person.name.trim() }
    : person.email
    ? { name: person.email.split("@")[0] }
    : {}),
  ...(person.picture ? { picture: person.picture } : {}),
});

/** Writes it when it changed (or isn't there yet): most calls write nothing. */
export async function keepProfile(ctx: Pick<Context, "as">, person: Known): Promise<void> {
  const profiles = ctx.as().db.collection<Profile>("profile");
  const shown = shownOf(person);
  const had = await profiles.findOne({ _id: person._id });
  if (had && had.name === shown.name && had.picture === shown.picture) return;
  await profiles.updateOne(
    { _id: person._id },
    {
      $set: { ...shown, at: new Date().toISOString() },
      ...(!shown.name && had?.name ? { $unset: { name: "" } } : {}),
    },
    { upsert: true },
  );
}

/** A person's profile kept from their `person` record, if there is one. */
export async function keepProfileOf(ctx: Pick<Context, "as">, id: string): Promise<void> {
  const person = await ctx.as().db.collection<Known>("person").findOne({ _id: id });
  if (person) await keepProfile(ctx, person);
}
