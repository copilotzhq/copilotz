/**
 * The app host the settings name (`host`), from the `appHost` adapters: a
 * host as it is, or what makes one from the settings (Cloud Run's maker,
 * from `cloudrun`: see adapters/cloudrun.ts), made once per runtime.
 *
 * ```ts
 * adapters: { appHost: { cloudrun: cloudRun({ token }) } }   // made from settings.cloudrun
 * adapters: { appHost: { local: localHost() } }              // development and tests
 * ```
 */
import type { Adapters, Resources } from "../../../../runtime/mod.ts";
import type { AppHost } from "../contract.ts";
import { failure } from "./errors.ts";
import { type Settings, settingsOf } from "./settings.ts";

/** An `appHost` adapter: a host, or what makes one from the apps settings. */
export type AppHostAdapter = AppHost | ((settings: Settings) => AppHost);

const made = new WeakMap<Adapters, Map<string, AppHost>>();

export function hostOf(ctx: { resources: Resources; adapters: Adapters }): AppHost {
  const settings = settingsOf(ctx);
  const adapter = ctx.adapters.appHost?.[settings.host] as AppHostAdapter | undefined;
  if (!adapter) {
    throw failure(
      `There's no app host "${settings.host}" here to publish to (adapters.appHost).`,
      "unavailable",
    );
  }
  if (typeof adapter !== "function") return adapter;
  let mine = made.get(ctx.adapters);
  if (!mine) made.set(ctx.adapters, mine = new Map());
  let host = mine.get(settings.host);
  if (!host) mine.set(settings.host, host = adapter(settings));
  return host;
}
