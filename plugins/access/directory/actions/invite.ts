/**
 * Invitations to orgs, by email: the org's admins send them (through the
 * host, which asks the directory), the person with that verified email sees
 * theirs when they sign in, and accepting one makes them belong, with the
 * invitation's role for their first entering. All are the system's.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Invite } from "../collections/invite.ts";
import type { Org } from "../collections/org.ts";

const forbidden = (message: string) => Object.assign(new Error(message), { code: "forbidden" });

export const sendInviteAction = defineAction({
  description: "Invites an email to an org, with a role",
  input: {
    type: "object",
    properties: {
      org: { type: "string" },
      email: { type: "string", pattern: "^[^@\\s]+@[^@\\s]+$" },
      role: { type: "string", enum: ["admin", "member", "guest"] },
      by: { type: "string" },
      from: { type: "string" },
    },
    required: ["org", "email", "role", "by"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const email = input.email.toLowerCase();
    const id = `${input.org}|${email}`;
    // Inviting again changes its role; it's still the one invitation.
    await ctx.db.collection("invite").replaceOne({ _id: id }, {
      org: input.org,
      email,
      role: input.role,
      by: input.by,
      ...(input.from ? { from: input.from } : {}),
      at: new Date().toISOString(),
    }, { upsert: true });
    return { invite: id };
  },
});

export const myInvitesAction = defineAction({
  description: "The invitations waiting for an email, with their orgs' names",
  input: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const invites = await ctx.db.collection<Invite>("invite").find({
      email: input.email.toLowerCase(),
    }, { sort: { at: -1 } });
    const orgs = invites.length
      ? await ctx.db.collection<Org>("org").find({ _id: { $in: invites.map((i) => i.org) } })
      : [];
    const names = new Map(orgs.map((o) => [o._id, o.name]));
    return {
      invites: invites.filter((i) => names.has(i.org)).map((i) => ({
        id: i._id,
        org: i.org,
        name: names.get(i.org)!,
        role: i.role,
        ...(i.from ? { from: i.from } : {}),
        at: i.at,
      })),
    };
  },
});

export const orgInvitesAction = defineAction({
  description: "The invitations an org has waiting",
  input: {
    type: "object",
    properties: { org: { type: "string" } },
    required: ["org"],
    additionalProperties: false,
  },
  run: async (ctx, input) => ({
    invites: (await ctx.db.collection<Invite>("invite").find({ org: input.org }, {
      sort: { at: -1 },
    })).map((i) => ({ id: i._id, email: i.email, role: i.role, at: i.at })),
  }),
});

export const answerInviteAction = defineAction({
  description: "Accepts or declines an invitation, for the person whose email it's to",
  input: {
    type: "object",
    properties: {
      invite: { type: "string" },
      person: { type: "string" },
      email: { type: "string" },
      accept: { type: "boolean" },
    },
    required: ["invite", "person", "email", "accept"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const invites = ctx.db.collection<Invite>("invite");
    const found = await invites.findOne({ _id: input.invite });
    if (!found || found.email !== input.email.toLowerCase()) {
      throw forbidden("No such invitation for you.");
    }
    await ctx.transaction(async (tx) => {
      if (input.accept) {
        const memberships = tx.db.collection("membership");
        const id = `${found.org}|${input.person}`;
        const had = await memberships.findOne({ _id: id });
        await memberships.replaceOne({ _id: id }, {
          org: found.org,
          person: input.person,
          role: found.role,
          at: had?.at ?? new Date().toISOString(),
        }, { upsert: true });
      }
      await tx.db.collection("invite").deleteOne({ _id: found._id });
    });
    return { org: found.org, joined: input.accept };
  },
});

export const cancelInviteAction = defineAction({
  description: "Takes back an org's invitation",
  input: {
    type: "object",
    properties: { org: { type: "string" }, email: { type: "string" } },
    required: ["org", "email"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const gone = await ctx.db.collection("invite").deleteOne({
      _id: `${input.org}|${input.email.toLowerCase()}`,
    });
    return { cancelled: gone.deletedCount > 0 };
  },
});
