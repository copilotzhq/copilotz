/**
 * Apps' web front end, for the browser. Under a job that serves a port (the
 * computers' `jobActions`): "Publish", and its dialog (a name, with the
 * address it makes shown as it's typed; the folder; the port), then the app
 * as it builds, live, until it's live at its address, or what went wrong,
 * with Try again; once published, how it's going. A space's Apps tab
 * (spaces' `spaceTabs`): its apps, live, building or failed, each opened,
 * copied, published again, given its own environment or taken down. Under
 * a space's environment (computers' `envActions`): its live apps, given it
 * again. Add it beside computers' front end:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, computersWeb, appsWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { appEnvApplyView } from "./views/web/env.tsx";
import { appPublishView } from "./views/web/publish.tsx";
import { appsSpaceView } from "./views/web/space.tsx";

export const appsWeb: Plugin = definePlugin({
  name: "apps-web",
  requires: ["apps", "computers-web", "spaces-web"],
  views: {
    "app.publish": { web: appPublishView },
    "app.space": { web: appsSpaceView },
    "app.env-apply": { web: appEnvApplyView },
  },
  resources: {
    jobActions: { publish: { view: "app.publish", order: 10 } },
    envActions: { apps: { view: "app.env-apply", order: 10 } },
    spaceTabs: { apps: { title: "Apps", view: "app.space", icon: "globe", order: 35 } },
  },
});
