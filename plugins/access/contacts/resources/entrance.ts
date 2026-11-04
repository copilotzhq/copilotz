/**
 * The contacts' entrance to the web host (its `entrances` resource): a
 * browser is the visitor its cookie's secret is (`contact_visitor.actor`),
 * asked after people's sessions. A browser that isn't anyone, asking to come
 * in by one of the app's web lines (`POST /connect` `{ line }`: the page's
 * `web({ arrive: { line } })`), is let in as a visitor (`contact.arrive`):
 * one back with its secret, who hasn't spoken yet, as who it was; a newcomer
 * within the line's limits by address. The address is the app's front's
 * word for it (`web.caller`), else the socket's, as the web host's listener
 * saw it; with neither, nobody is let in (the limits by address would hold
 * nothing). Its cookie comes only with the app's own pages' requests
 * (`SameSite=Strict`), and is this host's alone (`__Host-visitor` wherever
 * it's Secure): no other host under the domain can set one to make a browser
 * a visitor of its choosing, and read its chat.
 */
import {
  callerFrom,
  countedOf,
  failure,
  type Resources,
  type Runtime,
} from "../../../../runtime/mod.ts";
import { lineOf, settingsOf } from "../shared/web.ts";

/** What the web host hands an entrance letting someone in (its `Door`). */
type Door = {
  runtime: Pick<Runtime, "call" | "describe">;
  asked: Record<string, unknown>;
  /** Where the request came from, as its socket says. */
  address?: string;
  /** The secret this entrance's cookie holds, that's nobody to its query. */
  secret?: string;
};

type Arrived = { actor: { kind: string; id: string }; secret: string; days: number };

/** What a visitor is counted by: refused, or an address (none: exempt from limits by address). */
function countedBy(request: Request, door: Door, resources: Resources): { address?: string } {
  const caller = settingsOf({ resources }).caller;
  if (caller) {
    // Around the app's front, straight to the app: refused, when the front vouches for callers.
    const said = callerFrom(request, caller);
    if (said === "refused") {
      throw failure("forbidden", "Not through the app's front.", { public: true });
    }
    return said && !said.exempt ? { address: said.counted } : {};
  }
  const address = door.address ? countedOf(door.address) : undefined;
  if (!address) {
    throw failure(
      "unavailable",
      "web.lines: no way to tell visitors apart, so none is let in: say how the app's front " +
        "names callers (web.caller), or serve with a listener that gives the socket's address " +
        "(copilotz/web/node's serve or listen; with one of your own, setClientAddress)",
    );
  }
  return { address };
}

/**
 * Lets a browser in as a visitor of the line the page names: back as the
 * one it was, with its secret, or new. Another line's, or no line asked, it
 * leaves alone.
 */
async function arrive(request: Request, door: Door) {
  const line = door.asked.line;
  if (typeof line !== "string") return null;
  const resources: Resources = door.runtime.describe().resources;
  if (!lineOf({ resources }, line)) return null;
  const { address } = countedBy(request, door, resources);
  const { actor, secret, days } = await door.runtime.call<Arrived>("contact.arrive", {
    line,
    ...(address ? { address } : {}),
    ...(door.secret ? { secret: door.secret } : {}),
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
