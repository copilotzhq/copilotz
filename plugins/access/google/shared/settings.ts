/** Google sign-in's settings: the `google` resource, which the app sets. */
import type { Resources } from "../../../../runtime/mod.ts";

export type GoogleSettings = {
  /** Your OAuth client's id (or several): tokens issued for another app are refused. */
  clientId: string | string[];
};

export const settingsOf = (ctx: { resources: Resources }): GoogleSettings =>
  (ctx.resources.google ?? {}) as GoogleSettings;
