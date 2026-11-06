/**
 * The orgs of whoever the directory's session is (each a 401 for anyone
 * else; what goes wrong answers its code's status, its words only when
 * they're for anyone):
 *
 * - `GET /orgs`: who's signed in, the org they're in (`current`), the orgs
 *   they belong to (the last entered first), the invitations waiting for
 *   their email, whether they're platform staff, and whether the session
 *   they hold in the org they're in is staff's (`asStaff`);
 * - `POST /orgs` `{ name }`: makes a team org, its maker its owner, and
 *   goes into it;
 * - `POST /orgs/enter` `{ org, staff? }`: goes into another (staff into any,
 *   as staff when they ask: `staff: true`);
 * - `POST /orgs/invites/answer` `{ invite, accept }`: joins its org (and
 *   goes into it) or declines (`{ joined: false }`).
 *
 * Going into an org answers `{ org }`, with its cookies (see shared/enter.ts).
 */
import { type Actor, jsonOf, type Route, type RouteContext } from "../../../../runtime/mod.ts";
import { enter, personIn, profileOf } from "../shared/enter.ts";
import { CURRENT, json, orgCookie, orgsOf } from "../shared/http.ts";
import { infoOf } from "../shared/state.ts";

const NOT_JSON = "Send a JSON object, of 16 KiB at most";

/** Whether the session a request holds in an org is staff's. */
async function heldAsStaff(ctx: RouteContext, org: string): Promise<boolean> {
  const name = orgCookie(org);
  const secret = name ? ctx.cookies.get(name) : undefined;
  if (!secret) return false;
  const info = await infoOf(ctx.runtime, ctx.runtime.describe().resources, org);
  if (!info || info.suspended) return false;
  const runtime = await orgsOf(ctx.runtime).get(info.id);
  const actor = await runtime?.query<Actor | null>("credential.actor", { secret })
    .catch(() => null);
  return actor?.staff === true;
}

/** `GET /orgs` and `POST /orgs`. */
export const orgsRoute: Route = async (request, ctx) => {
  const { runtime } = ctx;
  const person = personIn(ctx);
  if (request.method === "GET") {
    const email = (await profileOf(runtime, person))?.email ?? null;
    const [{ orgs, staff }, { invites }] = await Promise.all([
      runtime.call<{ orgs: unknown[]; staff: boolean }>("org.mine", {
        person,
        ...(email ? { email } : {}),
      }),
      email
        ? runtime.call<{ invites: unknown[] }>("invite.mine", { email })
        : Promise.resolve({ invites: [] }),
    ]);
    const current = ctx.cookies.get(CURRENT) ?? null;
    return json({
      person,
      email,
      current,
      orgs,
      invites,
      staff,
      asStaff: staff && !!current && await heldAsStaff(ctx, current),
    });
  }
  if (request.method !== "POST") return json({ error: "Only GET and POST" }, 405);
  const asked = await jsonOf(request);
  if (!asked) return json({ error: NOT_JSON }, 400);
  const name = typeof asked.name === "string" ? asked.name.trim() : "";
  if (!name) return json({ error: "A name" }, 400);
  const { org } = await runtime.call<{ org: string }>("org.create", {
    name,
    kind: "team",
    by: person,
  });
  return await enter(request, ctx, org);
};

/** `POST /orgs/enter` `{ org, staff? }`. */
export const enterOrgRoute: Route = async (request, ctx) => {
  if (request.method !== "POST") return json({ error: "Only POST" }, 405);
  personIn(ctx);
  const asked = await jsonOf(request);
  if (!asked) return json({ error: NOT_JSON }, 400);
  if (typeof asked.org !== "string" || !asked.org) return json({ error: "Which org" }, 400);
  return await enter(request, ctx, asked.org, { staff: asked.staff === true });
};

/** `POST /orgs/invites/answer` `{ invite, accept }`. */
export const answerInviteRoute: Route = async (request, ctx) => {
  if (request.method !== "POST") return json({ error: "Only POST" }, 405);
  const person = personIn(ctx);
  const email = (await profileOf(ctx.runtime, person))?.email;
  if (!email) return json({ error: "Not signed in with an email" }, 401);
  const asked = await jsonOf(request);
  if (!asked) return json({ error: NOT_JSON }, 400);
  if (typeof asked.invite !== "string") return json({ error: "Which invitation" }, 400);
  const answered = await ctx.runtime.call<{ org: string; joined: boolean }>("invite.answer", {
    invite: asked.invite,
    person,
    email,
    accept: asked.accept === true,
  });
  if (!answered.joined) return json({ joined: false });
  return await enter(request, ctx, answered.org);
};
