/**
 * `computer.enrollment` `{ computer }`: a one-time code for a computer the
 * app made (`computer.provision`) to connect with, while it hasn't been told
 * its secret (only the system calls this: the cloud plugin, for a cloud
 * computer's first wake). The code is bound to that computer: connecting
 * with it (`computer.admit`) is that computer, which is then told its id and
 * secret (`computer.ready`), as a code a person types does. It lasts minutes
 * (`codeMinutes`). A computer told its secret already fails with code
 * `enrolled`: it connects as itself. Answers `{ code }`.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import type { Desk } from "../collections/desk.ts";
import { code, hash } from "../shared/secret.ts";
import { settingsOf } from "../shared/settings.ts";

export const enrollmentAction = defineAction({
  input: {
    type: "object",
    properties: { computer: { type: "string" } },
    required: ["computer"],
    additionalProperties: false,
  },
  // No `allow`: only the system.
  run: async (ctx, input) => {
    const system = ctx.as();
    const known = await system.db.collection<Computer>("computer").findOne({ _id: input.computer });
    if (!known) throw Object.assign(new Error("No such computer"), { code: "not_found" });
    if (!known.pending) {
      throw Object.assign(new Error("This computer has its secret: it connects as itself."), {
        code: "enrolled",
      });
    }
    // The space its first desk is in (an enrollment names one), else its owner's Personal space.
    const [desk] = await system.db.collection<Desk>("desk").find({ computer: input.computer }, {
      sort: { at: 1 },
      limit: 1,
    });
    const space = desk?.in ??
      (await ctx.as({ kind: "person", id: known.owner }).call<{ space: string }>(
        "space.personal",
        {},
      )).space;
    const made = code();
    await system.db.collection("enrollment").insertOne({
      _id: await hash(made),
      owner: known.owner,
      expires: new Date(Date.now() + settingsOf(ctx).codeMinutes * 60_000).toISOString(),
      in: space,
      computer: input.computer,
    });
    return { code: made };
  },
});
