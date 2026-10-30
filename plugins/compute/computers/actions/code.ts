/**
 * A code to connect a computer to a space (`in`: one the person may work in;
 * their Personal space unless they say): the signed-in person gets it here
 * and types it into the computer program (`connect <app> --code <code>`),
 * which is them saying yes. It works once, for minutes. With it, where the
 * computer connects, when the app says (`computers.url`).
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { mustBeAble } from "../shared/desks.ts";
import { code, hash } from "../shared/secret.ts";
import { settingsOf } from "../shared/settings.ts";

export const codeAction = defineAction({
  description: "A one-time code to connect a computer to a space",
  input: {
    type: "object",
    properties: { in: { type: "string" } },
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const space = input.in ??
      (await ctx.call<{ space: string }>("space.personal", {})).space;
    await mustBeAble(ctx, space, "write");
    const made = code();
    const { codeMinutes, url } = settingsOf(ctx);
    const expires = new Date(Date.now() + codeMinutes * 60_000).toISOString();
    await ctx.db.collection("enrollment").insertOne({
      _id: await hash(made),
      owner: ctx.actor!.id,
      expires,
      in: space,
    });
    return { code: made, expires, in: space, ...(url ? { url } : {}) };
  },
});
