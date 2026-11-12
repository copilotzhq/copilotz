/**
 * Whether the caller may do something in a space (`read`, `write`, `manage`):
 * what reach says, with every limit on them; and whether they're there at all
 * (`present`: the space, or a document in it, such as a contact's chat).
 * Trusted code asks here before it goes on as the system, and no one else
 * works this out.
 */
import { type Context, forbidden, personOf } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";
import { audienceOf, type Beyond, beyond as beyondOf, shownAt } from "./audience.ts";
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

/**
 * Who a document is shared with on its own (a chat's contacts:
 * `contact:c1`), read as the system: none for one that isn't.
 */
export async function sharedWith(
  ctx: Pick<Context, "as">,
  on: string,
  id: string,
): Promise<string[]> {
  const found = await ctx.as().db.collection<Member>("member").find({ space: docKey(on, id) });
  return found.map((m) => m.member);
}

/**
 * Whether what the caller's work writes to `to` (a space, or a
 * conversation: `thread:<id>`) would show it to someone who can't see all
 * that work may read (its bound, reach.ts): where it would show, as people
 * say it, and how many would see it there. Undefined when everyone there
 * could, or the caller's work isn't narrowed (a person's own, the
 * system's). Code that writes somewhere for an agent's work itself (an
 * answer handed back) asks here first, as the rules do of the work's own
 * writes. Read as the system: deciding it reads what the caller may not.
 */
export async function beyond(ctx: Context, to: string): Promise<Beyond | undefined> {
  return ctx.actor ? await beyondOf(ctx.actor, to, ctx.as()) : undefined;
}

/**
 * Who'd see what's written to `to` (a space, or a conversation:
 * `thread:<id>`): where it shows, as people say it, and how many would see
 * it there (a space's people; a conversation shared with contacts, its
 * contacts). For asking someone about a share. Read as the system.
 */
export async function audience(ctx: Context, to: string): Promise<Beyond> {
  const system = ctx.as();
  const target = await shownAt(to, system);
  return { to: target, ...await audienceOf(target, system) };
}
