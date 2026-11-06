/**
 * Where a request came from, as the socket says: the peer address the
 * listener saw (Oxian's adapters keep it on the request they make, from the
 * socket: `getClientAddress`), never a header anyone may send. What routes
 * go by for what only this machine may do (dev sign-in) and, for an app
 * without a front that says who calls, what the site chat counts its
 * visitors by.
 *
 * A request `runtime.fetch` makes from another (the site the front says, the
 * path under the app's base) keeps the address (`carry`). An app serving
 * with a listener of its own sets it (`setClientAddress(request,
 * info.remoteAddr.hostname)` with `Deno.serve`); without one, a request comes
 * from nowhere known: never this machine, and no visitor is let in by address.
 */
import { getClientAddress } from "@oxian/oxian-js/http";

/** Addresses set here, for requests a listener didn't make (or made, then the host copied). */
const set = new WeakMap<Request, string>();

/** The address a request came from, as its socket says; undefined when nothing says. */
export function clientAddress(request: Request): string | undefined {
  return getClientAddress(request) ?? set.get(request);
}

/**
 * Says where a request came from: the socket's peer address, as the app's
 * own listener saw it (never a header's). Returns the request.
 */
export function setClientAddress(request: Request, address: string): Request {
  set.set(request, address);
  return request;
}

/** A request made from another keeps its address. */
export function carry(to: Request, from: Request): Request {
  const address = clientAddress(from);
  if (address !== undefined) set.set(to, address);
  return to;
}

/** Whether an address is this machine's own: 127.0.0.0/8, `::1`, or IPv4's written as IPv6. */
export function loopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const plain = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  if (plain === "::1" || plain === "0:0:0:0:0:0:0:1") return true;
  const four = /^(?:::ffff:)?(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(plain);
  return !!four && Number(four[1]) === 127;
}
