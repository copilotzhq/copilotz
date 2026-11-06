/**
 * A site visitor arriving: `POST /web/<name>` (the page's `web({ arrive: {
 * name } })` posts it before `/connect`). A browser that's someone already
 * (a person signed in, or this line's visitor: its cookie, which the web
 * lines' `who` reads) passes as it is. One that isn't anyone is let in as a
 * newcomer (`contact.arrive`): within the line's limits by address, and past
 * its challenge, when it has one (`{ challenge }`, what the page answered
 * it with). The address is the app's front's word for it (the `caller` resource),
 * else the socket's, as the listener saw it; with neither, nobody is let in
 * (the limits by address would hold nothing). Its secret goes in the
 * `visitor` cookie, which comes only with the app's own pages' requests
 * (`SameSite=Strict`), and is this host's alone (`__Host-visitor` wherever
 * it's Secure): no other host under the domain can set one to make a
 * browser a visitor of its choosing, and read its chat.
 */
import {
  callerFrom,
  callerOf,
  clientAddress,
  countedOf,
  failure,
  jsonOf,
  privateAddress,
  type Resources,
  type Route,
} from "../../../../runtime/mod.ts";
import { siteOf } from "../shared/lines.ts";

/** The cookie a visitor's secret is kept in. */
export const VISITOR_COOKIE = "visitor";

type Arrived = { actor: { kind: string; id: string }; secret: string; days: number };

/** What a route answers in JSON is someone's: never kept. */
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** The runtimes already told their visitors all come from a private address. */
const told = new WeakSet<object>();

/**
 * Says, once a runtime, when visitors are counted by a socket's private
 * address (a proxy's or a load balancer's before the app, not theirs): every
 * visitor is then one caller, and the limits by address are the whole line's.
 */
function tellPrivate(runtime: object, address: string) {
  if (told.has(runtime) || !privateAddress(address)) return;
  told.add(runtime);
  console.warn(
    `web: visitors come from ${address}, a private address: a proxy or a load ` +
      "balancer's before the app, not theirs. Every visitor is then counted as one caller, " +
      "so the limits by address hold for everyone together. Say how the app's front names " +
      "callers (the caller resource), unless this is a machine of your own.",
  );
}

/** What a visitor is counted by: refused, or an address (none: exempt from limits by address). */
function countedBy(request: Request, runtime: object, resources: Resources): { address?: string } {
  const caller = callerOf({ resources });
  if (caller) {
    // Around the app's front, straight to the app: refused, when the front vouches for callers.
    const said = callerFrom(request, caller);
    if (said === "refused") {
      throw failure("forbidden", "Not through the app's front.", { public: true });
    }
    return said && !said.exempt ? { address: said.counted } : {};
  }
  const seen = clientAddress(request);
  const address = seen ? countedOf(seen) : undefined;
  if (!address) {
    throw failure(
      "unavailable",
      "web: no way to tell visitors apart, so none is let in: say how the app's front " +
        "names callers (the caller resource), or serve with a listener that gives the socket's address " +
        "(Deno.serve(runtime.fetch), copilotz/web/node's listen; with one of your own, " +
        "setClientAddress)",
    );
  }
  tellPrivate(runtime, seen!);
  return { address };
}

/** `POST /web/<name>`: a browser coming in by one of the app's web sites (see above). */
export const arriveRoute: Route = async (request, { runtime, actor, params, cookies }) => {
  if (request.method !== "POST") return json({ error: "Only POST" }, 405);
  let line: string;
  try {
    line = decodeURIComponent(params.name ?? "");
  } catch {
    line = "";
  }
  const resources: Resources = runtime.describe().resources;
  if (!siteOf({ resources }, line)) return json({ error: "There's no such chat here." }, 404);
  // Someone already: a person signed in comes in as themselves, a visitor of this line as itself.
  if (actor.kind === "person" || (actor.kind === "contact" && actor.web === line)) return json({});
  const asked = await jsonOf(request);
  if (!asked) return json({ error: "Send a JSON object, of 16 KiB at most" }, 400);
  const { address } = countedBy(request, runtime, resources);
  const answer = asked.challenge;
  const { secret, days } = await runtime.call<Arrived>("contact.arrive", {
    line,
    ...(address ? { address } : {}),
    ...(typeof answer === "string" && answer ? { challenge: answer.slice(0, 4096) } : {}),
  });
  cookies.set(VISITOR_COOKIE, secret, { days, sameSite: "strict" });
  return json({});
};
