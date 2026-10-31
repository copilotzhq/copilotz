/**
 * WhatsApp's web front end, for the browser: a space's WhatsApp tab
 * (spaces' `spaceTabs`): its number (connecting one, by those who manage
 * the space; its webhook; replacing its token; disconnecting it), and your
 * phone: linking it with a code you send from WhatsApp, and where your
 * messages go; and, in the command palette, getting there from a space.
 * Add it beside the web shell and spaces' front end:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, whatsappWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { whatsappPaletteView } from "./views/web/palette.ts";
import { whatsappView } from "./views/web/space.tsx";

export const whatsappWeb: Plugin = definePlugin({
  name: "whatsapp-web",
  requires: ["whatsapp", "web-shell"],
  views: {
    "whatsapp.space": { web: whatsappView },
    "whatsapp.palette": { web: whatsappPaletteView },
  },
  resources: {
    palette: { whatsapp: { view: "whatsapp.palette", order: 40 } },
    spaceTabs: {
      whatsapp: {
        title: "WhatsApp",
        view: "whatsapp.space",
        icon: "chat-round",
        under: "settings",
        group: "Channels",
        order: 40,
      },
    },
  },
});

export default whatsappWeb;
