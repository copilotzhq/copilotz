/**
 * The compute theme's contracts, for plugins built on it, in Copilotz or
 * outside it (`copilotz/plugins/compute/contract`): computers', cloud
 * computers' and apps' contract.ts, and nothing else. Plugins reach the rest
 * by name, through the runtime.
 */
export * from "./computers/contract.ts";
export * from "./cloud/contract.ts";
export * from "./apps/contract.ts";
