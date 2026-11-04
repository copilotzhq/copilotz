/** Delivering a message: the turns it starts and the waits it checks off; and agents' answers. */
import type { Context, Resources, TransactionScope } from "../../../../runtime/mod.ts";
import type { LlmState } from "../../../models/contract.ts";
import { CUT_SHORT, type Intent, NOT_SENT } from "../collections/intent.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import type { Wait } from "../collections/wait.ts";
import { agentsNamed, NO_ANSWER, now, SEND } from "./agents.ts";
import { noted } from "./summary.ts";
import { sharedWith } from "../../../access/spaces/contract.ts";
import { DELEGATED, settingsOf, type Step, type Told, type Turn } from "./types.ts";

/**
 * The timer a sender's quiet window is (see `delivery`'s `quiet`): each of
 * their messages sets it again, and nobody else's does.
 */
export const quietId = (thread: string, sender: string, agent: string) =>
  `quiet:${thread}:${sender}:${agent}`;

/** Whether a message after `hops` agent messages in a row may still start a turn. */
export const starts = (ctx: { resources: Resources }, hops: number) => {
  const { maxHops } = settingsOf(ctx);
  return maxHops === undefined || hops <= maxHops;
};

/**
 * What delivering a message does, decided before its transaction: each
 * agent it is addressed to either checks it off a wait (a reply it waits
 * for) or gets a turn. People get nothing here; they see it in the thread.
 */
export const delivery = async (
  ctx: Context,
  m: {
    _id: string;
    thread: string;
    from: string;
    to: string[];
    replyTo?: string;
    hops: number;
    via?: { kind: string };
  },
  /** Where the turns it starts run: its thread, or the subthread hanging from it. */
  where = m.thread,
  /** False: it checks off waits but starts no turn (an answer to a stop). */
  start = true,
  /**
   * Ms its sender may write on before agents answer (a customer who writes in
   * bursts): each turn it starts waits that long, and a message sent meanwhile
   * waits again in its place, so the agent answers them all, once.
   */
  quiet = 0,
) => {
  const agents = await agentsNamed(ctx, m.to);
  const waits = ctx.db.collection<Wait>("wait");
  const steps: ((tx: TransactionScope) => Promise<unknown> | void)[] = [];
  for (const name of m.to) {
    // An agent doesn't start itself, where it is; handed between spaces, it's other work.
    if (!agents[name] || (name === m.from && m.via?.kind !== DELEGATED)) continue;
    // An agent's open waits: one query per agent, which the owner keeps cached.
    const waiting = m.replyTo
      ? (await waits.find({ agent: name, "waitingFor.0": { $exists: true } }))
        .find((w) => w.waitingFor.includes(m.replyTo!))
      : undefined;
    if (waiting) {
      steps.push((tx) =>
        tx.db.collection("wait").updateOne(
          { _id: waiting._id, waitingFor: m.replyTo },
          { $pull: { waitingFor: m.replyTo }, $push: { received: m._id } },
          NO_ANSWER,
        )
      );
    } else if (start && starts(ctx, m.hops)) {
      const turn = { thread: where, agent: name, trigger: m._id, hops: m.hops };
      steps.push((tx) =>
        quiet > 0
          ? void tx.schedule("chat.quiet", turn, {
            at: Date.now() + quiet,
            id: quietId(where, m.from, name),
          })
          : tx.emit("turn.requested", turn, { id: `${m._id}:${name}` })
      );
    }
  }
  return async (tx: TransactionScope) => {
    for (const step of steps) await step(tx);
  };
};

/**
 * An agent's answer to what started its turn, addressed back to its sender.
 * A turn that failed or was stopped answers too, so whoever waits on it
 * resumes; a stopped one starts no new turn, and ends its own wait. It keeps
 * the step it was taking, if its calls were written: what each returned, or
 * that it never did, for people and for its later turns to see.
 */
export const answer = async (
  ctx: Context,
  t: Turn,
  run: string,
  text: string,
  how: { failed?: boolean; stopped?: boolean; told?: Told[]; state?: LlmState } = {},
  /** The turn's thread, when it has it already. */
  known?: Pick<Thread, "in">,
) => {
  const messages = ctx.db.collection<Message>("message");
  const [trigger, thread, open] = await Promise.all([
    messages.findOne({ _id: t.trigger }),
    known ?? ctx.db.collection<Thread>("thread").findOne({ _id: t.thread }),
    // A turn ending this way may have been taking a step: it's kept.
    how.failed || how.stopped ? ctx.db.collection<Intent>("intent").findOne({ _id: run }) : null,
  ]);
  const back = trigger?.back && trigger.expectReply !== false ? trigger.back : undefined;
  const reply = {
    _id: `${run}:reply`,
    thread: t.thread,
    ...(thread?.in ? { in: thread.in } : {}),
    from: t.agent,
    to: !back && trigger && trigger.expectReply !== false && trigger.from !== t.agent
      ? [trigger.from]
      : [],
    text,
    replyTo: t.trigger,
    hops: t.hops + 1,
    turn: run,
    ...(how.failed ? { failed: true } : {}),
    ...(how.stopped ? { stopped: true } : {}),
    // What it was told this turn, when it's the turn's first message.
    ...(how.told?.length ? { told: how.told } : {}),
    // Its model's state (its thinking), for that model's next calls: private, like `told`.
    ...(how.state ? { state: how.state } : {}),
    at: now(),
  };
  // Handed over from another space: the answer goes back there too, where its sender waits. Into
  // a chat shared with someone outside its space (a contact), it says where it came from: only
  // those who reach that space read it there.
  const outside = back && thread?.in ? (await sharedWith(ctx, "thread", back.thread)).length : 0;
  const returned = back
    ? {
      ...reply,
      _id: `${run}:back`,
      thread: back.thread,
      ...(back.in ? { in: back.in } : {}),
      to: [trigger!.from],
      via: {
        kind: DELEGATED,
        name: (back.from ?? "Another space").slice(0, 120),
        path: `/thread/${encodeURIComponent(t.thread)}${
          thread?.in ? `?in=${encodeURIComponent(thread.in)}` : ""
        }`,
      },
      told: undefined,
      state: undefined,
      ...(outside ? { sources: [thread!.in!] } : {}),
    }
    : undefined;
  const writer = returned ? ctx.as() : ctx;
  const deliver = await delivery(
    writer,
    returned ?? reply,
    (returned ?? reply).thread,
    !how.stopped,
  );
  await writer.transaction(async (tx) => {
    // What showed live while it was written becomes the reply.
    await tx.db.collection("live").deleteOne({ _id: run }, NO_ANSWER);
    if (how.stopped) await tx.db.collection("wait").deleteOne({ _id: `${run}:wait` }, NO_ANSWER);
    if (open) {
      await tx.db.collection("intent").deleteOne({ _id: run }, NO_ANSWER);
      await tx.db.collection("message").insertOne(stepOf(open, run, thread?.in));
    }
    await tx.db.collection("message").insertOne(reply);
    await noted(tx, reply);
    if (returned) {
      const { told: _, state: __, ...copy } = returned;
      await tx.db.collection("message").insertOne(copy);
      await noted(tx, copy);
    }
    await deliver(tx);
  });
};

/**
 * The step a turn was taking when it ended without committing it: each call
 * with what it returned, or that it never returned (its messages unsent).
 */
const stepOf = (open: Intent, run: string, space?: string) => ({
  _id: `${run}:${open.step}`,
  thread: open.thread,
  ...(space ? { in: space } : {}),
  from: open.agent,
  to: [],
  private: true,
  ...(open.text ? { text: open.text } : {}),
  toolCalls: open.calls.map((call, i): Step => ({
    ...call,
    output: open.outputs[i] ?? (call.name === SEND ? NOT_SENT : CUT_SHORT),
  })),
  ...(open.state ? { state: open.state } : {}),
  ...(open.told ? { told: open.told } : {}),
  turn: run,
  at: open.at,
});
