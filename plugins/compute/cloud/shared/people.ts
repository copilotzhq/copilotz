/** Who acts, and their say in the org (as the spaces plugin's `org.me` tells). */
import type { Actor, Context } from "../../../../runtime/mod.ts";

/** The person acting, or whom an agent (`for`) or trusted code (`via`) acts for. */
export function personOf(actor: Actor | undefined): string | undefined {
  for (let a = actor, hops = 0; a && hops < 4; hops++) {
    if (a.kind === "person") return a.id;
    a = (a.for ?? a.via) as Actor | undefined;
  }
  return undefined;
}

export type Standing = { role: string | null; staff: boolean; org?: { kind?: string } };

/** The caller's role in the org, and whether they're platform staff; no role in an app without roles. */
export const standingOf = (ctx: Context): Promise<Standing> =>
  ctx.call<Standing>("org.me", {}).catch(() => ({
    role: null,
    staff: ctx.actor?.staff === true,
  }));

/** Whether they run the org: its owners and admins, and platform staff. */
export const runs = (me: Standing) => me.staff || me.role === "owner" || me.role === "admin";

export const forbidden = (message: string) =>
  Object.assign(new Error(message), { code: "forbidden" });
export const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });
export const notFound = (message: string) =>
  Object.assign(new Error(message), { code: "not_found" });
