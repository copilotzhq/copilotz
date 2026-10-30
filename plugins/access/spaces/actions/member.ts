/**
 * `member.set` and `member.remove`: who is a member of a space, with what
 * role. Only those who manage a space change its members. A member is a
 * person or an agent (`{ kind, id }`), or another space (`{ kind: "space",
 * id }`), which then draws on this one. A document shared on its own is the
 * space, `on` its collection; managing its space manages its sharing.
 * People join a space by accepting an invitation (`invitation.send`) or a
 * request they made: here, a person who's in already only changes role.
 * An agent joins at once, as a viewer or an editor, if the manager adding
 * it has met it (see agents.ts); taken out, it no longer answers there.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import { mustKnow, unseat } from "../shared/agents.ts";
import { keepsAManager } from "../shared/managers.ts";
import { joinable } from "../shared/personal.ts";
import { memberKey, reachOf } from "../shared/reach.ts";

const who = {
  type: "object",
  properties: { kind: { type: "string" }, id: { type: "string" } },
  required: ["kind", "id"],
} as const;

const forbidden = (message: string) => Object.assign(new Error(message), { code: "forbidden" });

/** Throws unless the caller manages `space` (or, for a document, the space it's in). */
async function manages(ctx: Context, space: string, on?: string) {
  // Reach is worked out from every membership, as the rules do.
  const reach = await reachOf(ctx.actor!, ctx.as());
  let where = space;
  if (on) {
    const doc = await ctx.as().db.collection(on).findOne({ _id: space });
    const field = ((ctx.resources.shared ?? {}) as Record<string, { field?: string }>)[on]?.field ??
      "in";
    if (!doc) throw forbidden(`No ${on} "${space}".`);
    if (reach.get(space)?.can.has("manage")) return;
    where = String(doc[field]);
  }
  if (!reach.get(where)?.can.has("manage")) throw forbidden(`You don't manage "${where}".`);
}

export const setMemberAction = defineAction({
  description: "Makes someone a member of a space, with a role",
  input: {
    type: "object",
    properties: {
      space: { type: "string" },
      member: who,
      role: { type: "string" },
      on: { type: "string" },
    },
    required: ["space", "member", "role"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    await manages(ctx, input.space, input.on);
    const key = memberKey(input.member);
    if (!input.on) {
      joinable(await ctx.as().db.collection("space").findOne({ _id: input.space }), key);
      if (input.member.kind === "agent") {
        if (input.role === "manager") {
          throw Object.assign(new Error("Agents work here as viewers or editors."), {
            code: "invalid",
          });
        }
        await mustKnow(ctx, input.member.id);
      }
      if (
        input.member.kind === "person" &&
        !await ctx.as().db.collection("member").findOne({ _id: `${input.space}|${key}` })
      ) {
        throw Object.assign(
          new Error(
            "People join by invitation: invite them by email, and they join once they accept.",
          ),
          { code: "invalid" },
        );
      }
      await keepsAManager(ctx, input.space, key, input.role);
    }
    await ctx.as().db.collection("member").replaceOne(
      { _id: `${input.space}|${key}` },
      {
        member: key,
        space: input.space,
        role: input.role,
        ...(input.on ? { on: input.on } : {}),
      },
      { upsert: true },
    );
    // An agent made a viewer answers there no more.
    if (!input.on && input.member.kind === "agent") {
      await unseat(ctx.as(), input.member.id, [input.space]);
    }
  },
});

export const removeMemberAction = defineAction({
  description: "Removes someone from a space",
  input: {
    type: "object",
    properties: { space: { type: "string" }, member: who, on: { type: "string" } },
    required: ["space", "member"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    await manages(ctx, input.space, input.on);
    if (!input.on) await keepsAManager(ctx, input.space, memberKey(input.member));
    await ctx.as().db.collection("member").deleteOne({
      _id: `${input.space}|${memberKey(input.member)}`,
    });
    if (!input.on && input.member.kind === "agent") {
      await unseat(ctx.as(), input.member.id, [input.space]);
    }
  },
});
