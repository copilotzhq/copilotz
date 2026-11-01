/**
 * A person is out of a space: what they brought there goes with them (their
 * computers' desks), and their yeses and what waits on them there. Out of the
 * org, so are their own computers; a cloud computer stays for those who run the
 * org to destroy. However they left: this follows the membership.
 */
import type { ProcessorDef } from "../../../../runtime/mod.ts";
import { ORG } from "../../../access/spaces/contract.ts";
import type { Desk } from "../collections/desk.ts";
import { removeDesk } from "../shared/desks.ts";

export const leftProcessor: ProcessorDef = {
  on: "member.deleted",
  run: async (ctx, event) => {
    const id = String(event.data._id);
    const at = id.lastIndexOf("|");
    const [space, member] = [id.slice(0, at), id.slice(at + 1)];
    if (!member.startsWith("person:")) return;
    const person = member.slice("person:".length);
    const { db } = ctx.as();
    if (space === ORG) {
      await db.collection("desk").deleteMany({ owner: person });
      await db.collection("computer").deleteMany({
        owner: person,
        "status.kind": { $ne: "cloud" },
      });
      await db.collection("grant").deleteMany({ owner: person });
      await db.collection("approval").deleteMany({ $or: [{ owner: person }, { for: person }] });
      return;
    }
    for (const desk of await db.collection<Desk>("desk").find({ in: space })) {
      if (desk.owner === person) await removeDesk(ctx, desk);
      else await db.collection("grant").deleteMany({ desk: desk._id, owner: person });
    }
    await db.collection("approval").deleteMany({ in: space, for: person });
  },
};
