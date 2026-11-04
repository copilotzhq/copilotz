/**
 * Google sign-in: `google.sign-in` turns a Google ID token into a person
 * and a session (with the identity plugin). The `google` resource's
 * `clientId` is your OAuth client's (or several): tokens issued for another
 * app are refused. It declares itself to the web host (`signIn.google`):
 * the page shows Google's button for the first client id, and
 * `POST /signin/google` `{ idToken }` sets the session's cookie.
 *
 * ```ts
 * plugins: [spaces, identity, googleSignIn, definePlugin({
 *   name: "app",
 *   resources: { google: { clientId: "1234.apps.googleusercontent.com" } },
 * })]
 * const { session } = await runtime.call("google.sign-in", { idToken });
 * // Set-Cookie: session=<session>; HttpOnly; Secure; SameSite=Lax; Path=/
 * ```
 */
import { definePlugin, type Plugin, type Resources } from "../../../runtime/mod.ts";
import { signInAction } from "./actions/sign-in.ts";
import { googleKeys } from "./adapters/keys.ts";
import { settingsOf } from "./shared/settings.ts";

export type { GoogleKeys } from "./adapters/keys.ts";
export { type Claims, type Jwk, verify } from "./shared/jwt.ts";

export type { GoogleSettings } from "./shared/settings.ts";

export const googleSignIn: Plugin = definePlugin({
  name: "google-sign-in",
  requires: ["identity"],
  actions: { "google.sign-in": signInAction },
  adapters: { googleKeys: { google: googleKeys() } },
  resources: {
    // The page's button is for the web client: the first id, when there are several.
    signIn: {
      google: {
        action: "google.sign-in",
        page: (resources: Resources) => ({
          clientId: [settingsOf({ resources }).clientId].flat()[0],
        }),
      },
    },
  },
  check(merged) {
    if (!settingsOf(merged).clientId) throw new Error("set the google resource's clientId");
  },
});
