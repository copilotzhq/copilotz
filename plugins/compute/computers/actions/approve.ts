/**
 * A person answers what an agent waits on them for: yes this once, yes in
 * this conversation, yes for the routine that set it going, yes always, or
 * no. Their answer goes into the conversation as theirs, to the agent, which
 * carries on from it (still as part of that routine's run). Publishing is
 * asked every time: it can only be allowed once.
 */
import { defineAction, inPerson, invalid } from "../../../../runtime/mod.ts";
import type { Approval } from "../collections/approval.ts";
import { letOrigin, told } from "../shared/grants.ts";

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
    if (asked.work === "publish" && input.answer !== "once" && input.answer !== "deny") {
      throw invalid("Publishing is asked every time: allow it once, or not.");
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
    return { answered: true };
  },
});
