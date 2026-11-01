/**
 * `routine.update`: changes a routine, by its maker or a manager of its
 * space: what it's called, sends, to whom, when, where it posts. A new
 * schedule resets its timer (still as its maker); posting somewhere else
 * starts from a new chat. `adopt` (a manager, for a routine whose maker
 * can't run it anymore) makes it theirs: it runs as them from then on.
 * Changing what it does (what it asks, whom, as whom) makes it a new version,
 * so a yes given for the old one doesn't cover it: anyone who may change a
 * routine may not thereby spend someone else's yes.
 */
import { defineAction, personOf } from "../../../../runtime/mod.ts";
import type { Routine } from "../collections/routine.ts";
import { answersIn, arm, editable, fields, forbidden, invalid, timing } from "../shared/routines.ts";
import { type Given, normalize } from "../shared/schedule.ts";

export const updateAction = defineAction({
  description: "Changes a routine: its name, message, agent, schedule or where it posts",
  input: {
    type: "object",
    properties: {
      routine: { type: "string", minLength: 1 },
      ...fields,
      /** Make it the caller's: it runs as them from now on. */
      adopt: { type: "boolean" },
    },
    required: ["routine"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const found = await editable(ctx, input.routine);
    const me = personOf(ctx.actor)!;
    const adopt = input.adopt === true && found.by !== me;
    if (adopt) {
      const { can } = await ctx.call<{ can: boolean }>("space.can", {
        space: found.in,
        verb: "manage",
      });
      if (!can) throw forbidden("Only those who manage this space take a routine over.");
    }
    const schedule = input.schedule ? normalize(input.schedule as Given) : undefined;
    if (input.agent && input.agent !== found.agent) await answersIn(ctx, found.in, input.agent);
    const moved = input.post !== undefined && input.post !== found.post;
    const unnamed = input.chatName !== undefined && !input.chatName.trim();
    const next: Routine = {
      ...found,
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.text ? { text: input.text.trim() } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.post ? { post: input.post } : {}),
      ...(input.chatName?.trim() ? { chatName: input.chatName.trim() } : {}),
      ...(schedule ? { schedule } : {}),
      ...(adopt ? { by: me } : {}),
    };
    const redone = next.text !== found.text || next.agent !== found.agent || next.by !== found.by;
    // Its timer is set again when its schedule, or who it runs as, changed; unless it's paused.
    const rearm = !found.paused && (!!schedule || adopt);
    // A timer set again starts its beat again (every so long, from now).
    const when = rearm ? timing(next.schedule) : {};
    const changed = await ctx.db.collection("routine").updateOne({ _id: found._id }, {
      $set: {
        name: next.name,
        text: next.text,
        agent: next.agent,
        post: next.post,
        schedule: next.schedule,
        by: next.by,
        ...(next.chatName ? { chatName: next.chatName } : {}),
        updated: new Date().toISOString(),
        ...when,
      },
      ...(redone ? { $inc: { rev: 1 } } : {}),
      // A name left empty goes back to the default.
      ...(moved || unnamed || (rearm && !("next" in when))
        ? {
          $unset: {
            ...(moved ? { thread: "" } : {}),
            ...(unnamed ? { chatName: "" } : {}),
            ...(rearm && !("next" in when) ? { next: "" } : {}),
          },
        }
        : {}),
    });
    if (!changed.matchedCount) throw invalid("No such routine here: it may have been deleted.");
    if (rearm) await arm(ctx, next);
    return { routine: found._id, ...when };
  },
});
