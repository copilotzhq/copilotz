/** @module Composes the Admin Action primitives into the Admin plugin. */
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import {
  adminActivityAction,
  adminAgentsAction,
  adminOverviewAction,
  adminParticipantsAction,
  adminThreadsAction,
  adminUsageAction,
} from "./actions/index.ts";
import type { CreateAdminPluginOptions } from "./internal/contracts.ts";

const DEFAULT_PLUGIN_ID = "@copilotz/admin";
const DEFAULT_PLUGIN_VERSION = "3.0.0";

export function createAdminPlugin(
  options: CreateAdminPluginOptions = {},
): CopilotzPlugin {
  return definePlugin({
    id: options.id?.trim() || DEFAULT_PLUGIN_ID,
    version: options.version?.trim() || DEFAULT_PLUGIN_VERSION,
    actions: {
      adminOverview: adminOverviewAction,
      adminActivity: adminActivityAction,
      adminThreads: adminThreadsAction,
      adminParticipants: adminParticipantsAction,
      adminUsage: adminUsageAction,
      adminAgents: adminAgentsAction,
    },
  });
}
