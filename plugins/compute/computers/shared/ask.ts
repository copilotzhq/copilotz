/**
 * Whether an agent may do something at a desk (a computer, in one space):
 * what neither its computer nor the settings ask about, or what the one who answers there
 * (`owner`: the person it works for, or the computer's owner) let it do:
 * always, in this conversation, whenever the routine that set it going runs,
 * or this once, used up now. Otherwise they're asked (an approval, waiting),
 * and the agent waits for them. Publishing reaches outside the
 * computer: it's asked every time, and only a yes to that one covers it.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { ToolContext } from "../../../agents/chat/contract.ts";
import type { Approval } from "../collections/approval.ts";
import type { Grant } from "../collections/grant.ts";
import { type Asked, onlyOnce, settingsOf } from "./settings.ts";
import { nameOf, namesFor } from "../../../access/spaces/contract.ts";
import { originKey, originOf } from "../../../agents/chat/contract.ts";

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
  /** What its computer asks about, when it says (the desk's `approve`); else the settings'. */
  approve?: Asked[];
};

/**
 * True: go ahead. A string: what the agent is told instead. In an agent's
 * turn (`ask`), a call that needs a yes asks its person (a question to `for`,
 * its own request, by its `callId`) and the turn waits for the answer; run
 * again once answered, it goes ahead if this call was allowed, or says no.
 * Elsewhere (a model outside), it says what it waits for: one request for
 * the same thing, however often it's asked.
 */
export async function allowed(
  ctx: Context & Partial<Pick<ToolContext, "callId" | "ask" | "answer">>,
  ask: Ask,
): Promise<true | string> {
  const approve = ask.approve ?? settingsOf(ctx).approve;
  if (!onlyOnce(ask.work) && !approve.includes(ask.work)) return true;
  const origin = originOf(ctx.actor);
  const system = ctx.as();
  const grants = system.db.collection<Grant>("grant");
  const approvals = system.db.collection<Omit<Approval, "_id">>("approval");
  const turn = ctx.ask && ctx.callId ? { ask: ctx.ask, call: ctx.callId } : undefined;
  // This call's own request, answered: a yes lets it go (a yes once is used up by it).
  const mine = turn ? await approvals.findOne({ call: turn.call }) : null;
  if (mine?.status === "allowed") {
    await grants.deleteOne({
      desk: ask.desk,
      owner: ask.owner,
      agent: ask.agent,
      work: ask.work,
      once: ask.detail,
      thread: ask.thread,
    });
    return true;
  }
  const found = mine?.status === "denied" ? null : await grants.findOne({
    desk: ask.desk,
    owner: ask.owner,
    agent: ask.agent,
    work: ask.work,
    $or: onlyOnce(ask.work) ? [{ once: ask.detail, thread: ask.thread }] : [
      { thread: { $exists: false }, once: { $exists: false }, origin: { $exists: false } },
      { thread: ask.thread, once: { $exists: false } },
      { once: ask.detail, thread: ask.thread },
      ...(origin ? [{ origin: originKey(origin), rev: origin.rev }] : []),
    ],
  });
  if (found) {
    if (found.once !== undefined) await grants.deleteOne({ _id: found._id });
    return true;
  }
  const what = {
    terminal: "run this",
    jobs: "start this job",
    writes: "change this file",
    publish: "publish this as an app",
    destroy: "destroy",
  }[ask.work];
  // People by name.
  const names = await namesFor(ctx, [ask.owner, ask.for, ...(ctx.answer ? [ctx.answer.from] : [])]);
  const owner = nameOf(ask.owner, names);
  const doingOn = (whose: string) =>
    ask.work === "destroy"
      ? `destroy ${whose} computer for good, with its files`
      : `${what} on ${whose} computer`;
  const doing = doingOn(ask.owner === ask.for ? "their" : `${owner}'s`);
  if (mine?.status === "denied") return `No: ${owner} said no to ${doing}: ${ask.detail}`;
  if (turn) {
    if (mine && ctx.answer) {
      // Answered, but not with a yes (a reply typed to the question): it doesn't run.
      await approvals.deleteOne({ call: turn.call, status: "pending" });
      return `Not run: ${nameOf(ctx.answer.from, names)} answered "${ctx.answer.text}", ` +
        `without allowing you to ${doing}: ${ask.detail}`;
    }
    // Asked as itself: what it asks, the person sees as the agent's question, and answers on its
    // card; the turn waits for that answer.
    const question = turn.ask({
      to: ask.for,
      text: `May I ${doingOn(ask.owner === ask.for ? "your" : `${owner}'s`)}?${
        ask.owner === ask.for ? "" : ` ${owner} answers.`
      }\n${ask.detail}`,
    });
    if (mine) await approvals.updateOne({ call: turn.call }, { $set: { question } });
    else {
      await approvals.insertOne({
        ...ask,
        ...(origin ? { origin } : {}),
        call: turn.call,
        question,
        status: "pending",
        at: new Date().toISOString(),
      });
    }
    return `Waiting for ${owner}'s yes to ${doing}: ${ask.detail}`;
  }
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
    await approvals.insertOne({
      ...ask,
      ...(origin ? { origin } : {}),
      status: "pending",
      at: new Date().toISOString(),
    });
  }
  return `Waiting for ${owner}'s yes to ${doing}: ${ask.detail}\n` +
    `${ask.owner === ask.for ? "They see" : `${owner}, whose computer it is, sees`} your ` +
    "request where they talk with you, and answers there (" +
    (onlyOnce(ask.work)
      ? "yes or no"
      : `yes once, for this conversation, ${
        origin ? `for this ${origin.kind}, ` : ""
      }always, or no`) +
    "). Tell them what you want to do and why, then wait: don't try again until " +
    "it's answered.";
}
