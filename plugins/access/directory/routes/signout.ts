/**
 * `POST /signout`, the directory's (in place of identity's): out of the
 * directory and every org the browser holds a session for. The directory's
 * session ends; each org's ends in its org when that org is open (signing
 * out never opens one: any request may name orgs in its cookies), and
 * whoever it was is disconnected there; the person's browsers in every org
 * open now go too. Every one of those cookies is cleared, and which org the
 * browser is in.
 */
import type { Actor, Route } from "../../../../runtime/mod.ts";
import { CURRENT, heldOrgs, json, SESSION, sessionOf } from "../shared/http.ts";
import { settingsOf } from "../shared/settings.ts";

export const signOutRoute: Route = async (request, { runtime, actor, cookies }) => {
  if (request.method !== "POST") return json({ error: "Only POST" }, 405);
  const secret = cookies.get(SESSION);
  if (secret && actor.kind === "person") {
    await runtime.call("session.end", { secret }, { actor }).catch(() => {});
    runtime.disconnect(actor);
  }
  const orgs = settingsOf({ resources: runtime.describe().resources }).orgs;
  await Promise.all(
    heldOrgs(request).map(async (org) => {
      const held = cookies.get(sessionOf(org));
      if (held === undefined) return;
      cookies.clear(sessionOf(org));
      const open = orgs?.peek(org);
      if (!open) return;
      const who = await open.query<Actor | null>("credential.actor", { secret: held })
        .catch(() => null);
      if (!who) return;
      await open.call("session.end", { secret: held }, { actor: who }).catch(() => {});
      open.disconnect(who);
    }),
  );
  // Their browsers in every org open now go: one comes back only with a cookie that's someone.
  if (actor.kind === "person") {
    for (const [, open] of orgs?.entries() ?? []) {
      open.disconnect({ kind: "person", id: actor.id });
    }
  }
  cookies.clear(SESSION);
  cookies.clear(CURRENT);
  return json({});
};
