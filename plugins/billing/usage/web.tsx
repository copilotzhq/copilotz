/**
 * Usage's web front end: where the app serves many orgs, the org page's
 * Usage section (the web shell's `orgSettings`): what was used and what it
 * was charged (its spend) over a period, day by day and against the period
 * before, by person, agent and model, caching, and the latest calls. Its
 * owners and admins see everyone's (`usage.org`, `usage.calls`); anyone
 * else, their own; platform staff, what it cost and the margin too. Add it
 * beside the web shell, where the browser draws.
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
