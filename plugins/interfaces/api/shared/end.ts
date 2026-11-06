/**
 * A key ending, however it ends (revoked, its person out of its space, taken
 * out of the space's members): its record goes, so its secret proves nobody;
 * its membership goes; and its connections close. As the system: whoever
 * may end it was checked before.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { actorOf, type ApiKey } from "../collections/key.ts";

export async function endKey(ctx: Context, key: ApiKey): Promise<void> {
  const system = ctx.as();
  await system.db.collection("api_key").deleteOne({ _id: key._id });
  const membership = `${key.in}|key:${key._id}`;
  if (await system.db.collection("member").findOne({ _id: membership })) {
    await system.call("member.remove", { space: key.in, member: { kind: "key", id: key._id } });
  }
  await ctx.disconnect(actorOf(key));
}
