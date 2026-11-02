/**
 * The org's people and their roles (see `ORG` in reach.ts): who's in it, and
 * as what. The host lets people in (`org.join`, as the system, once the
 * directory says they belong); owners and admins change roles and take
 * people out. Only owners make or unmake owners, and an org always keeps
 * one. Taking someone out ends their memberships and hands the shared spaces
 * only they managed to someone who stays; their Personal space stays, where
 * the org's admins still reach it.
 */
import { type Context, defineAction, forbidden, invalid, people } from "../../../../runtime/mod.ts";
import { ORG, ORG_ROLES, type OrgRole, orgRoleOf, rolesOf, runsOrg } from "../shared/reach.ts";
import { keepProfileOf } from "../shared/profile.ts";

const role = { type: "string", enum: [...ORG_ROLES] } as const;

/** The caller's say in the org: staff, or their role. */
const standing = async (ctx: Context) =>
  ctx.actor?.staff === true ? "staff" : await orgRoleOf(ctx.actor!, ctx.as());

/** Throws unless the caller runs the org (an owner, an admin, staff). */
async function runs(ctx: Context) {
  const mine = await standing(ctx);
  if (mine !== "staff" && !runsOrg(mine)) {
    throw forbidden("Only the org's owners and admins do that.");
  }
  return mine;
}

/** Throws if `person` is the org's last owner and wouldn't stay one. */
async function keepsAnOwner(ctx: Context, person: string, next?: OrgRole) {
  if (next === "owner") return;
  const owners = await ctx.as().db.collection("member").find({ space: ORG, role: "owner" });
  if (owners.length === 1 && owners[0].member === `person:${person}`) {
    throw forbidden("An org keeps an owner: make someone else an owner first.");
  }
}

const join = async (ctx: Context, person: string, as: OrgRole) =>
  await ctx.as().db.collection("member").replaceOne(
    { _id: `${ORG}|person:${person}` },
    { member: `person:${person}`, space: ORG, role: as },
    { upsert: true },
  );

export const joinOrgAction = defineAction({
  description:
    "Lets someone into the org, with a role the first time (member by default): the host's",
  input: {
    type: "object",
    properties: { person: { type: "string" }, role },
    required: ["person"],
    additionalProperties: false,
  },
  // No `allow`: only the system calls it, once the directory says they belong.
  run: async (ctx, input) => {
    const held = await orgRoleOf({ kind: "person", id: input.person }, ctx.as());
    // The role given is for joining: coming back keeps the role they have (`org.role` changes it).
    // How they show, kept (people from before profiles, too).
    await keepProfileOf(ctx, input.person);
    if (held) return { role: held };
    await join(ctx, input.person, input.role ?? "member");
    return { role: input.role ?? "member" };
  },
});

export const orgRoleAction = defineAction({
  description: "Changes someone's role in the org",
  input: {
    type: "object",
    properties: { person: { type: "string" }, role },
    required: ["person", "role"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const mine = await runs(ctx);
    const theirs = await orgRoleOf({ kind: "person", id: input.person }, ctx.as());
    if (!theirs) throw invalid("They aren't in this org.");
    if ((input.role === "owner" || theirs === "owner") && mine !== "owner" && mine !== "staff") {
      throw forbidden("Only owners make or unmake owners.");
    }
    await keepsAnOwner(ctx, input.person, input.role);
    await join(ctx, input.person, input.role);
    return { role: input.role };
  },
});

export const removeFromOrgAction = defineAction({
  description:
    "Takes someone out of the org: their memberships end, and the shared spaces only they " +
    "managed go to `to` (you, by default)",
  input: {
    type: "object",
    properties: { person: { type: "string" }, to: { type: "string" } },
    required: ["person"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const mine = await runs(ctx);
    const theirs = await orgRoleOf({ kind: "person", id: input.person }, ctx.as());
    if (!theirs) throw invalid("They aren't in this org.");
    if (theirs === "owner" && mine !== "owner" && mine !== "staff") {
      throw forbidden("Only owners take an owner out.");
    }
    await keepsAnOwner(ctx, input.person);
    const heir = input.to ?? ctx.actor!.id;
    if (heir === input.person) throw invalid("Hand their spaces to someone who stays.");
    const key = `person:${input.person}`;
    const members = ctx.as().db.collection<{ member: string; space: string; role: string }>(
      "member",
    );
    const manages = (r: string) => (rolesOf(ctx)[r] ?? []).includes("manage");
    const handed: string[] = [];
    await ctx.as().transaction(async (tx) => {
      const theirs = tx.db.collection<{ member: string; space: string; role: string }>("member");
      for (const m of await members.find({ member: key, space: { $ne: ORG } })) {
        const space = await tx.db.collection("space").findOne({ _id: m.space });
        if (space?.kind !== "personal" && manages(m.role)) {
          const others = (await theirs.find({ space: m.space })).filter((o) =>
            o.member !== key && !o.member.startsWith("agent:") && manages(o.role)
          );
          if (!others.length) {
            await theirs.replaceOne(
              { _id: `${m.space}|person:${heir}` },
              { member: `person:${heir}`, space: m.space, role: "manager" },
              { upsert: true },
            );
            handed.push(m.space);
          }
        }
        await theirs.deleteOne({ _id: `${m.space}|${key}` });
      }
      await theirs.deleteOne({ _id: `${ORG}|${key}` });
    });
    // Their sessions and keys end: they're out at once, wherever they're signed in.
    await ctx.as().call("credential.revoke", { person: input.person });
    // And they no longer belong, where the directory routes them.
    await (ctx.resources.directory as DirectoryPort | undefined)?.leave?.(input.person);
    return { handed };
  },
});

export const orgSeatsAction = defineAction({
  description: "How many people count as the org's seats: everyone but its guests",
  record: false,
  input: { type: "object", additionalProperties: false },
  run: async (ctx) =>
    (await ctx.as().db.collection<{ role: string }>("member").find({ space: ORG }))
      .filter((m) => m.role !== "guest").length,
});

export const orgMeAction = defineAction({
  description:
    "Your standing in the org: your role, whether you're platform staff, and the org (in an app " +
    "serving many)",
  // Only reads: not recorded, so reads (a query, a View) ask it too.
  record: false,
  input: { type: "object", additionalProperties: false },
  allow: people,
  run: async (ctx) => ({
    role: await orgRoleOf(ctx.actor!, ctx.as()) ?? null,
    staff: ctx.actor?.staff === true,
    ...(ctx.resources.org
      ? { org: ctx.resources.org as { id: string; name: string; kind: string } }
      : {}),
  }),
});

/**
 * The `directory` resource, which a host serving many orgs gives each org
 * (`hosts/orgs`): how the org reaches the directory, for what only it holds.
 */
export type DirectoryPort = {
  invite(invite: { email: string; role: string; by: string; from?: string }): Promise<void>;
  invites(): Promise<{ id: string; email: string; role: string; at: string }[]>;
  cancel(email: string): Promise<void>;
  leave(person: string): Promise<void>;
  rename(name: string): Promise<void>;
};

const directoryOf = (ctx: Context) => {
  const port = ctx.resources.directory as DirectoryPort | undefined;
  if (!port?.invite) {
    throw invalid("This app serves one org: people join its spaces by invitation.");
  }
  return port;
};

export const inviteToOrgAction = defineAction({
  description: "Invites someone to the org by email, with a role; they join when they accept",
  input: {
    type: "object",
    properties: {
      email: { type: "string", pattern: "^[^@\\s]+@[^@\\s]+$" },
      role: { type: "string", enum: ["admin", "member", "guest"] },
    },
    required: ["email"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const mine = await runs(ctx);
    void mine;
    const role = input.role ?? "member";
    const me = await ctx.as().db.collection("person").findOne({ _id: ctx.actor!.id });
    await directoryOf(ctx).invite({
      email: input.email.toLowerCase(),
      role,
      by: ctx.actor!.id,
      ...(typeof me?.name === "string" ? { from: me.name } : {}),
    });
    return { invited: input.email.toLowerCase(), role };
  },
});

export const orgInvitesAction = defineAction({
  description: "The org's invitations waiting to be accepted",
  input: { type: "object", additionalProperties: false },
  allow: people,
  run: async (ctx) => {
    await runs(ctx);
    return { invites: await directoryOf(ctx).invites() };
  },
});

export const uninviteAction = defineAction({
  description: "Takes back an invitation to the org",
  input: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    await runs(ctx);
    await directoryOf(ctx).cancel(input.email.toLowerCase());
    return {};
  },
});

export const orgPeopleAction = defineAction({
  description: "Who's in the org, with their roles, names and emails: for its members",
  input: { type: "object", additionalProperties: false },
  allow: people,
  run: async (ctx) => {
    const mine = await standing(ctx);
    if (!mine || mine === "guest") throw forbidden("Only the org's members see who's in it.");
    const held = await ctx.as().db.collection<{ member: string; role: string }>("member").find({
      space: ORG,
    });
    const ids = held.map((m) => m.member.slice("person:".length));
    const people = ids.length
      ? await ctx.as().db.collection<
        { _id: string; name?: string; email?: string; picture?: string }
      >(
        "person",
      ).find({ _id: { $in: ids } })
      : [];
    const known = new Map(people.map((p) => [p._id, p]));
    const order = { owner: 0, admin: 1, member: 2, guest: 3 } as Record<string, number>;
    return {
      people: held.map((m) => {
        const id = m.member.slice("person:".length);
        const p = known.get(id);
        return {
          person: id,
          role: m.role,
          ...(p?.name ? { name: p.name } : {}),
          ...(p?.email ? { email: p.email } : {}),
          ...(p?.picture ? { picture: p.picture } : {}),
        };
      }).sort((a, b) =>
        (order[a.role] ?? 9) - (order[b.role] ?? 9) ||
        (a.name ?? a.person).localeCompare(b.name ?? b.person)
      ),
    };
  },
});

export const orgSummaryAction = defineAction({
  description: "How big the org is: its people and spaces, for the platform console",
  input: { type: "object", additionalProperties: false },
  // No `allow`: the host's, which reports it to the directory.
  run: async (ctx) => ({
    people: await ctx.db.collection("member").countDocuments({ space: ORG }),
    spaces: await ctx.db.collection("space").countDocuments({}),
  }),
});

export const renameOrgAction = defineAction({
  description: "Renames the org: its owners'",
  input: {
    type: "object",
    properties: { name: { type: "string", minLength: 1, maxLength: 80 } },
    required: ["name"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const mine = await standing(ctx);
    if (mine !== "owner" && mine !== "staff") throw forbidden("Only the org's owners rename it.");
    await directoryOf(ctx).rename(input.name.trim());
    return { name: input.name.trim() };
  },
});
