/**
 * `contact.prune`: what's past goes. The web lines' counters whose window is
 * over, visitors' records past their time (an erased one's too, only then:
 * until no cookie made before its erasure could be good, whatever its
 * line's days are now, its record is what says it's no one),
 * and a contact made for a first message that never went in: its record
 * says it hasn't spoken, ten minutes on, and its chat holds nothing it said.
 * That one goes with its chat and its access, as an erasure does. The
 * plugin's schedule calls it every ten minutes; nobody outside may.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Visitor } from "../collections/visitor.ts";
import { CONTACT } from "../../../access/contacts/contract.ts";

/** How long a first message has to go in before its contact goes. */
const QUIET = 10 * 60_000;

/** How many it looks at a run: the rest wait for the next. */
const BATCH = 200;

export const pruneAction = defineAction({
  description: "Drops web visitors' counters and records that are past, and contacts never heard",
  input: { type: "object", additionalProperties: false },
  record: false,
  run: async (ctx) => {
    const system = ctx.as();
    const now = Date.now();
    await system.db.collection("contact_rate").deleteMany({ until: { $lte: now } });
    const visitors = system.db.collection<Visitor>("contact_visitor");
    await visitors.deleteMany({ expires: { $lte: new Date(now).toISOString() } });
    const quiet = await visitors.find(
      { spoke: false, ended: { $ne: true }, at: { $lte: new Date(now - QUIET).toISOString() } },
      { limit: BATCH },
    );
    let gone = 0;
    for (const visitor of quiet) {
      const said = await system.db.collection("message").findOne({
        thread: visitor.thread,
        from: `${CONTACT}${visitor._id}`,
      });
      if (said) {
        await visitors.updateOne({ _id: visitor._id }, { $set: { spoke: true } });
        continue;
      }
      // Never heard: its chat, its access, its record and itself go.
      const there = await system.db.collection("thread").findOne({ _id: visitor.thread });
      if (there) await system.call("chat.erase", { thread: visitor.thread });
      await system.transaction(async (tx) => {
        await tx.db.collection("member").deleteMany({ member: `${CONTACT}${visitor._id}` });
        await tx.db.collection("contact").deleteOne({ _id: visitor._id });
        await tx.db.collection("contact_visitor").deleteOne({ _id: visitor._id });
      });
      gone++;
    }
    return { gone };
  },
});
