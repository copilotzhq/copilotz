/**
 * `invitation.send`, `invitation.accept` and `invitation.decline`: how people
 * join a shared space. Its managers invite an email, with a role; whoever
 * signs in with that email sees it, and joins by accepting (someone already
 * in keeps their role) or turns it down. Its managers take one back the same
 * way. Sending answers the same whether the address has an account or not.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { Invitation } from "../collections/invitation.ts";
import { joinable } from "../shared/personal.ts";
import { memberKey, orgRoleOf, reachOf, ROLES } from "../shared/reach.ts";
import type { DirectoryPort } from "./org.ts";
import { namesFor } from "../shared/names.ts";

/** An email address, as invitations hold it. */
const EMAIL = /^[^\s@]+@[^\s@]+$/;

const refused = (code: string, message: string) => Object.assign(new Error(message), { code });

/** The email the caller signed in with. */
const emailOf = async (ctx: Context) =>
  (await ctx.call<{ email: string | null }>("person.email", { person: ctx.actor!.id })).email;

/** The invitation, if it's to the caller's email, or the caller manages its space. */
async function answerable(ctx: Context, id: string): Promise<Invitation & { mine: boolean }> {
  const found = await ctx.as().db.collection<Invitation>("invitation").findOne({ _id: id });
  if (found) {
    if (found.email === await emailOf(ctx)) return { ...found, mine: true };
    const reach = await reachOf(ctx.actor!, ctx.as());
    if (reach.get(found.space)?.can.has("manage")) return { ...found, mine: false };
  }
  throw refused("forbidden", "No such invitation for you.");
}

export const sendInvitationAction = defineAction({
  description:
    "Invites someone into a shared space by email, with a role; they join once they accept",
  input: {
    type: "object",
    properties: {
      space: { type: "string" },
      email: { type: "string", maxLength: 254 },
      role: { type: "string" },
    },
    required: ["space", "email"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email)) throw refused("invalid", "That isn't an email address.");
    const role = input.role ?? "editor";
    if (!(role in { ...ROLES, ...(ctx.resources.roles ?? {}) })) {
      throw refused("invalid", `No role "${role}".`);
    }
    const reach = await reachOf(ctx.actor!, ctx.as());
    if (!reach.get(input.space)?.can.has("manage")) {
      throw refused("forbidden", `You don't manage "${input.space}".`);
    }
    const space = await ctx.as().db.collection("space").findOne({ _id: input.space });
    joinable(space, "person:");
    const invitation = `${input.space}|${email}`;
    await ctx.db.collection("invitation").replaceOne({ _id: invitation }, {
      space: input.space,
      name: String(space?.name ?? input.space),
      email,
      role,
      by: memberKey(ctx.actor!),
      at: new Date().toISOString(),
    }, { upsert: true });
    await joinsTheOrg(ctx, email);
    return { invitation };
  },
});

/**
 * In an app serving many orgs, someone not in this org yet gets there by an
 * invitation to it too: as a guest, who reaches only the spaces they're let
 * into (an invitation of the org's own, waiting already, stays as it is).
 */
async function joinsTheOrg(ctx: Context, email: string) {
  const directory = ctx.resources.directory as DirectoryPort | undefined;
  if (!directory?.invite) return;
  const known = await ctx.as().db.collection("person").findOne({ email });
  if (known && await orgRoleOf({ kind: "person", id: String(known._id) }, ctx.as())) return;
  if ((await directory.invites()).some((waiting) => waiting.email === email)) return;
  // Who invited them, by name: what the org's invitation says.
  const [from] = Object.values(await namesFor(ctx, [ctx.actor!.id]));
  await directory.invite({ email, role: "guest", by: ctx.actor!.id, ...(from ? { from } : {}) });
}

export const acceptInvitationAction = defineAction({
  description: "Joins the space an invitation to your email is for",
  input: {
    type: "object",
    properties: { invitation: { type: "string" } },
    required: ["invitation"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const found = await answerable(ctx, input.invitation);
    if (!found.mine) throw refused("forbidden", "No such invitation for you.");
    const key = memberKey(ctx.actor!);
    await ctx.as().transaction(async (tx) => {
      const id = `${found.space}|${key}`;
      const members = tx.db.collection("member");
      if (!await members.findOne({ _id: id })) {
        await members.insertOne({ _id: id, member: key, space: found.space, role: found.role });
      }
      await tx.db.collection("invitation").deleteOne({ _id: found._id });
    });
    return { space: found.space };
  },
});

export const declineInvitationAction = defineAction({
  description: "Turns down an invitation to your email; a space's managers take one back",
  input: {
    type: "object",
    properties: { invitation: { type: "string" } },
    required: ["invitation"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const found = await answerable(ctx, input.invitation);
    await ctx.as().db.collection("invitation").deleteOne({ _id: found._id });
    return { declined: found._id };
  },
});
