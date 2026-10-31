/**
 * `computer.allowOrigin`: says ahead of time what an agent may do at a desk
 * when what the person set up runs (a routine), or takes that back. It's the
 * person's own yes: they can only say it for what they'd be asked, so a desk
 * whose owner answers for it is the owner's to say.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { originKey } from "../../../agents/chat/contract.ts";
import type { Desk } from "../collections/desk.ts";
import { letOrigin } from "../shared/grants.ts";

export const allowOriginAction = defineAction({
  description: "Lets an agent do a kind of work at a desk when a routine runs, or stops letting it",
  input: {
    type: "object",
    properties: {
      origin: {
        type: "object",
        properties: {
          kind: { type: "string", minLength: 1 },
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          rev: { type: "integer", minimum: 0 },
          path: { type: "string" },
        },
        required: ["kind", "id", "name", "rev"],
        additionalProperties: false,
      },
      desk: { type: "string", minLength: 1 },
      agent: { type: "string", minLength: 1 },
      work: { enum: ["terminal", "jobs", "writes"] },
      allow: { type: "boolean" },
    },
    required: ["origin", "desk", "agent", "work", "allow"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const me = ctx.actor!.id;
    const desk = await ctx.db.collection<Desk>("desk").findOne({ _id: input.desk });
    if (!desk) {
      throw Object.assign(new Error("No such computer here."), { code: "invalid" });
    }
    if (desk.answers === "owner" && desk.owner !== me) {
      throw Object.assign(new Error("Its owner answers for this computer."), { code: "forbidden" });
    }
    if (input.allow) {
      await letOrigin(ctx, {
        owner: me,
        desk: desk._id,
        computer: desk.computer,
        agent: input.agent,
        work: input.work,
        origin: input.origin,
      });
    } else {
      await ctx.db.collection("grant").deleteMany({
        owner: me,
        desk: desk._id,
        agent: input.agent,
        work: input.work,
        origin: originKey(input.origin),
      });
    }
    return { allowed: input.allow };
  },
});
