/**
 * A yes for what a person set up to run (a routine): this agent may do this
 * kind of work at this desk whenever it runs, as it is now. It replaces a yes
 * for an older version, and answers what already waits on it: every run
 * stopped there carries on.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { type Origin, originKey } from "../../../agents/chat/contract.ts";
import type { Approval } from "../collections/approval.ts";
import type { Grant } from "../collections/grant.ts";

export type Letting = {
  owner: string;
  desk: string;
  computer: string;
  agent: string;
  work: string;
  origin: Origin;
};

/** What a person's answer says in the conversation, for this kind of thing. */
export const saidFor = (origin: Pick<Origin, "kind">) => `Yes, for this ${origin.kind}`;

/** The answer, in the conversation, as part of what set it going. */
export async function told(ctx: Context, asked: Approval, text: string): Promise<void> {
  const by = asked.origin ? ctx.as({ ...ctx.actor!, origin: asked.origin }) : ctx;
  await by.call("chat.send", { thread: asked.thread, to: [asked.agent], text });
}

export async function letOrigin(ctx: Context, l: Letting): Promise<void> {
  const now = new Date().toISOString();
  const key = originKey(l.origin);
  const scope = { owner: l.owner, desk: l.desk, agent: l.agent, work: l.work };
  const grants = ctx.db.collection<Grant>("grant");
  // A yes for an older version (a card answered late) leaves one for a newer in place.
  const newer = await grants.findOne({ ...scope, origin: key, rev: { $gt: l.origin.rev } });
  if (!newer) {
    await grants.deleteMany({ ...scope, origin: key });
    await grants.insertOne({
      ...scope,
      computer: l.computer,
      origin: key,
      rev: l.origin.rev,
      at: now,
    } as Grant);
  }
  const approvals = ctx.db.collection<Approval>("approval");
  const waiting = await approvals.find({ ...scope, status: "pending" });
  for (const asked of waiting) {
    if (!asked.origin || originKey(asked.origin) !== key || asked.origin.rev !== l.origin.rev) {
      continue;
    }
    await approvals.updateOne({ _id: asked._id }, {
      $set: { status: "allowed", grant: "origin", decided: now },
    });
    await told(ctx, asked, `${saidFor(asked.origin)}: ${asked.detail}`);
  }
}
