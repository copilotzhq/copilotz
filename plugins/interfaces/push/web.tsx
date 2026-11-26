/**
 * Push notifications' web front end, for the browser: Notifications
 * (`/notifications`), in the person's menu, where they turn them on for this
 * device and off for any of theirs. Add it beside the web shell:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, pushWeb], root });
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { notificationsView } from "./views/web/notifications.tsx";

export const pushWeb: Plugin = definePlugin({
  name: "push-web",
  requires: ["push", "web-shell"],
  views: { notifications: notificationsView },
  resources: {
    userMenu: {
      notifications: { label: "Notifications", icon: "bell", href: "/notifications", order: 20 },
    },
  },
});

export default pushWeb;
