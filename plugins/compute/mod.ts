/** Compute: computers people connect, those the app hosts (cloud), what agents do on them, and the apps they publish. */
export * from "./computers/mod.ts";
export * from "./cloud/mod.ts";
export * from "./apps/mod.ts";
/** Hosts: Compute Engine for cloud computers, Cloud Run (and a local one) for apps, and Google's tokens they use. */
export { gceHost, type GceOptions } from "./cloud/adapters/gce/index.ts";
export { type GoogleAuthOptions, googleToken } from "./cloud/shared/google.ts";
export { cloudRun, cloudRunHost, type CloudRunOptions } from "./apps/adapters/cloudrun.ts";
export {
  type LocalHost as LocalApps,
  localHost as localApps,
  type LocalHostOptions as LocalAppsOptions,
} from "./apps/adapters/local.ts";
