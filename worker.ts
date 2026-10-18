/** Worker-role package entry. Uses the same owner-connected createCopilotz
 * implementation as the root. No storage, legacy runtime, or implicit fallback.
 * The published transport pin does not yet supply required reverse calls;
 * callers must inject a compatible worker factory. @module */
export * from "./authoring.ts";
export { createOwnerConnectedApplication as createCopilotz } from "./runtime/application/owner-composition.ts";
export type {
  OwnerApplication,
  OwnerApplicationActionOptions,
  OwnerConnectionOptions,
  OwnerConnectionOptions as CreateCopilotzOptions,
} from "./runtime/application/owner-composition-types.ts";
