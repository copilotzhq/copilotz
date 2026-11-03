/**
 * Usage's web front end: where the app serves many orgs, the org page's
 * Usage section (the web shell's `orgSettings`): what was spent in the
 * billing month, against the budget and the credits left (`billing.state`,
 * when the credits plugin is there) and the same point of the month
 * before; day by day and ranked by kind, space, person, agent or model;
 * and what was done (turns, computers' sessions, apps' days). Its owners
 * and admins see everyone's (`usage.org`, `usage.activity`); anyone else,
 * their own; platform staff, what it cost and the margin too. Add it beside
 * the web shell, where the browser draws.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { orgUsageView } from "./views/web/org.tsx";

export const usageWeb: Plugin = definePlugin({
  name: "usage-web",
  requires: ["web-shell"],
  views: { "usage.org": { web: orgUsageView } },
  resources: {
    orgSettings: { usage: { title: "Usage", view: "usage.org", icon: "chart", order: 30 } },
  },
});

export default usageWeb;
