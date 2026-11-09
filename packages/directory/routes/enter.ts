/**
 * `POST /enter`, an org's own (under its address: `/o/<org>/enter`), which
 * only the directory's handoff opens (see shared/enter.ts): the person it
 * signs goes into this org. As a sign-in does: what the directory verified
 * about them is kept (`person.set`), they join with the handoff's role the
 * first time (`org.join`; staff who don't belong, never), and a session
 * starts (`session.start`), set in the org's cookie (identity's `session`,
 * which this org's runtime names `s_<org>`). A session they already hold
 * here, as the same person and the same standing, stays. Then `{ org }`, or
 * a redirect to the page they asked for (`to`).
 */
import type { Actor, Route } from "copilotz";
import { SESSION } from "copilotz/plugins/access/contract";
import { json } from "../shared/http.ts";
import { readHandoff } from "../shared/state.ts";

/** A path on the app (never another host's): where a handoff may send the browser. */
const onApp = (to: string) => to.startsWith("/") && !to.startsWith("//") && !to.includes("\\");

/** The org's `/enter`, checking handoffs with the key of `directory` (its resources). */
export const enterRoute = (
  directory: Record<string, Record<string, unknown>>,
  org: { id: string; name: string; kind: string },
): Route =>
async (request, { runtime, cookies }) => {
  if (request.method !== "POST") return json({ error: "Only POST" }, 405);
  const handoff = await readHandoff(directory, new URL(request.url).searchParams);
  if (!handoff || handoff.org !== org.id) {
    return json({ error: "Only the directory sends people in here" }, 403);
  }
  if (handoff.to !== undefined && !onApp(handoff.to)) {
    return json({ error: "Not a page of the app" }, 400);
  }
  const { person } = handoff;
  const staff = handoff.staff === true;
  await runtime.call("person.set", {
    person,
    ...(handoff.email ? { email: handoff.email } : {}),
    ...(handoff.name ? { name: handoff.name } : {}),
    ...(handoff.picture ? { picture: handoff.picture } : {}),
  });
  // Staff going into an org they don't belong to aren't made one of its people.
  if (!staff || handoff.role) {
    await runtime.call("org.join", { person, ...(handoff.role ? { role: handoff.role } : {}) });
  }
  const held = cookies.get(SESSION);
  const kept = held
    ? await runtime.query<Actor | null>("credential.actor", { secret: held }).catch(() => null)
    : null;
  const session = kept?.id === person && (kept.staff === true) === staff
    ? held!
    : (await runtime.call<{ session: string }>("session.start", {
      person,
      ...(staff ? { staff: true } : {}),
    })).session;
  cookies.set(SESSION, session);
  if (handoff.to) {
    return new Response(null, {
      status: 302,
      headers: { location: handoff.to, "cache-control": "no-store" },
    });
  }
  return json({ org: { id: org.id, name: org.name, kind: org.kind } });
};
