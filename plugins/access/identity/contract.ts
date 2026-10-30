/**
 * The identity plugin's contract: what plugins built on it (sign-in methods
 * such as Google's) may import: the shapes of a person and a credential.
 * They reach the rest by name: the `person` collection, `session.start`.
 */
export type { Credential } from "./collections/credential.ts";
export type { Person } from "./collections/person.ts";
