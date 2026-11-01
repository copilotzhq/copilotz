/**
 * Orgs and who belongs: what the host asks the directory as people sign in,
 * make orgs, switch between them and are let in. All are the system's: the
 * host has verified who's asking (their directory session) before it calls.
 *
 * - `org.create`: a new org (everyone's personal one, or a team's), its
 *   maker in it as its owner, placed in the shared schema;
 * - `org.mine`: the orgs someone belongs to, the one they were in last first;
 * - `org.enter`: whether someone may go in (a member, or staff), and how:
 *   the role they join with the first time, and where the org lives;
 * - `org.leave`: someone no longer belongs (their org took them out);
 * - `org.suspend`, `org.rename`, `org.report` (its summary), `org.list`.
 */
import { defineAction, forbidden } from "../../../../runtime/mod.ts";
import type { Membership } from "../collections/membership.ts";
import type { Org } from "../collections/org.ts";
import { isStaff, placementOf } from "../shared/settings.ts";

const person = { type: "string" } as const;

export const createOrgAction = defineAction({
  description: "Makes an org (personal or a team's); its maker belongs as its owner",
  input: {
    type: "object",
    properties: {
      name: { type: "string" },
      kind: { type: "string", enum: ["personal", "team"] },
      by: person,
      id: { type: "string" },
    },
    required: ["name", "by"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const kind = input.kind ?? "team";
    if (kind === "personal") {
      const had = await ctx.db.collection<Org>("org").findOne({ by: input.by, kind });
      if (had) return { org: had._id, created: false };
    }
    const id = input.id ?? `${kind === "personal" ? "p" : "o"}-${crypto.randomUUID().slice(0, 12)}`;
    const at = new Date().toISOString();
    await ctx.transaction(async (tx) => {
      await tx.db.collection("org").insertOne({
        _id: id,
        name: input.name,
        kind,
        by: input.by,
        placement: placementOf(ctx, id),
        at,
      });
      await tx.db.collection("membership").insertOne({
        _id: `${id}|${input.by}`,
        org: id,
        person: input.by,
        role: "owner",
        at,
      });
    });
    return { org: id, created: true };
  },
});

export const myOrgsAction = defineAction({
  description: "The orgs someone belongs to, the one they were in last first",
  input: {
    type: "object",
    properties: { person },
    required: ["person"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const memberships = await ctx.db.collection<Membership>("membership").find({
      person: input.person,
    });
    const orgs = memberships.length
      ? await ctx.db.collection<Org>("org").find({
        _id: { $in: memberships.map((m) => m.org) },
      })
      : [];
    const entered = new Map(memberships.map((m) => [m.org, m.entered ?? ""]));
    return {
      orgs: orgs
        .map((o) => ({
          id: o._id,
          name: o.name,
          kind: o.kind,
          ...(o.suspended ? { suspended: true } : {}),
        }))
        // The last entered first, then personal before teams, then by name.
        .sort((a, b) =>
          (entered.get(b.id) ?? "").localeCompare(entered.get(a.id) ?? "") ||
          (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "personal" ? -1 : 1)
        ),
      staff: await isStaff(ctx, input.person),
    };
  },
});

export const enterOrgAction = defineAction({
  description:
    "Whether someone may go into an org, and how: the role they join with, and where it lives",
  input: {
    type: "object",
    properties: { org: { type: "string" }, person, email: { type: "string" } },
    required: ["org", "person"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const org = await ctx.db.collection<Org>("org").findOne({ _id: input.org });
    if (!org) throw forbidden("No such org, or not one you belong to.");
    const memberships = ctx.db.collection<Membership>("membership");
    const mine = await memberships.findOne({ _id: `${input.org}|${input.person}` });
    const staff = !mine && await isStaff(ctx, input.person, input.email);
    if (!mine && !staff) throw forbidden("No such org, or not one you belong to.");
    if (org.suspended && !staff) throw forbidden("This org is suspended.");
    if (mine) {
      await memberships.updateOne({ _id: mine._id }, {
        $set: { entered: new Date().toISOString() },
      });
    }
    return {
      org: { id: org._id, name: org.name, kind: org.kind, placement: org.placement },
      ...(mine?.role ? { role: mine.role } : {}),
      staff,
    };
  },
});

export const leaveOrgAction = defineAction({
  description: "Someone no longer belongs to an org",
  input: {
    type: "object",
    properties: { org: { type: "string" }, person },
    required: ["org", "person"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const left = await ctx.db.collection("membership").deleteOne({
      _id: `${input.org}|${input.person}`,
    });
    return { left: left.deletedCount > 0 };
  },
});

export const renameOrgAction = defineAction({
  description: "Renames an org",
  input: {
    type: "object",
    properties: { org: { type: "string" }, name: { type: "string", minLength: 1 } },
    required: ["org", "name"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    await ctx.db.collection("org").updateOne({ _id: input.org }, { $set: { name: input.name } });
    return { name: input.name };
  },
});

export const suspendOrgAction = defineAction({
  description: "Suspends an org (nobody but staff goes in) or lifts it",
  input: {
    type: "object",
    properties: { org: { type: "string" }, suspended: { type: "boolean" } },
    required: ["org", "suspended"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    await ctx.db.collection("org").updateOne({ _id: input.org }, {
      ...(input.suspended ? { $set: { suspended: true } } : { $unset: { suspended: "" } }),
    });
    return { suspended: input.suspended };
  },
});

export const reportOrgAction = defineAction({
  description: "Keeps what an org last reported of itself, for the console",
  input: {
    type: "object",
    properties: {
      org: { type: "string" },
      people: { type: "number" },
      spaces: { type: "number" },
      active: { type: "string" },
    },
    required: ["org"],
    additionalProperties: false,
  },
  run: async (ctx, { org, ...summary }) => {
    await ctx.db.collection("org").updateOne({ _id: org }, {
      $set: { summary: { ...summary, at: new Date().toISOString() } },
    });
    return {};
  },
});

export const listOrgsAction = defineAction({
  description: "Every org, newest first, with what each last reported: for staff's console",
  input: {
    type: "object",
    properties: { limit: { type: "number" }, skip: { type: "number" } },
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const orgs = await ctx.db.collection<Org>("org").find({}, {
      sort: { at: -1 },
      limit: input.limit ?? 200,
      skip: input.skip ?? 0,
    });
    const counts = await ctx.db.collection("membership").aggregate<{ _id: string; n: number }>([
      { $group: { _id: "$org", n: { $sum: 1 } } },
    ]);
    const members = new Map(counts.map((c) => [c._id, c.n]));
    return {
      orgs: orgs.map((o) => ({
        id: o._id,
        name: o.name,
        kind: o.kind,
        by: o.by,
        placement: o.placement,
        members: members.get(o._id) ?? 0,
        ...(o.suspended ? { suspended: true } : {}),
        ...(o.summary ? { summary: o.summary } : {}),
        at: o.at,
      })),
    };
  },
});

export const getOrgAction = defineAction({
  description: "An org as the host opens it: its name, kind, placement, and whether it's suspended",
  input: {
    type: "object",
    properties: { org: { type: "string" } },
    required: ["org"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const org = await ctx.db.collection<Org>("org").findOne({ _id: input.org });
    return org
      ? {
        id: org._id,
        name: org.name,
        kind: org.kind,
        placement: org.placement,
        ...(org.suspended ? { suspended: true } : {}),
      }
      : null;
  },
});

export const placeOrgAction = defineAction({
  description: "Says where an org's rows now live (after they were moved there)",
  input: {
    type: "object",
    properties: {
      org: { type: "string" },
      placement: {
        type: "object",
        properties: { schema: { type: "string" } },
        required: ["schema"],
        additionalProperties: false,
      },
    },
    required: ["org", "placement"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    await ctx.db.collection("org").updateOne({ _id: input.org }, {
      $set: { placement: input.placement },
    });
    return { placement: input.placement };
  },
});

export const deleteOrgAction = defineAction({
  description:
    "Forgets an org: it, who belonged, its invitations and hosts (its rows are dropped apart)",
  input: {
    type: "object",
    properties: { org: { type: "string" } },
    required: ["org"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    await ctx.transaction(async (tx) => {
      await tx.db.collection("membership").deleteMany({ org: input.org });
      await tx.db.collection("invite").deleteMany({ org: input.org });
      await tx.db.collection("orgHost").deleteMany({ org: input.org });
      await tx.db.collection("org").deleteOne({ _id: input.org });
    });
    return { deleted: input.org };
  },
});
