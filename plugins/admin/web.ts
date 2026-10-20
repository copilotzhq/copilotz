import type { BrowserPlugin } from "@copilotz/copilotz/web";
import { coreWebPlugin } from "@copilotz/copilotz/core/web";
import { usageWebPlugin } from "@copilotz/copilotz/usage/web";
import overview from "./views/overview/index.tsx";
import query from "./views/query/index.tsx";
import records from "./views/records/index.tsx";
export const adminWebPlugin: BrowserPlugin = {
  id: "@copilotz/admin",
  plugins: [coreWebPlugin, usageWebPlugin],
  views: { overview, records, query },
  actions: Object.fromEntries(
    ["overview", "agents", "activity", "threads", "participants", "usage"].map((
      section,
    ) => [`admin${section[0].toUpperCase()}${section.slice(1)}`, {
      id: `copilotz.admin.${section}`,
      placement: "server" as const,
      query: {
        reads: section === "agents"
          ? []
          : ["thread", "message", "participant", "usage"],
      },
    }]),
  ),
  resources: {
    navigation: {
      admin: { label: "Administration", shows: "admin", value: null },
      ...Object.fromEntries(
        ["overview", "agents", "activity", "threads", "participants", "usage"]
          .map((
            section,
          ) => [`admin${section}`, {
            label: section[0].toUpperCase() + section.slice(1),
            shows: "adminQuery",
            value: { section },
          }]),
      ),
    },
  },
};
