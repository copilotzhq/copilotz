/**
 * Dev sign-in: people sign in by the name they type, from this machine only,
 * for trying an app out (with the identity plugin). It declares itself to
 * the web host (`signIn.dev`, `local`): the page shows a field for the name,
 * and `POST /signin/dev` `{ name }` from a loopback address, to a loopback
 * host, with nothing saying a proxy forwarded it, sets the session's cookie.
 * Leave it out of a deployed app: an app whose `links` origin is public
 * (not this machine, nor one on its network) doesn't start with it, since a
 * proxy on its machine that says nothing of whom it forwards for would make
 * anyone this machine.
 *
 * ```ts
 * plugins: [...access, ...(process.env.DEV ? [devSignIn] : [])]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { signInAction } from "./actions/sign-in.ts";
import { publicOrigin } from "./shared/nearby.ts";

export const devSignIn: Plugin = definePlugin({
  name: "dev-sign-in",
  requires: ["identity"],
  actions: { "dev.sign-in": signInAction },
  resources: { signIn: { dev: { action: "dev.sign-in", local: true } } },
  check(merged) {
    const origin = publicOrigin(merged.resources);
    if (origin) {
      throw new Error(
        `devSignIn signs in by name, for this machine only, but the app's links origin ` +
          `(${origin}) is public: leave devSignIn out of a deployed app`,
      );
    }
  },
});
