/**
 * The access theme's contracts, for plugins built on it, in Copilotz or
 * outside it (`copilotz/plugins/access/contract`): each plugin's contract.ts,
 * the shapes of its documents and resource kinds and the little code that
 * goes with them (people by name, may, `signedIn`…), and nothing else. Safe
 * in the browser; plugins reach the rest by name, through the runtime.
 */
export * from "./spaces/contract.ts";
export * from "./identity/contract.ts";
export * from "./contacts/contract.ts";
export * from "./accounts/contract.ts";
export * from "./email/contract.ts";
// Both say `Profile`: a person's in the app is spaces'; who an account is there, accounts'.
export type { Profile } from "./spaces/contract.ts";
export type { Profile as AccountProfile } from "./accounts/contract.ts";
