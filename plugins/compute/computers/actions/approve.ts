/**
 * A person answers what an agent waits on them for: yes this once, yes in
 * this conversation, yes for the routine that set it going, yes always, or
 * no. Their answer goes into the conversation as theirs, to the agent: a
 * reply to its question, so the turn that asked carries on (still as part
 * of that routine's run). A yes in this conversation, or always, answers the
 * agent's other requests it covers too, each turn waiting on them carrying
 * on. Publishing is asked every time: it can only be allowed once. Asked as
 * an agent's step ran, it's answered once that step is written (the card
 * shows then): a moment before, it's refused (`busy`).
 */
import { defineAction, failure, inPerson, invalid } from "../../../../runtime/mod.ts";
import type { Approval } from "../collections/approval.ts";
import { asking, letOrigin, told } from "../shared/grants.ts";
import { onlyOnce } from "../shared/settings.ts";

const SAID = {
  once: "Yes, this once",
  thread: "Yes, in this conversation",
  always: "Yes, always",
  deny: "No",
} as const;

export const approveAction = defineAction({
  description: "Answers what an agent asked to do on a computer",
  input: {
    type: "object",
    properties: {
      approval: { type: "string" },
      answer: { enum: ["once", "thread", "origin", "always", "deny"] },
    },
    required: ["approval", "answer"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    // Only theirs to answer: the rules reach only their own.
    const asked = await ctx.db.collection<Approval>("approval").findOne({ _id: input.approval });
    if (!asked || asked.status !== "pending") return { answered: false };
    if (onlyOnce(asked.work) && input.answer !== "once" && input.answer !== "deny") {
      throw invalid("This is asked every time: allow it once, or not.");
    }
    if (!await asking(ctx, asked)) {
      throw failure("busy", "It's still finishing what it was doing: answer in a moment.", {
        public: true,
      });
    }
    if (input.answer === "origin") {
      if (!asked.origin) throw invalid("Nothing set this going to allow it for.");
      await letOrigin(ctx, { ...asked, origin: asked.origin });
      return { answered: true };
    }
    const now = new Date().toISOString();
    await ctx.db.collection("approval").updateOne({ _id: asked._id }, {
      $set: {
        status: input.answer === "deny" ? "denied" : "allowed",
        ...(input.answer === "deny" ? {} : { grant: input.answer }),
        decided: now,
      },
    });
    if (input.answer !== "deny") {
      await ctx.db.collection("grant").insertOne({
        owner: asked.owner,
        desk: asked.desk,
        computer: asked.computer,
        agent: asked.agent,
        work: asked.work,
        ...(input.answer === "always" ? {} : { thread: asked.thread }),
        ...(input.answer === "once" ? { once: asked.detail } : {}),
        at: now,
      });
    }
    await told(ctx, asked, `${SAID[input.answer]}: ${asked.detail}`);
    // What else of this agent's waits on the same kind of work that this yes covers: answered too.
    if (input.answer === "thread" || input.answer === "always") {
      const covered = await ctx.db.collection<Approval>("approval").find({
        owner: asked.owner,
        desk: asked.desk,
        agent: asked.agent,
        work: asked.work,
        status: "pending",
        question: { $exists: true },
        ...(input.answer === "thread" ? { thread: asked.thread } : {}),
      });
      for (const other of covered) {
        // One whose step isn't written yet is answered on its own card, by this yes already.
        if (other._id === asked._id || !await asking(ctx, other)) continue;
        const { modifiedCount } = await ctx.db.collection("approval").updateOne(
          { _id: other._id, status: "pending" },
          { $set: { status: "allowed", grant: input.answer, decided: now } },
        );
        if (modifiedCount) await told(ctx, other, `${SAID[input.answer]}: ${other.detail}`);
      }
    }
    return { answered: true };
  },
});
