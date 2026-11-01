/**
 * Desks: a computer in a space (see collections/desk.ts). Made here, as the
 * system, once whoever asks may: its folder named after the space, apart
 * from the computer's other folders. And `may`: whether the actor may
 * write in or manage a space, as the spaces plugin says (`space.can`).
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import type { Desk } from "../collections/desk.ts";
import { folderFor } from "./folder.ts";

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
  await system.collection("approval").deleteMany({ desk: desk._id });
  await system.collection("grant").deleteMany({ desk: desk._id });
  if (!desk.default) return;
  const [next] = await system.collection<Desk>("desk").find({ in: desk.in }, {
    sort: { seen: -1 },
    limit: 1,
  });
  if (next) {
    await system.collection("desk").updateOne({ _id: next._id }, { $set: { default: true } });
  }
}
