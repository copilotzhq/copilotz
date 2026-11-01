/**
 * `computer.allowOrigin`: says ahead of time what an agent may do at a desk
 * when what the person set up runs (a routine), or takes that back. What it
 * is, and which version, come from whatever owns it (the `origins` resource),
 * never the caller. Only whoever would be asked there says it.
 */
import { defineAction, forbidden, inPerson, invalid } from "../../../../runtime/mod.ts";
import { type Origin, originKey } from "../../../agents/chat/contract.ts";
import type { Desk } from "../collections/desk.ts";
import { letOrigin } from "../shared/grants.ts";
import { answererOf } from "../shared/where.ts";

/** What says what an origin is: `origins: { routine: { action: "routine.origin" } }`. */
export type Origins = Record<string, { action: string } | null>;
type Found = { origin: Origin; by: string; in: string };

export const allowOriginAction = defineAction({
  description: "Lets an agent do a kind of work at a desk when a routine runs, or stops letting it",
  input: {
    type: "object",
    properties: {
      kind: { type: "string", minLength: 1 },
      id: { type: "string", minLength: 1 },
      desk: { type: "string", minLength: 1 },
      agent: { type: "string", minLength: 1 },
      work: { enum: ["terminal", "jobs", "writes"] },
      allow: { type: "boolean" },
    },
    required: ["kind", "id", "desk", "agent", "work", "allow"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const me = ctx.actor!.id;
    const scope = { owner: me, desk: input.desk, agent: input.agent, work: input.work };
    if (!input.allow) {
      await ctx.db.collection("grant").deleteMany({
        ...scope,
        origin: originKey({ kind: input.kind, id: input.id }),
      });
      return { allowed: false };
    }
    const says = (ctx.resources.origins as Origins | undefined)?.[input.kind]?.action;
    const found = says ? await ctx.call<Found | null>(says, { id: input.id }) : null;
    const desk = await ctx.db.collection<Desk>("desk").findOne({ _id: input.desk });
    if (!found || !desk || desk.in !== found.in) throw invalid("That can't be allowed here.");
    if (answererOf(desk, found.by) !== me) {
      throw forbidden("Whoever answers for this computer says that.");
    }
    await letOrigin(ctx, { ...scope, computer: desk.computer, origin: found.origin });
    return { allowed: true };
  },
});
