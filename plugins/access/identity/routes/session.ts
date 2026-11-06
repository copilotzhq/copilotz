/**
 * A person's session, on the web: its cookie (`session`), which identity's
 * `who` reads, and the routes around it.
 *
 * - `signedIn` (in the contract): what a sign-in route answers once a
 *   sign-in Action made a session (Google's, dev's).
 * - `POST /signout`: the session ends (`session.end`), the browsers and
 *   tickets of whoever it was go (`runtime.disconnect`), and its cookie is
 *   cleared.
 * - `GET /me`: what the person signed in is shown as (their name and email,
 *   as a sign-in verified them), for the page: 401 for anyone else.
 */
import type { Actor, Route } from "../../../../runtime/mod.ts";
import { SESSION } from "../contract.ts";

/** What a route answers in JSON is someone's: never kept. */
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** `POST /signout`: the session ends, whoever it was is disconnected, and its cookie goes. */
export const signOut: Route = async (request, { runtime, cookies }) => {
  if (request.method !== "POST") return json({ error: "Only POST" }, 405);
  const secret = cookies.get(SESSION);
  if (secret) {
    const actor = await runtime.query<Actor | null>("credential.actor", { secret })
      .catch(() => null);
    if (actor) {
      await runtime.call("session.end", { secret }, { actor }).catch(() => {});
      runtime.disconnect(actor);
    }
  }
  cookies.clear(SESSION);
  return json({});
};

/** `GET /me`: the person signed in, as a sign-in verified them. */
export const me: Route = async (request, { runtime, actor }) => {
  if (request.method !== "GET") return json({ error: "Only GET" }, 405);
  if (actor.kind !== "person") return json({ error: "Not signed in" }, 401);
  const profile = await runtime.query<{ name?: string; email?: string } | null>(
    "person.profile",
    { person: actor.id },
  ).catch(() => null);
  return json({
    person: actor.id,
    ...(profile?.name ? { name: profile.name } : {}),
    ...(profile?.email ? { email: profile.email } : {}),
  });
};
