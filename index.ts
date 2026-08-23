/**
 * Copilotz v3 public API.
 *
 * The root is a runtime-neutral composition barrel. Environment-specific
 * filesystem, process, server, and provider behavior lives in explicit
 * adapters or package subpaths.
 *
 * @module
 */

export * from "./runtime/application/public.ts";
export * from "./runtime/capabilities/index.ts";
export * from "./runtime/attachments/index.ts";
export * from "./runtime/collections/index.ts";
export * from "./runtime/content/index.ts";
export * from "./runtime/context/index.ts";
export * from "./runtime/domain/index.ts";
export * from "./runtime/events/index.ts";
export type * from "./runtime/engine/index.ts";
export type * from "./runtime/execution/index.ts";
export * from "./runtime/actions/index.ts";
export * from "./runtime/plugins/index.ts";
export * from "./runtime/resources/index.ts";
export * from "./runtime/tools/index.ts";
export * from "./runtime/llm/index.ts";
export * from "./runtime/agents/index.ts";
export type {
  CopilotzOminipgOptions,
  OminipgDatabaseLike,
} from "./runtime/adapters/ominipg.ts";
