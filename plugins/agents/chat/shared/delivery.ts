/** Delivering a message: the turns it starts and the waits it checks off; and agents' answers. */
import type { Context, Resources, TransactionScope } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import type { Wait } from "../collections/wait.ts";
import { agentsNamed, NO_ANSWER, now } from "./agents.ts";
import { noted } from "./summary.ts";
import { settingsOf, type Told, type Turn } from "./types.ts";

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
  m: { _id: string; thread: string; from: string; to: string[]; replyTo?: string; hops: number },
  /** Where the turns it starts run: its thread, or the subthread hanging from it. */
  where = m.thread,
  /** False: it checks off waits but starts no turn (an answer to a stop). */
  start = true,
) => {
  const agents = await agentsNamed(ctx, m.to);
  const waits = ctx.db.collection<Wait>("wait");
  const steps: ((tx: TransactionScope) => Promise<unknown> | void)[] = [];
  for (const name of m.to) {
    if (!agents[name] || name === m.from) continue;
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
      steps.push((tx) =>
        tx.emit(
          "turn.requested",
          { thread: where, agent: name, trigger: m._id, hops: m.hops },
          { id: `${m._id}:${name}` },
        )
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
 * resumes; a stopped one starts no new turn, and ends its own wait.
 */
export const answer = async (
  ctx: Context,
  t: Turn,
  run: string,
  text: string,
  how: { failed?: boolean; stopped?: boolean; told?: Told[] } = {},
  /** The turn's thread, when it has it already. */
  known?: Pick<Thread, "in" | "title">,
) => {
  const messages = ctx.db.collection<Message>("message");
  const [trigger, thread] = await Promise.all([
    messages.findOne({ _id: t.trigger }),
    known ?? ctx.db.collection<Thread>("thread").findOne({ _id: t.thread }),
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
    at: now(),
  };
  // Handed over from another space: the answer goes back there too, where its sender waits.
  const returned = back
    ? {
      ...reply,
      _id: `${run}:back`,
      thread: back.thread,
      ...(back.in ? { in: back.in } : {}),
      to: [trigger!.from],
      via: {
        kind: "delegated",
        name: (thread?.title ?? "Another space").slice(0, 120),
        path: `/thread/${encodeURIComponent(t.thread)}${
          thread?.in ? `?in=${encodeURIComponent(thread.in)}` : ""
        }`,
      },
      told: undefined,
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
    await tx.db.collection("message").insertOne(reply);
    await noted(tx, reply);
    if (returned) {
      const { told: _, ...copy } = returned;
      await tx.db.collection("message").insertOne(copy);
      await noted(tx, copy);
    }
    await deliver(tx);
  });
};
