/**
 * Google sign-in on the web: Google's button posts its ID token to
 * `/signin/google` (`{ idToken }`), which signs in (`google.sign-in`) and
 * sets the session's cookie; the page asks `GET /google` for the client id
 * its button is for (the first, when there are several), while Google's
 * script loads. Anyone may ask it, and browsers keep it five minutes.
 */
import { jsonOf, type Route } from "../../../../runtime/mod.ts";
import { signedIn } from "../../identity/contract.ts";
import { settingsOf } from "../shared/settings.ts";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** `POST /signin/google`: Google's ID token, traded for a session in its cookie. */
export const googleSignInRoute: Route = async (request, { runtime, cookies }) => {
  if (request.method !== "POST") return json({ error: "Only POST" }, 405);
  const asked = await jsonOf(request);
  if (!asked) return json({ error: "Send a JSON object, of 16 KiB at most" }, 400);
  const { idToken } = asked;
  if (typeof idToken !== "string" || !idToken) return json({ error: "Send { idToken }" }, 400);
  return signedIn(cookies, await runtime.call("google.sign-in", { idToken }));
};

/** `GET /google`: the client id the page's button is for. */
export const googleClientRoute: Route = (request, { runtime }) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Only GET" }, 405);
  }
  const clientId = [settingsOf({ resources: runtime.describe().resources }).clientId].flat()[0];
  return new Response(JSON.stringify({ clientId }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
};
