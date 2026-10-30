/**
 * Whether an agent may do something at a desk (a computer, in one space):
 * what the settings don't ask about, or what the one who answers there
 * (`owner`: the person it works for, or the computer's owner) let it do:
 * always, in this conversation, or this once, used up now. Otherwise they're
 * asked (an approval, waiting), and the agent is told to wait for them.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Approval } from "../collections/approval.ts";
import type { Grant } from "../collections/grant.ts";
import { type Asked, settingsOf } from "./settings.ts";

export type Ask = {
  /** Who answers. */
  owner: string;
  /** Whom the agent works for. */
  for: string;
  desk: string;
  computer: string;
  /** The computer's name, as it's shown. */
  name?: string;
  agent: string;
  thread: string;
  in?: string;
  work: Asked;
  detail: string;
  /** What a write or an edit would do, shortly. */
  preview?: string;
};

/** True: go ahead. A string: what the agent is told instead (it waits for its person). */
export async function allowed(ctx: Context, ask: Ask): Promise<true | string> {
  if (!settingsOf(ctx).approve.includes(ask.work)) return true;
  const system = ctx.as();
  const grants = system.db.collection<Grant>("grant");
  const found = await grants.findOne({
    desk: ask.desk,
    owner: ask.owner,
    agent: ask.agent,
    work: ask.work,
    $or: [
      { thread: { $exists: false }, once: { $exists: false } },
      { thread: ask.thread, once: { $exists: false } },
      { once: ask.detail, thread: ask.thread },
    ],
  });
  if (found) {
    if (found.once !== undefined) await grants.deleteOne({ _id: found._id });
    return true;
  }
  const approvals = system.db.collection<Omit<Approval, "_id">>("approval");
  const waiting = await approvals.findOne({
    desk: ask.desk,
    owner: ask.owner,
    thread: ask.thread,
    agent: ask.agent,
    work: ask.work,
    detail: ask.detail,
    status: "pending",
  });
  if (!waiting) {
    await approvals.insertOne({ ...ask, status: "pending", at: new Date().toISOString() });
  }
  const what =
    { terminal: "run this", jobs: "start this job", writes: "change this file" }[ask.work];
  const whose = ask.owner === ask.for ? "their" : `${ask.owner}'s`;
  return `Waiting for ${ask.owner}'s yes to ${what} on ${whose} computer: ${ask.detail}\n` +
    `${ask.owner === ask.for ? "They see" : `${ask.owner}, whose computer it is, sees`} your ` +
    "request where they talk with you, and answers there (yes once, for this conversation, " +
    "always, or no). Tell them what you want to do and why, then wait: don't try again until " +
    "it's answered.";
}
