/**
 * Dev sign-in: people sign in by the name they type, from this machine only,
 * for trying an app out (with the identity plugin). It declares itself to
 * the web host (`signIn.dev`, `local`): the page shows a field for the name,
 * and `POST /signin/dev` `{ name }` from a loopback address sets the
 * session's cookie. Leave it out of a deployed app.
 *
 * ```ts
 * plugins: [...access, ...(process.env.DEV ? [devSignIn] : [])]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { signInAction } from "./actions/sign-in.ts";

export const devSignIn: Plugin = definePlugin({
  name: "dev-sign-in",
  requires: ["identity"],
  actions: { "dev.sign-in": signInAction },
  resources: { signIn: { dev: { action: "dev.sign-in", local: true } } },
});
