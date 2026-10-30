/**
 * Cloud computers (see design/cloud-computers.md): computers the app hosts
 * for its people, made from a pool of VMs and a disk each. A cloud computer
 * is a computers-plugin computer (its record, its desks, its work, shared
 * into spaces like any) whose machine is a disk: a VM from a pool serves it
 * for one wake, then goes. Two plugins (see contract.ts):
 *
 * **`cloud`**, where the computers are:
 *
 * - **Making one:** `cloud.create` `{ size, in?, name? }` (the org's owners
 *   and admins, or its members when the settings say) makes its computer
 *   record and secret (`computer.provision`) and its disk.
 * - **Waking:** work for one that's asleep wakes it first: the computers
 *   plugin calls `cloud.wake` through the `computerWake` resource, and
 *   `cloud.touch` with every piece of work. The pool gives it a VM
 *   (`pool.take`), its disk is attached, and the VM, a `pool` worker running
 *   the computer program in pool mode, serves it (`pool.serve`): it connects
 *   as the computer, at the app's address for it (its org's).
 * - **Sleeping:** each minute (`cloud.tick`) computers unused for
 *   `warmMinutes` are released (`cloud.release`: the VM is deleted), awake
 *   ones are metered, and the VMs it has are renewed (`pool.renew`). Each
 *   day (`cloud.daily`) storage is metered, and computers unused for
 *   `coldDays` go cold (a snapshot).
 * - **Destroying:** `cloud.destroy` (its owner, or the org's admins).
 * - **Reading:** `cloudComputer.mine` (yours), `cloudComputer.sizes` (what
 *   people choose from, priced with `usage.quote`, with the warm and view
 *   minutes, and whether the asker may make one now: `create`, `why` not),
 *   `cloud.may` (just that), `cloud.org` (the org's, for its admins). Each
 *   computer's state is on its desks too (`computer.mark`, as it changes), so
 *   a space's members see how anyone's shared into it is.
 * - **Metering** (meter `computer`): VM seconds as `cloud/<size>`, disk and
 *   snapshot GB-hours as `cloud/disk` and `cloud/snapshot`, priced by the
 *   app's cost and price books (storage's rates per GB-hour: `per: 1`).
 *
 * **`cloudPool`**, where pool VMs connect (the app's one runtime; in an app
 * of many orgs, the directory's): the pools' VMs, their admission, the pool
 * Actions (`pool.take`, `pool.serve`, `pool.stop`, `pool.drop`,
 * `pool.renew`), and each minute (`pool.tick`) the pools sized and VMs whose
 * lease ran out deleted. In an app of many orgs, each org's runtime has
 * `remotePool(call, org)` in its place: the same Actions, forwarded to the
 * pool's runtime.
 *
 * Both drive the cloud through a host adapter (`adapters.cloudHost.<name>`,
 * named by the `cloud` settings' `host`), made per placement account (see
 * `CloudHostAdapter`): `local` for development and tests (adapters/local.ts),
 * `gce` (Compute Engine, adapters/gce) for production.
 *
 * ```ts
 * // One runtime: both.
 * plugins: [models, chat, ...access, usage, computers, cloud, cloudPool, {
 *   name: "app",
 *   // Compute Engine as the app's controller (the plugins' own `gce` uses the runtime's account).
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
 * // Many orgs: the pool in the directory's runtime (its own socket for pool VMs, and the
 * // `cloud` settings with an `audience`), and in each org's:
 * plugins: [...orgPlugins, cloud, remotePool((action, input) => directory.call(action, input), org.id)]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { createAction } from "./actions/create.ts";
import { dailyAction } from "./actions/daily.ts";
import { destroyAction } from "./actions/destroy.ts";
import { mayAction } from "./actions/may.ts";
import { orgAction } from "./actions/org.ts";
import { poolAdmitAction, poolGoneAction, poolReadyAction } from "./actions/pool.ts";
import { poolTickAction } from "./actions/pool-tick.ts";
import { type PoolCall, remoteActions } from "./actions/remote.ts";
import { releaseAction } from "./actions/release.ts";
import { tickAction } from "./actions/tick.ts";
import { touchAction } from "./actions/touch.ts";
import { dropAction, renewAction, serveAction, stopAction, takeAction } from "./actions/vms.ts";
import { wakeAction } from "./actions/wake.ts";
import { gceHost } from "./adapters/gce/index.ts";
import { localHost } from "./adapters/local.ts";
import { cloudComputer } from "./collections/cloud-computer.ts";
import { markProcessor } from "./processors/mark.ts";
import { poolVm } from "./collections/pool-vm.ts";
import { type CloudHostAdapter, POOL, POOL_ACTIONS, POOL_KIND } from "./contract.ts";
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
export type { PoolCall } from "./actions/remote.ts";
export type { CloudSettings, Floor } from "./shared/settings.ts";
/** The `cloud` settings as the app patched them (for a host adapter made from them: its placements). */
export { settingsOf as cloudSettings } from "./shared/settings.ts";

/**
 * The cloud hosts both plugins drive: the local one, and Compute Engine, as
 * the runtime's own Google account (or a placement's account, a service
 * account it impersonates), its VMs verified against the settings'
 * placements for that account. An app impersonating its controller replaces
 * it (see the module's doc).
 */
const hosts = {
  local: localHost(),
  gce: (account, { resources }) =>
    gceHost({
      ...(account ? { impersonate: account } : {}),
      placements: () =>
        settingsOf({ resources }).placements.filter((p) => (p.account ?? "") === (account ?? "")),
    }),
} satisfies Record<string, CloudHostAdapter>;

/** Cloud computers, where they are (each org's runtime): see the module's doc. */
export const cloud: Plugin = definePlugin({
  name: "cloud",
  requires: ["computers"],
  collections: { cloudComputer },
  actions: {
    "cloud.create": createAction,
    "cloud.wake": wakeAction,
    "cloud.release": releaseAction,
    "cloud.destroy": destroyAction,
    "cloud.touch": touchAction,
    "cloud.org": orgAction,
    "cloud.may": mayAction,
    "cloud.tick": tickAction,
    "cloud.daily": dailyAction,
  },
  // Its desks show how it is, to everyone in their spaces.
  processors: { "cloud.mark": markProcessor },
  schedules: {
    "cloud.tick": { every: "1m", call: "cloud.tick", input: {}, retries: 0 },
    "cloud.daily": { cron: "30 3 * * *", call: "cloud.daily", input: {} },
  },
  resources: {
    cloud: DEFAULTS,
    // Work for a computer that's asleep wakes it; every piece of work keeps it warm.
    computerWake: { wake: "cloud.wake", touch: "cloud.touch" },
  },
  adapters: { cloudHost: hosts },
  // Each person reaches their own cloud computers.
  guard: (actor, { collection }) => {
    if (collection !== "cloudComputer") return undefined;
    const person = personOf(actor);
    return person ? { owner: person } : { owner: { $in: [] } };
  },
});

/** The pools of VMs cloud computers wake on, where pool VMs connect: see the module's doc. */
export const cloudPool: Plugin = definePlugin({
  name: "cloud-pool",
  collections: { poolVm },
  workers: {
    [POOL_KIND]: {
      admit: "pool.admit",
      ready: "pool.ready",
      gone: "pool.gone",
      workloads: Object.values(POOL),
    },
  },
  actions: {
    "pool.admit": poolAdmitAction,
    "pool.ready": poolReadyAction,
    "pool.gone": poolGoneAction,
    [POOL_ACTIONS.take]: takeAction,
    [POOL_ACTIONS.serve]: serveAction,
    [POOL_ACTIONS.stop]: stopAction,
    [POOL_ACTIONS.drop]: dropAction,
    [POOL_ACTIONS.renew]: renewAction,
    [POOL_ACTIONS.tick]: poolTickAction,
  },
  schedules: {
    [POOL_ACTIONS.tick]: { every: "1m", call: POOL_ACTIONS.tick, input: {}, retries: 0 },
  },
  // Its settings are `cloud`'s (the defaults fill in what an app doesn't say): declared empty,
  // so it patches nothing an app said before it.
  resources: { cloud: {} },
  adapters: { cloudHost: hosts },
  // Pool VMs: only the system.
  guard: (_actor, { collection }) => collection === "poolVm" ? { _id: { $in: [] } } : undefined,
});

/**
 * The pool's Actions, forwarded to the runtime that has `cloudPool` (`call`:
 * an Action of it, by name), for `org`: in an app of many orgs, each org's
 * runtime has this beside `cloud`.
 *
 * ```ts
 * remotePool((action, input) => directory.call(action, input), org.id)
 * ```
 */
export function remotePool(call: PoolCall, org?: string): Plugin {
  return definePlugin({ name: "cloud-pool-remote", actions: remoteActions(call, org) });
}

export default cloud;
