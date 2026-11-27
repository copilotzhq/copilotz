/**
 * `push.send` `{ person, notice, ttl? }`: a notification to every device the
 * person turned them on for (see shared/deliver.ts), whether or not they're
 * looking: the caller decides. Only the app's own code sends (Processors,
 * other Actions): no actor may.
 *
 * `push.looking` `{ tab, visible }`: a tab of the person's says it shows the
 * app, or no longer does; while it does, it says so again every half minute.
 *
 * Both unrecorded: a notice carries what someone wrote, and a tab's comings
 * and goings are nobody's history.
 */
import { defineAction, inPerson } from "../../../../runtime/mod.ts";
import { deliver, type Sent } from "../shared/deliver.ts";

export type { Sent };

export const sendAction = defineAction({
  description: "Sends a notification to a person's devices",
  record: false,
  input: {
    type: "object",
    properties: {
      person: { type: "string", minLength: 1 },
      notice: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          body: { type: "string", maxLength: 1000 },
          url: { type: "string", maxLength: 1000 },
          tag: { type: "string", maxLength: 200 },
        },
        required: ["title"],
        additionalProperties: false,
      },
      /** Seconds the push service keeps it for a device that's off (a day by default). */
      ttl: { type: "integer", minimum: 0, maximum: 2419200 },
    },
    required: ["person", "notice"],
    additionalProperties: false,
  },
  allow: () => false,
  run: (ctx, input): Promise<Sent> => deliver(ctx, input.person, input.notice, input.ttl),
});

export const lookingAction = defineAction({
  description: "Says whether a tab of yours shows the app now",
  record: false,
  input: {
    type: "object",
    properties: {
      tab: { type: "string", pattern: "^[A-Za-z0-9_-]{8,64}$" },
      visible: { type: "boolean" },
    },
    required: ["tab", "visible"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const person = ctx.actor!.id;
    const _id = `${person}:${input.tab}`;
    await ctx.as().db.collection("pushLooking").replaceOne(
      { _id },
      { _id, person, visible: input.visible, at: new Date().toISOString() },
      { upsert: true },
    );
    return { ok: true };
  },
});
