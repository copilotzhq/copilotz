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
  /** The app's Core plugin, when it configures its own (`createCoreWebPlugin`). */
  core?: BrowserPlugin;
}
/**
 * Configure the browser registry to match the installed server Actions. With
 * the chat shell, the user menu gains "Administration", which opens the
 * `admin` page in main.
 */
export function createAdminWebPlugin(
  { actionAliases = {}, core = coreWebPlugin }: AdminWebOptions = {},
): BrowserPlugin {
  return {
    id: "@copilotz/admin",
    plugins: [core, usageWebPlugin],
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
      userMenu: {
        admin: {
          label: "Administration",
          icon: "shield",
          page: "admin",
          order: 80,
        },
      },
    },
  };
}
export const adminWebPlugin: BrowserPlugin = createAdminWebPlugin();
