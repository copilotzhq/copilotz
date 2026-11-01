/**
 * Whether the caller may do something in a space (`read`, `write`, `manage`):
 * what reach says, with every limit on them. Trusted code asks here before it
 * goes on as the system, and no one else works this out.
 */
import { type Context, forbidden, personOf } from "../../../../runtime/mod.ts";
import { reachOf, type Verb } from "./reach.ts";

export async function may(ctx: Context, verb: Verb, space: string): Promise<boolean> {
  const { actor } = ctx;
  if (!actor || actor.kind === "system") return true;
  // Read as the system: what's read to decide labels nothing the caller then writes.
  return (await reachOf(actor, ctx.as())).get(space)?.can.has(verb) ?? false;
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
