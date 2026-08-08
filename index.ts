/**
 * Copilotz v3 public API.
 *
 * The root is a runtime-neutral composition barrel. Environment-specific
 * filesystem, process, server, and provider behavior lives in explicit
 * adapters or package subpaths.
 *
 * @module
 */

export * from "./runtime/application/index.ts";
export * from "./runtime/capabilities/index.ts";
export * from "./runtime/admin/index.ts";
export * from "./runtime/attachments/index.ts";
export * from "./runtime/channels/index.ts";
export * from "./runtime/content/index.ts";
export * from "./runtime/domain/index.ts";
export * from "./runtime/engine/index.ts";
export * from "./runtime/events/index.ts";
export * from "./runtime/execution/index.ts";
export * from "./runtime/features/index.ts";
export * from "./runtime/goals/index.ts";
export * from "./runtime/knowledge/index.ts";
export * from "./runtime/memory/index.ts";
export * from "./runtime/plugins/index.ts";
export * from "./runtime/resources/index.ts";
export * from "./runtime/schedules/index.ts";
export * from "./runtime/tools/index.ts";
export * from "./runtime/usage/index.ts";
export * from "./runtime/workflows/index.ts";
export {
  createManagedOminipgSession,
  createOminipgSqlSession,
} from "./runtime/adapters/ominipg.ts";
export type {
  CopilotzOminipgOptions,
  ManagedSqlSession,
  OminipgDatabaseLike,
} from "./runtime/adapters/ominipg.ts";
