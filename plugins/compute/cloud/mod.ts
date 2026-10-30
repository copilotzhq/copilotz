/**
 * Cloud computers (see design/cloud-computers.md): computers the app hosts
 * for its people, made from a pool of VMs and a disk each. A cloud computer
 * is a computers-plugin computer (its record, its desks, its work, shared
 * into spaces like any) whose machine is a disk: a VM from a pool serves it
 * for one wake, then goes.
 *
 * - **Making one:** `cloud.create` `{ size, in?, name? }` (the org's owners
 *   and admins, or its members when the settings say) makes its computer
 *   record and secret (`computer.provision`) and its disk.
 * - **Waking:** work for one that's asleep wakes it first: the computers
 *   plugin calls `cloud.wake` through the `computerWake` resource, and
 *   `cloud.touch` with every piece of work. A free VM is taken, its disk
 *   attached, and the VM, a `pool` worker running the computer program in
 *   pool mode, serves it (`pool.assign`): it connects as the computer.
 * - **Sleeping:** each minute (`cloud.tick`) computers unused for
 *   `warmMinutes` are released (`cloud.release`: the VM is deleted), awake
 *   ones are metered, the pools are sized, and stale VMs cleaned up. Each
 *   day (`cloud.daily`) storage is metered, and computers unused for
 *   `coldDays` go cold (a snapshot).
 * - **Destroying:** `cloud.destroy` (its owner, or the org's admins).
 * - **Reading:** `cloudComputer.mine` (yours), `cloudComputer.sizes` (what
 *   people choose from, priced with `usage.quote`), `cloud.org` (the org's,
 *   for its admins).
 * - **The host** is an adapter (`adapters.cloudHost.<name>`, named by the
 *   settings' `host`), made per placement account (see `CloudHostAdapter`):
 *   `local` for development and tests (adapters/local.ts), `gce` (Compute
 *   Engine, adapters/gce) for production.
 * - **Metering** (meter `computer`): VM seconds as `cloud/<size>`, disk and
 *   snapshot GB-hours as `cloud/disk` and `cloud/snapshot`, priced by the
 *   app's cost and price books (storage's rates per GB-hour: `per: 1`).
 *
 * ```ts
 * plugins: [models, chat, ...access, usage, computers, cloud, {
 *   name: "app",
 *   // Compute Engine as the app's controller (the plugin's own `gce` uses the runtime's account).
 *   adapters: {
 *     cloudHost: {
 *       gce: (account, { resources }) =>
 *         gceHost({
 *           impersonate: account ?? "cz-controller@<project>.iam.gserviceaccount.com",
 *           placements: () => cloudSettings({ resources }).placements,
 *         }),
 *     },
 *   },
 *   resources: {
 *     cloud: { host: "gce", placements: [{ project: "<project>", zone: "us-central1-a" }] },
 *     computers: { url: "https://compass.copilotz.com" },
 *   },
 * }]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { createAction } from "./actions/create.ts";
import { dailyAction } from "./actions/daily.ts";
import { destroyAction } from "./actions/destroy.ts";
import { orgAction } from "./actions/org.ts";
import { poolAdmitAction, poolGoneAction, poolReadyAction } from "./actions/pool.ts";
import { releaseAction } from "./actions/release.ts";
import { tickAction } from "./actions/tick.ts";
import { touchAction } from "./actions/touch.ts";
import { wakeAction } from "./actions/wake.ts";
import { gceHost } from "./adapters/gce/index.ts";
import { localHost } from "./adapters/local.ts";
import { cloudComputer } from "./collections/cloud-computer.ts";
import { poolVm } from "./collections/pool-vm.ts";
import { type CloudHostAdapter, POOL, POOL_KIND } from "./contract.ts";
import { personOf } from "./shared/people.ts";
import { DEFAULTS, settingsOf } from "./shared/settings.ts";

export * from "./contract.ts";
export {
  createLocalHost,
  localHost,
  type LocalHostOptions,
  type LocalLaunch,
} from "./adapters/local.ts";
export type { Offered } from "./collections/cloud-computer.ts";
export type { CloudSettings, Floor } from "./shared/settings.ts";
/** The `cloud` settings as the app patched them (for a host adapter made from them: its placements). */
export { settingsOf as cloudSettings } from "./shared/settings.ts";

export const cloud: Plugin = definePlugin({
  name: "cloud",
  requires: ["computers"],
  collections: { cloudComputer, poolVm },
  workers: {
    [POOL_KIND]: {
      admit: "cloud.pool.admit",
      ready: "cloud.pool.ready",
      gone: "cloud.pool.gone",
      workloads: Object.values(POOL),
    },
  },
  actions: {
    "cloud.create": createAction,
    "cloud.wake": wakeAction,
    "cloud.release": releaseAction,
    "cloud.destroy": destroyAction,
    "cloud.touch": touchAction,
    "cloud.org": orgAction,
    "cloud.tick": tickAction,
    "cloud.daily": dailyAction,
    "cloud.pool.admit": poolAdmitAction,
    "cloud.pool.ready": poolReadyAction,
    "cloud.pool.gone": poolGoneAction,
  },
  schedules: {
    "cloud.tick": { every: "1m", call: "cloud.tick", input: {}, retries: 0 },
    "cloud.daily": { cron: "30 3 * * *", call: "cloud.daily", input: {} },
  },
  resources: {
    cloud: DEFAULTS,
    // Work for a computer that's asleep wakes it; every piece of work keeps it warm.
    computerWake: { wake: "cloud.wake", touch: "cloud.touch" },
  },
  adapters: {
    cloudHost: {
      local: localHost(),
      // Compute Engine, as the runtime's own Google account (or a placement's account, a service
      // account it impersonates), its VMs verified against the settings' placements for that
      // account. An app impersonating its controller replaces it (see the module's doc).
      gce: (account, { resources }) =>
        gceHost({
          ...(account ? { impersonate: account } : {}),
          placements: () =>
            settingsOf({ resources }).placements.filter((p) =>
              (p.account ?? "") === (account ?? "")
            ),
        }),
    } satisfies Record<string, CloudHostAdapter>,
  },
  // Each person reaches their own cloud computers; pool VMs, only the system.
  guard: (actor, { collection }) => {
    if (collection === "poolVm") return { _id: { $in: [] } };
    if (collection !== "cloudComputer") return undefined;
    const person = personOf(actor);
    return person ? { owner: person } : { owner: { $in: [] } };
  },
});

export default cloud;
