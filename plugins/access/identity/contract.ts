/**
 * The identity plugin's contract: what plugins built on it (sign-in methods
 * such as Google's) may import: the shapes of a person and a credential, and
 * how a sign-in route answers (`signedIn`). They reach the rest by name: the
 * `person` collection, `session.start`.
 */
import type { Cookies } from "../../../runtime/mod.ts";

export type { Credential } from "./collections/credential.ts";
export type { Person } from "./collections/person.ts";

/** The cookie a person's session is kept in (`__Host-session` wherever it's Secure). */
export const SESSION = "session";

/**
 * A sign-in route's answer, once its Action answered `{ person, session }`:
 * the session set in its cookie (httpOnly, `SameSite=Lax`, so an OAuth
 * provider's redirect back carries it; 30 days), and `{ person }`. A plugin
 * built on identity may set its cookie so.
 */
export function signedIn(
  cookies: Cookies,
  answered: { person?: unknown; session?: unknown },
): Response {
  const { person, session } = answered;
  if (typeof person !== "string" || !person || typeof session !== "string") {
    throw new Error("A sign-in answered no person, or no session");
  }
  cookies.set(SESSION, session);
  return new Response(JSON.stringify({ person }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
