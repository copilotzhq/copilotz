/**
 * `space.keep`: a space the app declares (see shared/declared.ts), made, or
 * kept, as declared: its name, and its agents as editors (the first
 * answering its new chats). Nothing changes when it's as declared already;
 * a space the app doesn't declare is left alone. Trusted code calls it when
 * it needs the space (a line the app declares, before its first chat).
 *
 * A space with that id that the app didn't make (a person's, made before the
 * app declared it) is refused, not adopted: its members would get what the
 * app keeps there. Give the declared space another id, or archive that one.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Member } from "../collections/member.ts";
import type { Space } from "../collections/space.ts";
import { declaredOf } from "../shared/declared.ts";

export const keepAction = defineAction({
  description: "Makes or keeps a space the app declares, as declared",
  input: {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const declared = declaredOf(ctx, input.id);
    if (!declared) return { space: null };
    const system = ctx.as();
    const agents = declared.agents ?? [];
    const [space, members] = await Promise.all([
      system.db.collection<Space & { declared?: boolean }>("space").findOne({ _id: input.id }),
      system.db.collection<Member>("member").find({ space: input.id, on: { $exists: false } }),
    ]);
    if (space && !space.declared) {
      throw Object.assign(
        new Error(
          `Space "${input.id}" was made by a person, so it can't be the app's: declare another id.`,
        ),
        { code: "conflict" },
      );
    }
    const seated = (agent: string) =>
      members.some((m) => m.member === `agent:${agent}` && m.role === "editor");
    const answers = space?.agent && agents.includes(space.agent) ? space.agent : agents[0];
    if (
      space?.declared && space.name === declared.name && space.agent === answers &&
      agents.every(seated)
    ) return { space: input.id };
    await system.transaction(async (tx) => {
      await tx.db.collection("space").updateOne({ _id: input.id }, {
        $set: {
          name: declared.name,
          kind: "shared",
          declared: true,
          ...(answers ? { agent: answers } : {}),
        },
      }, { upsert: true });
      for (const agent of agents.filter((a) => !seated(a))) {
        await tx.db.collection("member").replaceOne(
          { _id: `${input.id}|agent:${agent}` },
          { member: `agent:${agent}`, space: input.id, role: "editor" },
          { upsert: true },
        );
      }
    });
    return { space: input.id };
  },
});
