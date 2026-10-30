/**
 * `app.publish`: a person publishes what a job on their space's computer
 * serves (its job, or a port; a folder under the space's, or all of it) as
 * an app of the space, under `name`. Asking is their own yes. It answers at
 * once, building; the app goes live in a few minutes (see app.build).
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { failure } from "../shared/errors.ts";
import { can, publish } from "../shared/publish.ts";

export const publishAction = defineAction({
  description: "Publishes what a space's computer serves as an app that runs on its own",
  input: {
    type: "object",
    properties: {
      /** The space (default: your Personal space). */
      in: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 80 },
      /** The job whose port it serves, and whose command runs it. */
      job: { type: "string" },
      port: { type: "integer", minimum: 1, maximum: 65535 },
      /** A folder under the space's folder; none: all of it. */
      path: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const person = ctx.actor!.id;
    const space = input.in ?? (await ctx.call<{ space: string }>("space.personal", {})).space;
    if (!await can(ctx, space, "write")) {
      throw failure("You can't publish from this space.", "forbidden");
    }
    return await publish(ctx, { ...input, in: space, who: `person:${person}`, by: person });
  },
});
