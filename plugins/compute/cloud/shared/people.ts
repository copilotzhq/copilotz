/** Who acts, and their say in the org (as the spaces plugin's `org.me` tells). */
import type { Context } from "../../../../runtime/mod.ts";
import { forbidden, invalid } from "../../../../runtime/mod.ts";
import { runsOrg } from "../../../access/spaces/contract.ts";

export type Standing = { role: string | null; staff: boolean; org?: { kind?: string } };

/** The caller's role in the org, and whether they're platform staff; no role in an app without roles. */
export const standingOf = (ctx: Context): Promise<Standing> =>
  ctx.call<Standing>("org.me", {}).catch(() => ({
    role: null,
    staff: ctx.actor?.staff === true,
  }));

/** Whether they run the org: its owners and admins, and platform staff. */
export const runs = (me: Standing) => me.staff || runsOrg(me.role);

export { forbidden };
export { invalid };
export const notFound = (message: string) =>
  Object.assign(new Error(message), { code: "not_found" });
