/**
 * `member.set` and `member.remove`: who is a member of a space, with what
 * role. Only those who manage a space change its members. A member is a
 * person or an agent (`{ kind, id }`), or another space (`{ kind: "space",
 * id }`), which then draws on this one. A document shared on its own is the
 * space, `on` its collection; managing its space manages its sharing. A
 * contact (someone outside the org) is a member of documents only: its chat.
 * People join a space by accepting an invitation (`invitation.send`) or a
 * request they made: here, a person who's in already only changes role.
 * An agent joins at once, as a viewer or an editor, if the manager adding
 * it has met it (see agents.ts); taken out, it no longer answers there.
 */
import { type Context, defineAction, forbidden, people } from "../../../../runtime/mod.ts";
import { mustKnow, unseat } from "../shared/agents.ts";
import { keepsAManager } from "../shared/managers.ts";
import { joinable } from "../shared/personal.ts";
import { may, must } from "../shared/can.ts";
import { checkRole, seat } from "../shared/seat.ts";
import { declaredAgent } from "../shared/declared.ts";
import { docKey, memberKey, ORG } from "../shared/reach.ts";

const who = {
  type: "object",
  properties: { kind: { type: "string" }, id: { type: "string" } },
  required: ["kind", "id"],
} as const;

/**
 * Throws unless the caller manages `space` (or, for a document of a shared
 * collection, it or the space it's in). Answers where its members are kept.
 */
async function manages(ctx: Context, space: string, on?: string): Promise<string> {
  if (!on) {
    await must(ctx, "manage", space, `You don't manage "${space}".`);
    return space;
  }
  const all = (ctx.resources.shared ?? {}) as Record<string, { field?: string }>;
  const shared = Object.hasOwn(all, on) ? all[on] : undefined;
  const doc = shared ? await ctx.as().db.collection(on).findOne({ _id: space }) : null;
  if (!doc || !shared) throw forbidden(`No ${on} "${space}".`);
  const key = docKey(on, space);
  const home = String(doc[shared.field ?? "in"]);
  if (!await may(ctx, "manage", space, on)) {
    await must(ctx, "manage", home, `You don't manage "${home}".`);
  }
  return key;
}

/** Throws unless `member` may leave or change role in `space`: the app's own agents there stay. */
function appsOwn(ctx: Context, space: string, member: { kind: string; id: string }) {
  if (member.kind === "agent" && declaredAgent(ctx, space, member.id)) {
    throw forbidden(`${member.id} works here as the app declares: its settings keep it.`);
  }
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
  allow: people,
  run: async (ctx, input) => {
    if (input.space === ORG) throw forbidden("Org roles change with org.role.");
    const place = await manages(ctx, input.space, input.on);
    const key = memberKey(input.member);
    checkRole(ctx, key, input.role);
    if (!input.on && input.role !== "editor") appsOwn(ctx, input.space, input.member);
    if (!input.on) {
      joinable(await ctx.as().db.collection("space").findOne({ _id: input.space }), key);
      if (input.member.kind === "agent") await mustKnow(ctx, input.member.id);
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
      await seat(ctx, place, key, input.role);
    } else {
      await ctx.as().db.collection("member").replaceOne(
        { _id: `${place}|${key}` },
        { member: key, space: place, role: input.role, on: input.on },
        { upsert: true },
      );
    }
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
  allow: people,
  run: async (ctx, input) => {
    if (input.space === ORG) throw forbidden("People leave the org with org.remove.");
    const place = await manages(ctx, input.space, input.on);
    if (!input.on) appsOwn(ctx, input.space, input.member);
    if (!input.on) await keepsAManager(ctx, input.space, memberKey(input.member));
    await ctx.as().db.collection("member").deleteOne({
      _id: `${place}|${memberKey(input.member)}`,
    });
    if (!input.on && input.member.kind === "agent") {
      await unseat(ctx.as(), input.member.id, [input.space]);
    }
  },
});
