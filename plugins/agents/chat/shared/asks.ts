/**
 * Asking a person before an agent's work goes on: one way for every kind of
 * ask (a computer's command, a share into a space not everyone of the
 * agent's own sees). The plugin that asks says whom (`owner`), about what
 * (`work`, `on`, `detail`), in its words, and which answers it takes
 * (`answers`); chat keeps what was asked (`approval`) and what was let
 * (`grant`), puts the question to the person in the conversation, and holds
 * the turn until they answer (see `ToolContext.ask`).
 *
 * - **Let already.** A yes in this conversation, always, for what set the
 *   work going (a routine, at its version), or once for this very thing,
 *   lets it go without asking. A yes once is used up by what it let.
 * - **Asked in a turn.** The call asks its person (a question to `for`, its
 *   own request, by its `callId`) and the turn waits for the answer; run
 *   again once answered, it goes on if this call was let, or says no.
 * - **Asked elsewhere** (a model outside, over MCP): it says what it waits
 *   for, one request for the same thing however often it's asked.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { nameOf, namesFor } from "../../../access/spaces/contract.ts";
import type { Answer, Approval } from "../collections/approval.ts";
import type { Grant } from "../collections/grant.ts";
import { type Origin, originKey, originOf } from "./origin.ts";
import type { ToolContext } from "./types.ts";

/** What a plugin asks about: the approval as it's kept, but its state; and its own fields too. */
export type Asking =
  & Pick<Approval, "owner" | "for" | "agent" | "thread" | "work" | "on" | "detail" | "answers">
  & Partial<Pick<Approval, "in" | "text" | "covers" | "name" | "people" | "preview">>;

export type Ask = Asking & {
  /** What a yes lets, as a refusal says it to the agent: "run this on their computer". */
  doing: string;
  /** The agent's question to its person, in its own words: "May I run this on your computer?". */
  question: string;
};

/**
 * What each answer says, on the person's card and in the conversation as
 * theirs (`origin` names what set the work going: "Yes, for this routine").
 */
export const SAID: Record<Answer, string> = {
  once: "Yes, this once",
  thread: "Yes, for this conversation",
  origin: "Yes, for this routine",
  always: "Yes, always",
  deny: "No",
  here: "Post here",
  me: "Send it to me only",
};

/** An answer, as it's said for this ask. */
export const said = (answer: Answer, asked: Pick<Approval, "origin">): string =>
  answer === "origin" && asked.origin ? `Yes, for this ${asked.origin.kind}` : SAID[answer];

/** The answers an ask takes, in words, for an agent told to wait: "yes once, …, or no". */
function inWords(answers: Answer[], origin?: Origin): string {
  const yes = answers.filter((a) => a !== "deny");
  if (yes.length === 1 && yes[0] === "once") return "yes or no";
  const words = answers.map((a) =>
    ({
      once: "yes once",
      thread: "for this conversation",
      origin: `for this ${origin?.kind ?? "routine"}`,
      always: "always",
      deny: "no",
      here: "post it here",
      me: "send it to them only",
    })[a]
  );
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")}, or ${words.at(-1)}`;
}

/**
 * True: go ahead. A string: what the agent is told instead. In an agent's
 * turn (`ask`), a call that needs a yes asks its person (a question to `for`,
 * its own request, by its `callId`) and the turn waits for the answer; run
 * again once answered, it goes ahead if this call was let, or says no.
 * Elsewhere (a model outside), it says what it waits for: one request for
 * the same thing, however often it's asked.
 */
export async function ask<A extends Ask>(
  ctx: Context & Partial<Pick<ToolContext, "callId" | "ask" | "answer">>,
  a: A,
): Promise<true | string> {
  const { doing, question: words, ...asking } = a;
  const origin = originOf(ctx.actor);
  const system = ctx.as();
  const grants = system.db.collection<Grant>("grant");
  const approvals = system.db.collection<Omit<Approval, "_id">>("approval");
  const turn = ctx.ask && ctx.callId ? { ask: ctx.ask, call: ctx.callId } : undefined;
  const scope = { owner: a.owner, on: a.on, agent: a.agent, work: a.work };
  // This call's own request about this, answered: a yes lets it go (a yes once is used up by it).
  // A call may ask about more than one thing (a share to two places): each is its own.
  const mine = turn ? await approvals.findOne({ call: turn.call, on: a.on, work: a.work }) : null;
  if (mine?.status === "allowed") {
    await grants.deleteOne({ ...scope, once: a.detail, thread: a.thread });
    return true;
  }
  const only = a.answers.every((answer) => answer === "once" || answer === "deny");
  const found = mine?.status === "denied" ? null : await grants.findOne({
    ...scope,
    $or: only ? [{ once: a.detail, thread: a.thread }] : [
      ...(a.answers.includes("always")
        ? [{ thread: { $exists: false }, once: { $exists: false }, origin: { $exists: false } }]
        : []),
      { thread: a.thread, once: { $exists: false } },
      { once: a.detail, thread: a.thread },
      ...(origin ? [{ origin: originKey(origin), rev: origin.rev }] : []),
    ],
  });
  if (found) {
    if (found.once !== undefined) await grants.deleteOne({ _id: found._id });
    return true;
  }
  // People by name.
  const names = await namesFor(ctx, [a.owner, a.for, ...(ctx.answer ? [ctx.answer.from] : [])]);
  const owner = nameOf(a.owner, names);
  if (mine?.status === "denied") return `No: ${owner} said no to ${doing}: ${a.detail}`;
  // What it waits for, with what set it going (a routine): its answer goes on as part of that run.
  const kept = { ...asking, ...(origin ? { origin } : {}) };
  if (turn) {
    if (mine && ctx.answer) {
      // Answered, but not with a yes (a reply typed to the question): it doesn't run.
      await approvals.deleteOne({ _id: (mine as Approval)._id, status: "pending" });
      return `Not run: ${nameOf(ctx.answer.from, names)} answered "${ctx.answer.text}", ` +
        `without allowing you to ${doing}: ${a.detail}`;
    }
    // Asked as itself: what it asks, the person sees as the agent's question, and answers on its
    // card; the turn waits for that answer.
    const question = turn.ask({ to: a.for, text: words });
    if (mine) await approvals.updateOne({ _id: (mine as Approval)._id }, { $set: { question } });
    else {
      await approvals.insertOne({
        ...kept,
        call: turn.call,
        question,
        status: "pending",
        at: new Date().toISOString(),
      });
    }
    return `Waiting for ${owner}'s yes to ${doing}: ${a.detail}`;
  }
  const waiting = await approvals.findOne({
    ...scope,
    thread: a.thread,
    detail: a.detail,
    status: "pending",
  });
  if (!waiting) {
    await approvals.insertOne({ ...kept, status: "pending", at: new Date().toISOString() });
  }
  return `Waiting for ${owner}'s yes to ${doing}: ${a.detail}\n` +
    `${a.owner === a.for ? "They see" : `${owner}, who answers for it, sees`} your ` +
    `request where they talk with you, and answers there (${inWords(a.answers, origin)}). ` +
    "Tell them what you want to do and why, then wait: don't try again until it's answered.";
}

/**
 * The answer, in the conversation, as part of what set it going: a reply to
 * the agent's question, when its turn waits on it (it goes on from there).
 * It's for whom the agent was working: where someone else answers (a
 * computer's owner), the message is that person's, saying who did.
 */
export async function told(ctx: Context, asked: Approval, text: string): Promise<void> {
  const me = ctx.actor!.id;
  // In the conversation's space, wherever it was answered from.
  const by = ctx.as({
    ...(asked.for === me ? ctx.actor! : { kind: "person", id: asked.for }),
    ...(asked.origin ? { origin: asked.origin } : {}),
    in: asked.in,
  });
  const answered = asked.for === me
    ? {}
    : { via: { kind: "answer", name: nameOf(me, await namesFor(ctx, [me])).slice(0, 120) } };
  await by.call("chat.send", {
    thread: asked.thread,
    to: [asked.agent],
    text,
    ...(asked.question ? { replyTo: asked.question } : {}),
    ...answered,
  });
}

/**
 * Whether what was asked can be answered now: asked in an agent's turn, its
 * question is written (the step that asked it is); asked elsewhere, always.
 */
export async function asking(ctx: Context, asked: Approval): Promise<boolean> {
  return !asked.question ||
    !!await ctx.as().db.collection("message").findOne({ _id: asked.question });
}

/**
 * What's asked about something that's gone (a computer forgotten): each
 * turn waiting on it is told no (`No: <detail>`), as its person would, and
 * goes on without it; the asks go.
 */
export async function withdraw(ctx: Context, filter: Record<string, unknown>): Promise<void> {
  const approvals = ctx.as().db.collection<Approval>("approval");
  const waiting = await approvals.find({
    ...filter,
    status: "pending",
    question: { $exists: true },
  });
  for (const asked of waiting) {
    if (await asking(ctx, asked)) await told(ctx, asked, `No: ${asked.detail}`);
  }
  await approvals.deleteMany(filter);
}

/** A yes for what a person set up to run, for one agent's kind of work on one thing. */
export type Letting = {
  owner: string;
  on: string;
  agent: string;
  work: string;
  origin: Origin;
  /** What the asking plugin keeps of its own on the grant (computers: `computer`). */
  also?: Record<string, unknown>;
};

/**
 * A yes for what a person set up to run (a routine): this agent may do this
 * kind of work on this thing whenever it runs, as it is now. It replaces a
 * yes for an older version, and answers what already waits on it: every run
 * stopped there carries on.
 */
export async function letOrigin(ctx: Context, l: Letting): Promise<void> {
  const now = new Date().toISOString();
  const key = originKey(l.origin);
  const scope = { owner: l.owner, on: l.on, agent: l.agent, work: l.work };
  const grants = ctx.db.collection<Grant>("grant");
  // A yes for an older version (a card answered late) leaves one for a newer in place.
  const newer = await grants.findOne({ ...scope, origin: key, rev: { $gt: l.origin.rev } });
  if (!newer) {
    await grants.deleteMany({ ...scope, origin: key });
    await grants.insertOne({
      ...l.also,
      ...scope,
      origin: key,
      rev: l.origin.rev,
      at: now,
    } as Grant);
  }
  const approvals = ctx.db.collection<Approval>("approval");
  const waiting = await approvals.find({ ...scope, status: "pending" });
  for (const asked of waiting) {
    if (
      !asked.origin || originKey(asked.origin) !== key || asked.origin.rev !== l.origin.rev ||
      !await asking(ctx, asked)
    ) continue;
    await approvals.updateOne({ _id: asked._id }, {
      $set: { status: "allowed", grant: "origin", decided: now },
    });
    await told(ctx, asked, `${said("origin", asked)}: ${asked.detail}`);
  }
}
