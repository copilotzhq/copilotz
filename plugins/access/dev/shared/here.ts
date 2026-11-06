/**
 * Whether a request is this machine's, to this machine: what dev sign-in
 * answers only. The socket it came on is loopback (its client address, as
 * the listener saw it), and so is the host it's for (the site the browser
 * asked for), and nothing says a proxy forwarded it (`forwarded`): one on
 * this machine reaches the app over loopback, and may rewrite `Host` to the
 * app's own. No header makes it so (`Host: localhost` from elsewhere isn't),
 * nor does a page another site served whose name now points here; a request
 * whose address nobody set is from nowhere known, never here. A proxy that
 * says nothing of whom it forwards for (nginx's `proxy_pass` as it comes)
 * can't be told from this machine: dev sign-in refuses to start in an app
 * with a public origin.
 */
import { clientAddress, loopback, loopbackAddress } from "../../../../runtime/mod.ts";

/**
 * Headers a proxy adds to say whom it forwards for, or that it did:
 * `forwarded`, `via`, any `x-forwarded-*`, the client-address headers
 * fronts set (`x-real-ip`, `x-client-ip`, `x-cluster-client-ip`,
 * `cf-connecting-ip`, `true-client-ip`, `fastly-client-ip`), Cloudflare's
 * `cf-ray`, and the app's own front's (`x-copilotz-front`).
 */
const FORWARDING =
  /^(?:forwarded|via|x-forwarded-.+|x-real-ip|x-client-ip|x-cluster-client-ip|cf-connecting-ip|cf-ray|true-client-ip|fastly-client-ip|x-copilotz-front)$/;

/** Whether a request says a proxy forwarded it (see `FORWARDING`). */
export const forwarded = (request: Request): boolean =>
  [...request.headers.keys()].some((name) => FORWARDING.test(name.toLowerCase()));

/** Whether a request is this machine's, to this machine (see above). */
export function fromHere(request: Request): boolean {
  if (!loopbackAddress(clientAddress(request))) return false;
  if (forwarded(request)) return false;
  return loopback(new URL(request.url).hostname);
}
