/**
 * The contacts' entrance to the web host (its `entrances` resource): a
 * browser is the visitor its cookie's secret is (`contact_visitor.actor`),
 * asked after people's sessions. A browser that isn't anyone, asking to come
 * in by one of the app's web lines (`POST /connect` `{ line }`: the page's
 * `web({ arrive: { line } })`), is let in as a new visitor
 * (`contact.arrive`), within the line's limits, the caller's address as the
 * app's front says it (`web.caller`). Its cookie comes only with the app's
 * own pages' requests (`SameSite=Strict`), and is this host's alone
 * (`__Host-visitor` wherever it's Secure): no other host under the domain can
 * set one to make a browser a visitor of its choosing, and read its chat.
 */
import { callerFrom, failure, type Resources, type Runtime } from "../../../../runtime/mod.ts";
import { lineOf, settingsOf } from "../shared/web.ts";

/** What the web host hands an entrance letting someone in (its `Door`). */
type Door = {
  runtime: Pick<Runtime, "call" | "describe">;
  asked: Record<string, unknown>;
};

type Arrived = { actor: { kind: string; id: string }; secret: string; days: number };

/** Lets a browser in as a new visitor of the line the page names; another's, it leaves alone. */
async function arrive(request: Request, door: Door) {
  const { line } = door.asked;
  if (typeof line !== "string") return null;
  const resources: Resources = door.runtime.describe().resources;
  if (!lineOf({ resources }, line)) return null;
  // Around the app's front, straight to the app: refused, when the front vouches for callers.
  const caller = callerFrom(request, settingsOf({ resources }).caller);
  if (caller === "refused") {
    throw failure("forbidden", "Not through the app's front.", { public: true });
  }
  const address = caller && !caller.exempt ? caller.counted : undefined;
  const { actor, secret, days } = await door.runtime.call<Arrived>("contact.arrive", {
    line,
    ...(address ? { address } : {}),
  });
  return { actor, secret, days };
}

export const visitorEntrance = {
  cookie: "visitor",
  query: "contact_visitor.actor",
  order: 100,
  sameSite: "strict" as const,
  hostOnly: true,
  arrive,
};
