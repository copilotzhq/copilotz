/**
 * `request_access`, for agents: asks the managers of a space the agent (or
 * its person) can't reach to let them in, with a reason. They decide; it
 * doesn't wait.
 */
import type { Tool } from "../../../agents/chat/contract.ts";
import { PERSONAL } from "../shared/personal.ts";
import { memberKey } from "../shared/reach.ts";
import { nameOf, namesFor } from "../shared/names.ts";

export const tools: Record<string, Tool> = {
  request_access: {
    offer: true,
    description: "Ask the managers of a space you can't see to let the person you work for in, " +
      "saying why. Use it when what you need is somewhere you aren't allowed.",
    input: {
      type: "object",
      properties: { space: { type: "string" }, reason: { type: "string" } },
      required: ["space", "reason"],
    },
    run: async (input, ctx) => {
      const { space, reason } = input as { space: string; reason: string };
      const who = (ctx.actor?.for ?? ctx.actor) as { kind: string; id: string } | undefined;
      if (!who) return "Nobody to ask for.";
      // Found by name, whoever can see it: the person named it. Nobody asks into a Personal space.
      const system = ctx.as();
      const found = (await system.db.collection<{ _id: string; name: string }>("space")
        .find({ kind: { $ne: PERSONAL } }))
        .find((s) => s.name.toLowerCase() === space.toLowerCase() || s._id === space);
      if (!found) return `No space called "${space}".`;
      await system.db.collection("request").updateOne(
        { _id: `${found._id}|${memberKey(who)}` },
        {
          $set: {
            space: found._id,
            member: memberKey(who),
            by: ctx.agent,
            reason,
            at: new Date().toISOString(),
          },
        },
        { upsert: true },
      );
      const named = who.kind === "person" ? nameOf(who.id, await namesFor(ctx, [who.id])) : who.id;
      return `Asked ${found.name}'s managers to let ${named} in. They'll decide; nothing ` +
        "changes until they do.";
    },
  },
};
