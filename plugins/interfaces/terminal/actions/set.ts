/** `shell.set`: changes where a person is; `null` removes a field. */
import { defineAction } from "../../../../runtime/mod.ts";

export const setAction = defineAction({
  description: "Changes a person's shell state: what's open, what was listed",
  input: {
    type: "object",
    properties: {
      person: { type: "string" },
      open: {
        anyOf: [
          {
            type: "object",
            properties: { kind: { type: "string" }, item: { type: "object" } },
            required: ["kind", "item"],
          },
          { type: "null" },
        ],
      },
      listed: { type: ["array", "null"], items: { type: "string" } },
      space: { type: ["string", "null"] },
    },
    required: ["person"],
    additionalProperties: false,
  },
  record: false,
  // Your own shell, and nobody else's.
  allow: (actor, input) => actor.id === input.person,
  run: async (ctx, { person, ...fields }) => {
    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
    const unset = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v === null).map(([k]) => [k, true]),
    );
    if (!Object.keys(set).length && !Object.keys(unset).length) return;
    await ctx.db.collection("shell").updateOne(
      { _id: person },
      {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { upsert: true },
    );
  },
});
