/** @module Public API barrel for the Admin plugin. */
export { createAdminPlugin } from "./plugin.ts";
export type {
  AdminActivityPoint,
  AdminRequest,
  AdminResponse,
  AdminUsageTotals,
  CreateAdminPluginOptions,
} from "./internal/contracts.ts";
