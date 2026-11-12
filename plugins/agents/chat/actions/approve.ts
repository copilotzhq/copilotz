/**
 * `chat.approve`: a person answers what an agent waits on them for, with
 * one of the answers that ask takes (its `answers`, which whoever asked
 * says: a share is never allowed always; publishing is asked every time):
 * yes this once, yes in this conversation, yes for what set it going (a
 * routine), yes always, or no. Their answer goes into the conversation as
 * theirs, to the agent: a reply to its question, so the turn that asked
 * carries on (still as part of that routine's run). A yes in this
 * conversation, or always, answers the agent's other asks it covers too,
 * each turn waiting on them carrying on. An answer handed back that waits
 * on its asker goes where they say: back where it came from, or to them
 * alone. Asked as an agent's step ran, it's answered once that step is
 * written (the card shows then): a moment before, it's refused (`busy`).
 */
import { defineAction, failure, inPerson, invalid } from "../../../../runtime/mod.ts";
import { type Answer, ANSWERS, type Approval, ASKED } from "../collections/approval.ts";
import { asking, letOrigin, said, told } from "../shared/asks.ts";
import { BACK, handBack } from "../shared/delivery.ts";

/** What the asking plugin keeps of its own on an ask (computers: `computer`), for its grants too. */
const alsoOf = (asked: Approval): Record<string, unknown> =>
  Object.fromEntries(Object.entries(asked).filter(([field]) => !ASKED.has(field)));

export const approveAction = defineAction({
  description: "Answers what an agent waits on you for",
  input: {
    type: "object",
    properties: {
      approval: { type: "string" },
      answer: { enum: [...ANSWERS] },
    },
    required: ["approval", "answer"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const answer = input.answer as Answer;
    // Only theirs to answer: the rules reach only their own.
    const approvals = ctx.db.collection<Approval>("approval");
    const asked = await approvals.findOne({ _id: input.approval });
    if (!asked || asked.status !== "pending") return { answered: false };
    if (!asked.answers.includes(answer)) {
      throw invalid(
        asked.answers.every((a) => a === "once" || a === "deny")
          ? "This is asked every time: allow it once, or not."
          : `This takes ${asked.answers.join(", ")}.`,
      );
    }
    if (!await asking(ctx, asked)) {
      throw failure("busy", "It's still finishing what it was doing: answer in a moment.", {
        public: true,
      });
    }
    const now = new Date().toISOString();
    if (asked.work === BACK) {
      // Answered once: whichever answer gets there first is where it goes.
      const { modifiedCount } = await approvals.updateOne({ _id: asked._id, status: "pending" }, {
        $set: { status: answer === "here" ? "allowed" : "denied", grant: answer, decided: now },
      });
      if (modifiedCount) await handBack(ctx, asked, answer === "here" ? "here" : "me");
      return { answered: modifiedCount > 0 };
    }
    const also = alsoOf(asked);
    if (answer === "origin") {
      if (!asked.origin) throw invalid("Nothing set this going to allow it for.");
      await letOrigin(ctx, { ...asked, origin: asked.origin, also });
      return { answered: true };
    }
    await approvals.updateOne({ _id: asked._id }, {
      $set: {
        status: answer === "deny" ? "denied" : "allowed",
        ...(answer === "deny" ? {} : { grant: answer }),
        decided: now,
      },
    });
    if (answer !== "deny") {
      await ctx.db.collection("grant").insertOne({
        ...also,
        owner: asked.owner,
        on: asked.on,
        agent: asked.agent,
        work: asked.work,
        ...(answer === "always" ? {} : { thread: asked.thread }),
        ...(answer === "once" ? { once: asked.detail } : {}),
        at: now,
      });
    }
    await told(ctx, asked, `${said(answer, asked)}: ${asked.detail}`);
    // What else of this agent's waits on the same kind of work that this yes covers: answered too.
    if (answer === "thread" || answer === "always") {
      const covered = await approvals.find({
        owner: asked.owner,
        on: asked.on,
        agent: asked.agent,
        work: asked.work,
        status: "pending",
        question: { $exists: true },
        ...(answer === "thread" ? { thread: asked.thread } : {}),
      });
      for (const other of covered) {
        // One whose step isn't written yet is answered on its own card, by this yes already.
        if (other._id === asked._id || !await asking(ctx, other)) continue;
        const { modifiedCount } = await approvals.updateOne(
          { _id: other._id, status: "pending" },
          { $set: { status: "allowed", grant: answer, decided: now } },
        );
        if (modifiedCount) await told(ctx, other, `${said(answer, other)}: ${other.detail}`);
      }
    }
    return { answered: true };
  },
});
