/** Delivering a message: the turns it starts and the waits it checks off; and agents' answers. */
import {
  type Context,
  grant,
  personOf,
  type Resources,
  type TransactionScope,
} from "../../../../runtime/mod.ts";
import type { LlmState } from "../../../models/contract.ts";
import { CUT_SHORT, type Intent, NOT_SENT } from "../collections/intent.ts";
import type { Approval } from "../collections/approval.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import type { Wait } from "../collections/wait.ts";
import { agentsNamed, NO_ANSWER, now, SEND } from "./agents.ts";
import { originOf } from "./origin.ts";
import { noted, startedWith } from "./summary.ts";
import { beyond, nameOf, namesFor } from "../../../access/spaces/contract.ts";
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
  how: {
    failed?: boolean;
    stopped?: boolean;
    told?: Told[];
    state?: LlmState;
    knew?: string;
  } = {},
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
    // How far its turn had read this thread.
    ...(how.knew ? { knew: how.knew } : {}),
    at: now(),
  };
  // Handed over from another space: the answer goes back there too, where its sender waits, when
  // everyone there could see all this work may read (from someone's own Personal space, they do).
  // Otherwise, whoever handed it over says where it goes (`asked`): back there, or to them alone.
  const wider = back ? await beyond(ctx, `thread:${back.thread}`) : undefined;
  const asker = wider ? personOf(ctx.actor) : undefined;
  const returned = back && !wider ? backOf(reply, trigger!, back, thread?.in) : undefined;
  // What it handed back without asking, which nobody can be asked about: a word that it didn't.
  const kept = back && wider && !asker
    ? keptOf(reply, trigger!, back, thread?.in, "The answer stayed where it was written.")
    : undefined;
  const asked = back && wider && asker
    ? {
      _id: `${run}:back`,
      owner: asker,
      for: asker,
      agent: t.agent,
      thread: back.thread,
      ...(back.in ? { in: back.in } : {}),
      work: BACK,
      on: wider.to,
      detail: wider.named,
      text: wider.contacts
        ? `send its answer to ${wider.named}`
        : `post its answer in ${wider.named}`,
      name: wider.named,
      people: wider.people,
      ...(text.trim() ? { preview: shortly(text) } : {}),
      answers: ["here", "me"],
      reply: reply._id,
      ...(originOf(ctx.actor) ? { origin: originOf(ctx.actor) } : {}),
      status: "pending",
      at: now(),
    }
    : undefined;
  // Back where it came from, which the agent doesn't work in: a grant of its own, on the record.
  const there = returned ?? kept;
  const writer = there ? ctx.as(grant("chat.hand-back")) : ctx;
  const deliver = await delivery(writer, there ?? reply, (there ?? reply).thread, !how.stopped);
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
    if (there) {
      await tx.db.collection("message").insertOne(there);
      await noted(tx, there);
    }
    if (asked) await tx.db.collection("approval").insertOne(asked);
    await deliver(tx);
  });
};

/** An ask about an answer handed back (`approval.work`): post it where it came from, or not. */
export const BACK = "back";

/** The most of an answer its ask shows. */
const PREVIEW = 600;
const shortly = (text: string) =>
  text.length > PREVIEW ? `${text.slice(0, PREVIEW - 1).trimEnd()}…` : text;

/** Where an answer handed back came from, as its message there says it: the other space's chat. */
const viaOf = (reply: Pick<Message, "thread">, back: Back, space?: string) => ({
  kind: DELEGATED,
  name: (back.from ?? "Another space").slice(0, 120),
  path: `/thread/${encodeURIComponent(reply.thread)}${
    space ? `?in=${encodeURIComponent(space)}` : ""
  }`,
});

type Back = NonNullable<Message["back"]>;

/**
 * An answer, as it goes back where its work was handed over from (`back`):
 * the same words, to whoever handed it over, saying where it came from. It
 * replies to the message that handed it over: its sender's wait is checked off.
 */
const backOf = (
  reply: Message & { hops: number },
  trigger: Pick<Message, "from">,
  back: Back,
  space?: string,
): Message & { hops: number } => {
  const { told: _, state: __, knew: ___, in: ____, ...copy } = reply;
  return {
    ...copy,
    _id: `${reply.turn}:back`,
    thread: back.thread,
    ...(back.in ? { in: back.in } : {}),
    to: [trigger.from],
    via: viaOf(reply, back, space),
  };
};

/**
 * Not the answer, where its work was handed over from: a word that it went
 * elsewhere (`said`), so whoever waits there on it goes on without it.
 */
const keptOf = (
  reply: Message & { hops: number },
  trigger: Pick<Message, "from">,
  back: Back,
  space: string | undefined,
  said: string,
): Message & { hops: number } => {
  const { failed: _, stopped: __, ...word } = backOf(reply, trigger, back, space);
  return { ...word, text: said };
};

/** What an answer handed back that waits on its asker is about: its answer, and where it was. */
async function heldOf(ctx: Context, asked: Approval) {
  const system = ctx.as();
  const messages = system.db.collection<Message & { hops: number }>("message");
  const reply = asked.reply ? await messages.findOne({ _id: asked.reply }) : null;
  const trigger = reply?.replyTo ? await messages.findOne({ _id: reply.replyTo }) : null;
  if (!reply || !trigger?.back) return undefined;
  return { reply, trigger, back: trigger.back };
}

/**
 * Its asker's answer to where an answer handed back goes: back where its
 * work was handed over from (`here`), as it would have gone; or to them
 * alone (`me`), in a conversation of its own in their Personal space, with a
 * word there that it went to them, so whoever waits on it goes on.
 */
export async function handBack(ctx: Context, asked: Approval, to: "here" | "me"): Promise<void> {
  const held = await heldOf(ctx, asked);
  if (!held) return;
  const { reply, trigger, back } = held;
  const writer = ctx.as(grant("chat.hand-back"));
  if (to === "here") {
    const returned = backOf(reply, trigger, back, reply.in);
    const deliver = await delivery(writer, returned, returned.thread);
    await writer.transaction(async (tx) => {
      await tx.db.collection("message").insertOne(returned);
      await noted(tx, returned);
      await deliver(tx);
    });
    return;
  }
  const { space } = await ctx.call<{ space: string }>("space.personal", {});
  const person = personOf(ctx.actor)!;
  const names = await namesFor(ctx, [person]);
  const from = await ctx.as().db.collection<Thread>("thread").findOne({ _id: reply.thread });
  const at = now();
  const mine = `${reply.turn}:mine`;
  const word = keptOf(
    reply,
    trigger,
    back,
    reply.in,
    `The answer went to ${nameOf(person, names)} only.`,
  );
  const deliver = await delivery(writer, word, word.thread);
  await writer.transaction(async (tx) => {
    const message = {
      _id: `${mine}:answer`,
      thread: mine,
      in: space,
      from: reply.from,
      to: [person],
      text: reply.text ?? "",
      hops: 0,
      via: viaOf(reply, back, reply.in),
      at,
    };
    await tx.db.collection("thread").insertOne({
      _id: mine,
      title: from?.title ?? (reply.text ?? "").slice(0, 80),
      in: space,
      at,
      ...startedWith(message),
    });
    await tx.db.collection("message").insertOne(message);
    await tx.db.collection("message").insertOne(word);
    await noted(tx, word);
    await deliver(tx);
  });
}

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
