/**
 * The apps plugin's settings (the `apps` resource): which app host builds
 * and runs apps (`host`: an `appHost` adapter's name, `local` or
 * `cloudrun`), the domain apps are served under (`<label>.<domain>`), and,
 * for Cloud Run, where (`cloudrun`: its project and region; its Artifact
 * Registry repository, source bucket and the service account apps run as
 * default to names made from the project).
 *
 * ```ts
 * resources: { apps: { host: "cloudrun", cloudrun: { project: "cz-apps", region: "us-central1" } } }
 * ```
 */
import type { Resources } from "../../../../runtime/mod.ts";

export type CloudRunSettings = {
  project: string;
  region: string;
  /** Artifact Registry's Docker repository images go to (`cz-apps`). */
  repository?: string;
  /** The bucket sources are uploaded to (`<project>-cz-apps`). */
  bucket?: string;
  /** What apps run as (`cz-apps@<project>.iam.gserviceaccount.com`): a service account allowed nothing. */
  serviceAccount?: string;
  /**
   * What builds run as (`cz-build@<project>.iam.gserviceaccount.com`): a
   * build runs the app's own Dockerfile, so its service account may only push
   * to the repository, read the sources and write logs; never the project's
   * default one, which may do much more.
   */
  buildServiceAccount?: string;
};

export type AppsSettings = {
  /** An `appHost` adapter's name: `local`, `cloudrun`, or one of the app's own. */
  host?: string;
  domain?: string;
  cloudrun?: CloudRunSettings;
};

export const DEFAULTS = { host: "local", domain: "copilotz.app" };

/** The settings, each with its default. */
export type Settings = {
  host: string;
  domain: string;
  cloudrun?: Required<CloudRunSettings>;
};

export function settingsOf(ctx: { resources: Resources }): Settings {
  const set = (ctx.resources.apps ?? {}) as AppsSettings;
  const run = set.cloudrun;
  return {
    host: set.host ?? DEFAULTS.host,
    domain: (set.domain ?? DEFAULTS.domain).replace(/^\.+|\.+$/g, "").toLowerCase(),
    ...(run?.project
      ? {
        cloudrun: {
          project: run.project,
          region: run.region,
          repository: run.repository ?? "cz-apps",
          bucket: run.bucket ?? `${run.project}-cz-apps`,
          serviceAccount: run.serviceAccount ?? `cz-apps@${run.project}.iam.gserviceaccount.com`,
          buildServiceAccount: run.buildServiceAccount ??
            `cz-build@${run.project}.iam.gserviceaccount.com`,
        },
      }
      : {}),
  };
}
