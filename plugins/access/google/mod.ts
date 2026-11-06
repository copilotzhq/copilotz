/**
 * Google sign-in: `google.sign-in` turns a Google ID token into a person
 * and a session (with the identity plugin). The `google` resource's
 * `clientId` is your OAuth client's (or several): tokens issued for another
 * app are refused. Its routes: `GET /google` gives the page the first
 * client id, for Google's button, and `POST /signin/google` `{ idToken }`
 * (what the button posts) sets the session's cookie (see routes/sign-in.ts).
 *
 * ```ts
 * plugins: [spaces, identity, googleSignIn, definePlugin({
 *   name: "app",
 *   resources: { google: { clientId: "1234.apps.googleusercontent.com" } },
 * })]
 * const { session } = await runtime.call("google.sign-in", { idToken });
 * // Set-Cookie: __Host-session=<session>; HttpOnly; SameSite=Lax; Path=/; …; Secure
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { signInAction } from "./actions/sign-in.ts";
import { googleKeys } from "./adapters/keys.ts";
import { googleClientRoute, googleSignInRoute } from "./routes/sign-in.ts";
import { settingsOf } from "./shared/settings.ts";

export type { GoogleKeys } from "./adapters/keys.ts";
export { type Claims, type Jwk, verify } from "./shared/jwt.ts";

export type { GoogleSettings } from "./shared/settings.ts";

export const googleSignIn: Plugin = definePlugin({
  name: "google-sign-in",
  requires: ["identity"],
  actions: { "google.sign-in": signInAction },
  adapters: { googleKeys: { google: googleKeys() } },
  routes: { "/signin/google": googleSignInRoute, "/google": googleClientRoute },
  check(merged) {
    if (!settingsOf(merged).clientId) throw new Error("set the google resource's clientId");
  },
});
