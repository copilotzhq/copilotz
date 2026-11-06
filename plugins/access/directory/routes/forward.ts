/**
 * What the directory hands to an org's runtime, the request untouched (its
 * path, its body, its socket): the org's own runtime answers it (its page,
 * its `/connect` and socket under its address, its webhooks, its routes),
 * by the org's own `who`.
 *
 * - **By its address** (`/o/<org>/…`): whatever reaches an org without a
 *   browser's session (its API with a key, its webhooks, its computers), and
 *   its page's `/connect` and socket. A 404 for no such org, a 403 for a
 *   suspended one.
 * - **By the browser's cookie** (`/*`, matched last): the org the browser is
 *   in (`org`), with its session there (`s_<org>`). A page asked for without
 *   one (signed in at the directory, but in no org yet, or its session there
 *   gone, or the org no longer theirs) goes in first: the one they were in,
 *   else their last, else their own, made now; then the same page again
 *   (302). Anything else with no org is the lobby's (the sign-in page, the
 *   app's settings), as is everything for someone signed in nowhere.
 * - **Hosts orgs claimed** (`*` for every host but the app's own, which the
 *   app names: `resources.hosts.own`): the org that claimed it, for its
 *   routes by host alone (its runtime has the app's hosts too); a host
 *   nobody claimed, a 404.
 * - `GET /__copilotz/hosts/resolve?host=<h>`: whose a host is, `{ org,
 *   target? }` (or 404), for the app's front alone (it carries the front's
 *   secret, `resources.caller.front`), on any host: the front sends a host
 *   with a target (an app's service) straight there.
 */
import { failure, type Route, type Runtime, vouched } from "../../../../runtime/mod.ts";
import { enter, landing, personIn, profileOf, report } from "../shared/enter.ts";
import { CURRENT, json, navigating, orgCookie, orgsOf, RESOLVE } from "../shared/http.ts";
import { settingsOf } from "../shared/settings.ts";
import { claimOf, infoOf } from "../shared/state.ts";

type Dir = Pick<Runtime, "call" | "query" | "describe">;

/** The request, answered by an org's runtime, open for it: as it came. */
async function into(dir: Dir, org: string, request: Request): Promise<Response> {
  const runtime = await orgsOf(dir).get(org);
  if (!runtime) return json({ error: "No such org" }, 404);
  report(dir, org, runtime);
  return await runtime.fetch(request);
}

/** What answers someone signed in nowhere: the lobby the app gives (its sign-in page). */
async function lobby(dir: Dir, request: Request): Promise<Response> {
  const given = settingsOf({ resources: dir.describe().resources }).lobby;
  return given ? await given.fetch(request) : json({ error: "Not signed in" }, 401);
}

/** `/o/<org>` and `/o/<org>/…`: that org, by its address. */
export const addressedRoute: Route = async (request, { runtime, params }) => {
  const org = decodeURIComponent(params.org);
  const info = await infoOf(runtime, runtime.describe().resources, org);
  if (!info) return json({ error: "No such org" }, 404);
  if (info.suspended) return json({ error: "This org is suspended." }, 403);
  return await into(runtime, info.id, request);
};

/** `/*`: the org the browser is in, going in first when a page needs it to. */
export const currentRoute: Route = async (request, ctx) => {
  const { runtime, cookies } = ctx;
  const resources = runtime.describe().resources;
  const page = navigating(request);
  const org = cookies.get(CURRENT);
  const name = org ? orgCookie(org) : undefined;
  const held = name ? cookies.get(name) : undefined;
  const info = org && held ? await infoOf(runtime, resources, org) : null;
  if (info && !info.suspended) {
    // A page goes on only with a session that's still someone there.
    const open = page ? await orgsOf(runtime).get(info.id) : undefined;
    const good = !page ||
      !!await open?.query("credential.actor", { secret: held }).catch(() => null);
    if (good) return await into(runtime, info.id, request);
  } else if (info && !page) {
    return json({ error: "This org is suspended." }, 403);
  }
  if (ctx.actor.kind !== "person" || !page) return await lobby(runtime, request);
  // A page, for someone signed in at the directory: in the org they were in, else one that's theirs.
  const person = personIn(ctx);
  const profile = await profileOf(runtime, person);
  const called = profile?.name ?? profile?.email ?? person;
  const url = new URL(request.url);
  const to = url.pathname + url.search;
  const first = org && !info?.suspended ? org : await landing(runtime, person, called, org);
  try {
    return await enter(request, ctx, first, { to });
  } catch (error) {
    if ((error as { code?: string }).code !== "forbidden") throw error;
    return await enter(request, ctx, await landing(runtime, person, called, first), { to });
  }
};

/** `GET /__copilotz/hosts/resolve?host=`: whose a host is, for the front alone. */
export const resolveRoute: Route = async (request, { runtime }) => {
  if (request.method !== "GET") return json({ error: "Only GET" }, 405);
  const resources = runtime.describe().resources;
  const front = (resources.caller as { front?: string } | undefined)?.front;
  if (!vouched(request, front)) return json({ error: "The front's only" }, 403);
  const host = new URL(request.url).searchParams.get("host") ?? "";
  const claim = await claimOf(runtime, resources, host);
  return claim ? json(claim) : json({ error: "Nobody's host" }, 404);
};

/** Every host but the app's own: the org that claimed it, its routes by host alone. */
export const claimedRoute: Route = async (request, ctx) => {
  const { runtime } = ctx;
  const url = new URL(request.url);
  if (url.pathname === RESOLVE) return await resolveRoute(request, ctx);
  const resources = runtime.describe().resources;
  const claim = await claimOf(runtime, resources, url.host);
  const info = claim ? await infoOf(runtime, resources, claim.org) : null;
  if (!info) return json({ error: "Not found" }, 404);
  if (info.suspended) throw failure("forbidden", "This org is suspended.", { public: true });
  return await into(runtime, info.id, request);
};
