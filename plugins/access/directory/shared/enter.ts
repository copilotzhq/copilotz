/**
 * Going into an org, from the directory's session: the directory lets the
 * person in (`org.enter`: a member, or staff), signs who goes in (the
 * handoff), and hands it to the org's own `/enter` (see member.ts), which
 * knows them there, starts its session and sets its cookie (`s_<org>`), as
 * a sign-in would: sessions stay the org's. The directory sets which org the
 * browser is in (`org`) on the org's answer, and passes it on: `{ org }`, or
 * a redirect for a page asked for (`to`).
 */
import { failure, type RouteContext, type Runtime } from "../../../../runtime/mod.ts";
import { baseOf, CURRENT, onBehalf, orgsOf } from "./http.ts";
import type { OrgInfo } from "./settings.ts";
import { HANDOFF, reportDue, signHandoff } from "./state.ts";

type Profile = { name?: string; email?: string; picture?: string };

/** What a sign-in verified about someone, at the directory. */
export const profileOf = (runtime: Pick<Runtime, "query">, person: string) =>
  runtime.query<Profile | null>("person.profile", { person }).catch(() => null);

/** Who's signed in at the directory (its session), or a 401. */
export function personIn(ctx: Pick<RouteContext, "actor">): string {
  if (ctx.actor.kind !== "person") {
    throw failure("unauthorized", "Not signed in", { public: true });
  }
  return ctx.actor.id;
}

/**
 * Tells the directory how an org is (its people and spaces, and that it was
 * used now), for staff's console: at most once a minute while it's used,
 * unless `now`. Nothing waits for it, and nothing fails for it.
 */
export function report(
  dir: Pick<Runtime, "call" | "describe">,
  org: string,
  runtime: Pick<Runtime, "call">,
  now = false,
): void {
  if (!reportDue(dir.describe().resources, org) && !now) return;
  void runtime.call<{ people: number; spaces: number }>("org.summary", {})
    .then((summary) =>
      dir.call("org.report", { org, ...summary, active: new Date().toISOString() })
    )
    .catch(() => {});
}

/**
 * Goes into `org` as the person the directory's session is: the org's answer
 * (its cookie set), with which org the browser is in set too.
 */
export async function enter(
  request: Request,
  ctx: Pick<RouteContext, "runtime" | "actor" | "cookies">,
  org: string,
  options: { staff?: boolean; to?: string } = {},
): Promise<Response> {
  const { runtime } = ctx;
  const person = personIn(ctx);
  const profile = await profileOf(runtime, person);
  const entered = await runtime.call<{ org: OrgInfo; role?: string; staff: boolean }>(
    "org.enter",
    {
      org,
      person,
      ...(profile?.email ? { email: profile.email } : {}),
      ...(options.staff ? { staff: true } : {}),
    },
  );
  const id = entered.org.id;
  const target = await orgsOf(runtime).get(id);
  if (!target) {
    throw failure("not_found", "No such org, or not one you belong to.", { public: true });
  }
  const query = await signHandoff(runtime.describe().resources, {
    org: id,
    person,
    ...(profile?.email ? { email: profile.email } : {}),
    ...(profile?.name ? { name: profile.name } : {}),
    ...(profile?.picture ? { picture: profile.picture } : {}),
    ...(entered.role ? { role: entered.role } : {}),
    ...(entered.staff ? { staff: true } : {}),
    ...(options.to ? { to: options.to } : {}),
  });
  const answered = await target.fetch(onBehalf(request, `${baseOf(id)}${HANDOFF}${query}`));
  if (answered.status < 400) {
    ctx.cookies.set(CURRENT, id);
    report(runtime, id, target, true);
  }
  return answered;
}

/** The org someone goes back to: the one they were in last (not `not`), or their own, made now. */
export async function landing(
  runtime: Pick<Runtime, "call">,
  person: string,
  name: string,
  not?: string,
): Promise<string> {
  const { orgs } = await runtime.call<{ orgs: { id: string; suspended?: true }[] }>(
    "org.mine",
    { person },
  );
  const open = orgs.filter((o) => o.id !== not && !o.suspended);
  if (open.length) return open[0].id;
  const { org } = await runtime.call<{ org: string }>("org.create", {
    name,
    kind: "personal",
    by: person,
  });
  return org;
}
