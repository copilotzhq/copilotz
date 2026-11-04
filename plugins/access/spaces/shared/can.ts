/**
 * Whether the caller may do something in a space (`read`, `write`, `manage`):
 * what reach says, with every limit on them; and whether they're there at all
 * (`present`: the space, or a document in it, such as a contact's chat).
 * Trusted code asks here before it goes on as the system, and no one else
 * works this out.
 */
import { type Context, forbidden, personOf } from "../../../../runtime/mod.ts";
import { docKey, reachOf, type Verb } from "./reach.ts";

export async function may(
  ctx: Context,
  verb: Verb,
  space: string,
  /** A document of this collection, its id `space`, shared on its own: asked about as itself. */
  on?: string,
): Promise<boolean> {
  const { actor } = ctx;
  if (!actor || actor.kind === "system") return true;
  // Read as the system: what's read to decide labels nothing the caller then writes.
  const held = (await reachOf(actor, ctx.as())).get(on ? docKey(on, space) : space);
  // A document shared on its own is never a space: only asked about as that document.
  return !!held && !!held.on === !!on && held.can.has(verb);
}

/**
 * Whether the caller is in `space` at all: they reach it, or a document in it
 * on its own (a contact, its chat there). What's said to anyone there (who
 * answers in it) is said to them too.
 */
export async function present(ctx: Context, space: string): Promise<boolean> {
  const { actor } = ctx;
  if (!actor || actor.kind === "system") return true;
  const reach = await reachOf(actor, ctx.as());
  return (!!reach.get(space) && !reach.get(space)!.on) ||
    [...reach.values()].some((held) => held.on && held.home === space);
}

/** Throws `forbidden`, with `message`, unless the caller may. */
export async function must(
  ctx: Context,
  verb: Verb,
  space: string,
  message = `You can't ${verb} in that space.`,
): Promise<void> {
  if (!await may(ctx, verb, space)) throw forbidden(message);
}

/** Throws `forbidden`, with `message`, unless it's the caller's own (`owner`), or the caller may. */
export async function mustOwnOr(
  ctx: Context,
  owner: string,
  verb: Verb,
  space: string,
  message: string,
): Promise<void> {
  if (owner !== personOf(ctx.actor)) await must(ctx, verb, space, message);
}
