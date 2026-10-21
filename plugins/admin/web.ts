import type { BrowserPlugin } from "@copilotz/copilotz/web";
import { coreWebPlugin } from "@copilotz/copilotz/core/web";
import { usageWebPlugin } from "@copilotz/copilotz/usage/web";
import overview from "./views/overview/index.tsx";
import query from "./views/query/index.tsx";
import records from "./views/records/index.tsx";
import agent from "./views/agent/index.tsx";
import participant from "./views/participant/index.tsx";

export type AdminSection =
  | "overview"
  | "agents"
  | "activity"
  | "threads"
  | "participants"
  | "usage";
export interface AdminWebOptions {
  actionAliases?: Partial<Record<AdminSection, string>>;
}
/** Configure the browser registry to match the installed server Actions. */
export function createAdminWebPlugin(
  { actionAliases = {} }: AdminWebOptions = {},
): BrowserPlugin {
  return {
    id: "@copilotz/admin",
    plugins: [coreWebPlugin, usageWebPlugin],
    views: { overview, records, query, agent, participant },
    actions: Object.fromEntries(
      ([
        "overview",
        "agents",
        "activity",
        "threads",
        "participants",
        "usage",
      ] as const).map((
        section,
      ) => [
        actionAliases[section] ??
          `admin${section[0].toUpperCase()}${section.slice(1)}`,
        {
          id: `copilotz.admin.${section}`,
          placement: "server" as const,
          query: {
            reads: section === "agents"
              ? []
              : ["thread", "message", "participant", "usage"],
          },
        },
      ]),
    ),
    resources: {
      admin: { actionAliases },
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
}
export const adminWebPlugin: BrowserPlugin = createAdminWebPlugin();
