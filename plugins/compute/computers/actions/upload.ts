/**
 * `computer.upload` `{ desk, path }`: a person putting a file on a space's
 * computer (its desk there), at `path` in the space's folder: only where
 * they may change it from its panel (`computer.work`'s rules), a computer
 * that sleeps woken, and said to be in use. It answers where the bytes go,
 * `{ computer, scope }`, for the upload route (routes/upload.ts) to stream
 * them there: an Action is given JSON, never a stream. On the record: who
 * put what where, never its content.
 */
import { defineAction, inPerson } from "../../../../runtime/mod.ts";
import { personalDesk } from "../shared/desks.ts";
import { touch } from "../shared/wake.ts";
import type { Scope } from "../shared/workloads.ts";

export const uploadAction = defineAction({
  description: "Puts a file on a space's computer, in its folder there: where its bytes go",
  input: {
    type: "object",
    properties: {
      desk: { type: "string" },
      /** Where in the space's folder, relative to it. */
      path: { type: "string", minLength: 1, maxLength: 4096 },
    },
    required: ["desk", "path"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input): Promise<{ computer: string; scope: Scope; woke?: boolean }> => {
    const { desk, woke } = await personalDesk(ctx, input.desk, true);
    await touch(ctx, desk.computer);
    return {
      computer: desk.computer,
      scope: { space: desk.in, folder: desk.folder, who: `person:${ctx.actor!.id}` },
      ...(woke !== undefined ? { woke } : {}),
    };
  },
});
