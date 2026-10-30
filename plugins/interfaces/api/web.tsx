/**
 * The developer API's web front end, for the browser: a space's API tab
 * (spaces' `spaceTabs`), where a person makes keys for their code there,
 * picking what each does from presets (the `apiPresets` resource) or one by
 * one, sees its secret once, follows when each was last used, reads each
 * one's reference and revokes it; with what to paste in a terminal to try
 * it; and, in the command palette, a space's keys. Add it beside the web
 * shell and spaces' front end:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, apiWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { presets } from "./resources/presets.ts";
import { keysView } from "./views/web/keys.tsx";
import { apiPaletteView } from "./views/web/palette.ts";

export const apiWeb: Plugin = definePlugin({
  name: "api-web",
  requires: ["api", "web-shell"],
  views: { "api.keys": { web: keysView }, "api.palette": { web: apiPaletteView } },
  resources: {
    spaceTabs: { api: { title: "API", view: "api.keys", icon: "terminal", order: 85 } },
    apiPresets: presets,
    palette: { api: { view: "api.palette", order: 40 } },
  },
});

export default apiWeb;
