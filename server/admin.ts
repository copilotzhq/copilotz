/**
 * Framework-independent admin helpers.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";
import { listPublicAgents } from "@/utils/list-agents.ts";
import type {
  AdminActivityOptions,
  AdminActivityPoint,
  AdminAgentListOptions,
  AdminAgentSummary,
  AdminOverview,
  AdminOverviewOptions,
  AdminParticipantListOptions,
  AdminParticipantSummary,
  AdminThreadListOptions,
  AdminThreadSummary,
} from "@/database/operations/index.ts";

/** Handlers returned by {@link createAdminHandlers}. */
export interface AdminHandlers {
  getOverview: (options?: AdminOverviewOptions) => Promise<AdminOverview>;
  getActivitySeries: (
    options?: AdminActivityOptions,
  ) => Promise<AdminActivityPoint[]>;
  listThreads: (
    options?: AdminThreadListOptions,
  ) => Promise<AdminThreadSummary[]>;
  listParticipants: (
    options?: AdminParticipantListOptions,
  ) => Promise<AdminParticipantSummary[]>;
  listAgents: (
    options?: Omit<AdminAgentListOptions, "configuredAgents">,
  ) => Promise<AdminAgentSummary[]>;
}

export function createAdminHandlers(copilotz: Copilotz): AdminHandlers {
  const { ops } = copilotz;

  return {
    getOverview: (options) => ops.getAdminOverview(options),
    getActivitySeries: (options) => ops.getAdminActivitySeries(options),
    listThreads: (options) => ops.listAdminThreads(options),
    listParticipants: (options) => ops.listAdminParticipants(options),
    listAgents: (options) =>
      ops.listAdminAgents({
        ...options,
        configuredAgents: listPublicAgents(copilotz.config.agents ?? []),
      }),
  };
}
