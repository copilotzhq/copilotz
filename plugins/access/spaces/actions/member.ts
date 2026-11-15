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
 * it has met it (see agents.ts); taken out, it no longer answers there. A
 * key (`{ kind: "key", id }`) is seated by the plugin that made it, with
 * the role what it may do says; its managers take it out (which revokes it).
 *
 * A membership may end at a time (`until`, ISO 8601, still to come): past
 * it, reach ignores it, and a timer removes it then (`member.expire`, on the
 * record as the system's). Set again without `until`, it lasts. A space's
 * last manager is never given an end.
 */
import {
  type Context,
  defineAction,
  forbidden,
  inPerson,
  invalid,
} from "../../../../runtime/mod.ts";
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

/** The timer that ends a membership (`<space>|<member>`) at its `until`. */
const timerOf = (id: string) => `member.expire:${id}`;

/** An end said as ISO 8601, as it's kept; refused unless it's a time still to come. */
function endOf(until: string): string {
  const at = Date.parse(until);
  if (!Number.isFinite(at)) throw invalid(`"${until}" isn't a time: say one as ISO 8601.`);
  if (at <= Date.now()) throw invalid("A membership's end (until) is a time still to come.");
  return new Date(at).toISOString();
}

/**
 * Has time end the membership `<space>|<member>` at `until`; without one, the
 * timer it had (`before`, when it had an end) goes.
 */
async function endAt(
  ctx: Context,
  space: string,
  member: string,
  until: string | undefined,
  before: { until?: string } | null,
) {
  const id = timerOf(`${space}|${member}`);
  // The system's timer: its call is on the record as the system's, not the manager's.
  const system = ctx.as();
  if (until) await system.schedule("member.expire", { space, member, until }, { at: until, id });
  else if (before?.until) await system.unschedule(id);
}

/** The membership `<space>|<member>`, as it is before a change. */
const membershipOf = (ctx: Context, space: string, member: string) =>
  ctx.as().db.collection<{ until?: string }>("member").findOne({ _id: `${space}|${member}` });

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
      /** A space drawing on this one lets its contacts read it too. */
      contacts: { type: "string", enum: ["read"] },
      /** When the membership ends (ISO 8601, still to come); none, it lasts. */
      until: { type: "string", maxLength: 40 },
    },
    required: ["space", "member", "role"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    if (input.space === ORG) throw forbidden("Org roles change with org.role.");
    const until = input.until === undefined ? undefined : endOf(input.until);
    // A key's role follows from what it may do: only trusted code (its plugin's) seats one.
    if (input.member.kind === "key" && ctx.actor && ctx.actor.kind !== "system") {
      throw invalid(
        "A key's role follows from what it may do: make another key for something else.",
      );
    }
    const place = await manages(ctx, input.space, input.on);
    const key = memberKey(input.member);
    checkRole(ctx, key, input.role);
    const before = await membershipOf(ctx, place, key);
    if (!input.on && input.role !== "editor") appsOwn(ctx, input.space, input.member);
    if (!input.on) {
      joinable(await ctx.as().db.collection("space").findOne({ _id: input.space }), key);
      if (input.member.kind === "agent") await mustKnow(ctx, input.member.id);
      if (input.member.kind === "person" && !before) {
        throw Object.assign(
          new Error(
            "People join by invitation: invite them by email, and they join once they accept.",
          ),
          { code: "invalid" },
        );
      }
      await seat(ctx, place, key, input.role, input.contacts as "read" | undefined, until);
    } else {
      await ctx.as().db.collection("member").replaceOne(
        { _id: `${place}|${key}` },
        { member: key, space: place, role: input.role, on: input.on, ...(until ? { until } : {}) },
        { upsert: true },
      );
    }
    await endAt(ctx, place, key, until, before);
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
  allow: inPerson,
  run: async (ctx, input) => {
    if (input.space === ORG) throw forbidden("People leave the org with org.remove.");
    const place = await manages(ctx, input.space, input.on);
    if (!input.on) appsOwn(ctx, input.space, input.member);
    const key = memberKey(input.member);
    if (!input.on) await keepsAManager(ctx, input.space, key);
    const before = await membershipOf(ctx, place, key);
    await ctx.as().db.collection("member").deleteOne({ _id: `${place}|${key}` });
    await endAt(ctx, place, key, undefined, before);
    if (!input.on && input.member.kind === "agent") {
      await unseat(ctx.as(), input.member.id, [input.space]);
    }
  },
});

/**
 * `member.expire` `{ space, member, until }`: a membership's end come (its
 * timer's call): it goes, if it still ends then (set again since, it stays
 * as set). An agent's: it answers there no more. The system's alone.
 */
export const expireMemberAction = defineAction({
  description: "Ends a membership whose time is up",
  input: {
    type: "object",
    properties: {
      /** Where it is: a space, or a document shared on its own (`note:n1`). */
      space: { type: "string" },
      /** Who, as a member: `person:ana`, `agent:north`, `public`. */
      member: { type: "string" },
      until: { type: "string" },
    },
    required: ["space", "member", "until"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const ended = await ctx.as().db.collection("member").deleteOne({
      _id: `${input.space}|${input.member}`,
      until: input.until,
    });
    if (ended.deletedCount && input.member.startsWith("agent:")) {
      await unseat(ctx.as(), input.member.slice("agent:".length), [input.space]);
    }
    return { ended: ended.deletedCount > 0 };
  },
});
