/**
 * Desks: a computer in a space (see collections/desk.ts). Made here, as the
 * system, once whoever asks may: its folder named after the space, apart
 * from the computer's other folders. And `may`: whether the actor may
 * write in or manage a space, as the spaces plugin says (`space.can`).
 */
import { type Context, forbidden } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import type { Desk } from "../collections/desk.ts";
import { folderFor } from "./folder.ts";
import { wake } from "./wake.ts";
import { must } from "../../../access/spaces/contract.ts";

/** A space's name for its folder: "personal" for someone's own, else its name. */
async function nameOf(ctx: Context, space: string) {
  const found = await ctx.as().db.collection<{ name?: string; kind?: string }>("space")
    .findOne({ _id: space });
  return found?.kind === "personal" ? "personal" : found?.name ?? space;
}

/** `computer`'s desk in `space`: the one it has, or a new one (as the system: check first). */
export async function deskIn(
  ctx: Context,
  computer: Pick<
    Computer,
    "_id" | "owner" | "name" | "online" | "seen" | "info" | "approve" | "status"
  >,
  space: string,
  answers: Desk["answers"] = "asker",
): Promise<Desk> {
  const desks = ctx.as().db.collection<Desk>("desk");
  const had = await desks.findOne({ computer: computer._id, in: space });
  if (had) return had;
  const taken = (await desks.find({ computer: computer._id })).map((d) => d.folder);
  const desk = {
    in: space,
    computer: computer._id,
    owner: computer.owner,
    ...(computer.name ? { name: computer.name } : {}),
    online: computer.online,
    ...(computer.seen ? { seen: computer.seen } : {}),
    ...(computer.info ? { info: computer.info } : {}),
    ...(computer.approve ? { approve: computer.approve } : {}),
    ...(computer.status ? { status: computer.status } : {}),
    folder: folderFor(await nameOf(ctx, space), taken),
    answers,
    // The first computer a space has is the one its agents use.
    ...(await desks.findOne({ in: space }) ? {} : { default: true }),
    at: new Date().toISOString(),
  };
  const { insertedId } = await ctx.as().db.collection<Omit<Desk, "_id">>("desk").insertOne(desk);
  return { _id: insertedId, ...desk };
}

/** What every desk of a computer shows of it: kept with it as it changes. */
export const mirror = (ctx: Context, computer: string, fields: Partial<Desk>) =>
  ctx.as().db.collection("desk").updateMany({ computer }, { $set: fields });

/** Takes a desk away: what agents waited on there and what they were let do go too; another becomes the default. */
export async function removeDesk(ctx: Context, desk: Desk) {
  const system = ctx.as().db;
  await system.collection("desk").deleteOne({ _id: desk._id });
  await system.collection("approval").deleteMany({ on: desk._id });
  await system.collection("grant").deleteMany({ on: desk._id });
  if (!desk.default) return;
  const [next] = await system.collection<Desk>("desk").find({ in: desk.in }, {
    sort: { seen: -1 },
    limit: 1,
  });
  if (next) {
    await system.collection("desk").updateOne({ _id: next._id }, { $set: { default: true } });
  }
}

/**
 * A desk a person works on directly (its panel, an upload), by id: only
 * where they may write in its space, and where its owner answers for it,
 * only its owner changes anything (`changes`). What changes something wakes
 * a computer that sleeps (a cloud computer): `woke` says whether it did
 * (`false`: nothing wakes it, as a person's own computer that's off); one
 * that couldn't wake fails (`unavailable`, saying why).
 */
export async function personalDesk(
  ctx: Context,
  id: string,
  changes: boolean,
): Promise<{ desk: Desk; woke?: boolean }> {
  // The rules reach only the desks of spaces the person is in; working there takes more.
  const desk = await ctx.db.collection<Desk>("desk").findOne({ _id: id });
  if (!desk) throw Object.assign(new Error("No such computer here"), { code: "not_found" });
  await must(ctx, "write", desk.in, "You can't work in this space.");
  // Where its owner answers for it, nobody else changes anything on it without them.
  if (desk.answers === "owner" && desk.owner !== ctx.actor!.id && changes) {
    throw forbidden("Its owner keeps this computer's answers: only they work on it directly.");
  }
  if (desk.online || !changes) return { desk };
  const woke = await wake(ctx, desk.computer);
  if (typeof woke === "string") throw Object.assign(new Error(woke), { code: "unavailable" });
  return { desk, woke };
}
