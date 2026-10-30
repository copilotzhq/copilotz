/**
 * Access: who can see and do what (see design/access.md).
 *
 * - `spaces`: spaces, members, reach, and the rules every collection that
 *   shares its documents keeps to;
 * - `identity`: people, sessions and keys, and who a secret proves;
 * - `googleSignIn`: sign-in with a Google ID token (the `google` resource
 *   names your client).
 *
 *   plugins: [...access, googleSignIn, { name: "app", resources: { shared: { note: {} } } }]
 */
import type { Plugin } from "../../runtime/mod.ts";
import { identity } from "./identity/mod.ts";
import { spaces } from "./spaces/mod.ts";

export * from "./spaces/mod.ts";
export * from "./identity/mod.ts";
export * from "./google/mod.ts";

/** Spaces and identity, which every app with people has; Google sign-in is added beside them. */
export const access: Plugin[] = [spaces, identity];
