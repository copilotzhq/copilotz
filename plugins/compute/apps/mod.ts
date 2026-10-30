/**
 * Apps: what a job on a space's computer serves, published as an app that
 * runs on its own, without the computer (see design/cloud-computers.md,
 * "Apps"), at `https://<label>.copilotz.app`.
 *
 * - **Publishing** (`app.publish`, for a person; the `publish` tool, for an
 *   agent, once its person says yes): the space's folder (or a folder in
 *   it) is sent by its computer as an archive, built into an image (its
 *   Dockerfile, else buildpacks running the job's command) and deployed as
 *   a service that scales to zero. It answers at once, building; the
 *   scheduler builds it right after (`app.build`), and the app goes live,
 *   or fails saying why. Publishing the same name in a space again, or
 *   `app.redeploy`, is a new revision. `app.remove` takes it down.
 * - **Addresses:** each app has a label, from its name and unique, and the
 *   directory routes its host to the app's service (`target`), which the
 *   front (the Cloudflare worker) asks about (see shared/claims.ts).
 * - **Records:** collection `app`, in its space: its members read it
 *   (`app.list`, query `app.here`).
 * - **Metering** (with the billing plugin): each build's minutes, and,
 *   daily (`app.meter`), what each live app ran, as its host tells it.
 * - **Hosts** are `appHost` adapters (see contract.ts, `AppHost`), chosen
 *   by the `apps` settings' `host`: Cloud Run (adapters/cloudrun.ts), or a
 *   local one for development and tests (adapters/local.ts).
 *
 * ```ts
 * plugins: [models, chat, ...access, computers, usage, apps, definePlugin({
 *   name: "my-apps",
 *   resources: { apps: { host: "cloudrun", cloudrun: { project: "my-apps", region: "us-central1" } } },
 *   adapters: { appHost: { cloudrun: cloudRun({ token }) } },
 * })],
 * resources: { agents: { assistant: { tools: ["terminal", "start_job", "publish"] } } }
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { buildAction } from "./actions/build.ts";
import { listAction } from "./actions/list.ts";
import { meterAction } from "./actions/meter.ts";
import { publishAction } from "./actions/publish.ts";
import { redeployAction } from "./actions/redeploy.ts";
import { removeAction } from "./actions/remove.ts";
import { app } from "./collections/app.ts";
import { tools } from "./resources/tools.ts";
import { DEFAULTS } from "./shared/settings.ts";

export type { App, AppHost } from "./contract.ts";
export { APP_SUBJECTS } from "./contract.ts";
export type { AppDoc, Revision } from "./collections/app.ts";
export type { AppHostAdapter } from "./shared/host.ts";
export type { HostClaims } from "./shared/claims.ts";
export type { AppsSettings, CloudRunSettings, Settings } from "./shared/settings.ts";

export const apps: Plugin = definePlugin({
  name: "apps",
  requires: ["computers", "spaces"],
  collections: { app },
  actions: {
    "app.publish": publishAction,
    "app.list": listAction,
    "app.remove": removeAction,
    "app.redeploy": redeployAction,
    "app.build": buildAction,
    "app.meter": meterAction,
  },
  schedules: { "app.meter": { cron: "20 0 * * *", call: "app.meter", input: {} } },
  resources: {
    tools,
    apps: DEFAULTS,
    // A space's members see its apps.
    shared: { app: { field: "space" } },
  },
});

export default apps;
