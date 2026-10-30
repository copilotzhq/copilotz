/**
 * `routine.create`: a routine in a space, made by someone who may write
 * there (an editor): what to send, to which of the agents answering there,
 * when, and where it posts. It runs as them from then on: its timer is set
 * in the same commit.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import {
  answersIn,
  fields,
  forbidden,
  nameFrom,
  personOf,
  timerOf,
  timing,
} from "../shared/routines.ts";
import { type Given, normalize, whenOf } from "../shared/schedule.ts";

export const createAction = defineAction({
  description: "Makes a routine: a message sent to an agent on a schedule, in a space",
  input: {
    type: "object",
    properties: {
      in: { type: "string", minLength: 1 },
      ...fields,
      /** Made paused: it waits until it's resumed. */
      paused: { type: "boolean" },
    },
    required: ["in", "text", "agent", "schedule"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const by = personOf(ctx);
    if (!by || ctx.actor?.kind !== "person") {
      throw forbidden("A routine is a person's: it runs as whoever makes it.");
    }
    const { can } = await ctx.call<{ can: boolean }>("space.can", {
      space: input.in,
      verb: "write",
    });
    if (!can) throw forbidden("Only those who may write in this space make routines there.");
    const schedule = normalize(input.schedule as Given);
    await answersIn(ctx, input.in, input.agent);
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    const when = timing(schedule);
    await ctx.transaction(async (tx) => {
      await tx.db.collection("routine").insertOne({
        _id: id,
        in: input.in,
        name: input.name?.trim() || nameFrom(input.text),
        text: input.text.trim(),
        agent: input.agent,
        schedule,
        post: input.post ?? "new",
        by,
        at,
        ...(input.paused ? { paused: at } : when),
        runs: 0,
      });
      if (!input.paused) {
        tx.schedule("routine.fire", { routine: id }, { ...whenOf(schedule), id: timerOf(id) });
      }
    });
    return { routine: id, ...(input.paused ? {} : when) };
  },
});
