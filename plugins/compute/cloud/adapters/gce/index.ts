/**
 * The Compute Engine host (`cloudHost`'s `gce` adapter): computers' disks,
 * attached to and detached from pool VMs, snapshotted when cold, and the
 * pools themselves, a managed instance group per zone and size. It speaks
 * Compute Engine's REST API with fetch, with a token of its own (the
 * runtime's account, or `impersonate`'s, `cz-controller`), never one global
 * client: an org's own cloud gets an adapter of its own.
 *
 * ```ts
 * adapters: {
 *   cloudHost: {
 *     gce: gceHost({
 *       impersonate: "cz-controller@copilotz-485719.iam.gserviceaccount.com",
 *       placements: [{ project: "copilotz-485719", zone: "us-central1-a" }],
 *     }),
 *   },
 * }
 * ```
 *
 * Every change waits for its operation to finish (tens of seconds, at
 * times: a snapshot is ~90 s a GB), and raises its error. Requests Compute
 * Engine turns away for rate or quota (429, 403 `rateLimitExceeded`) or by
 * a passing failure (5xx) are retried, a few times, backing off; each change
 * carries a `requestId`, so a retried one isn't done twice.
 *
 * Pool VMs prove who they are with an identity token for the app's origin
 * (`pool:gce:<token>`): `verify` takes those from VMs of the app's pools, in
 * its placements, only.
 */
import type { CloudHost, Placement } from "../../contract.ts";
import { type ComputeEngine, googleToken, verifyIdentityToken } from "../../shared/google.ts";

/** How the Compute Engine host is made: its credentials, its pools, its placements. All optional. */
export type GceOptions = {
  /** The service account it acts as (`cz-controller@<project>.iam.gserviceaccount.com`). */
  impersonate?: string;
  /** Its access token, for tests; default the runtime's (or `impersonate`'s). */
  token?: () => Promise<string>;
  /** Compute Engine's API; default `https://compute.googleapis.com/compute/v1`. */
  api?: string;
  /** A size's pool in a placement: its managed instance group; default `cz-pool-<size>`. */
  pools?: (placement: Placement, size: string) => { group: string };
  /** The VMs' network. The pools' templates set it; the disks and pools here don't need it. */
  network?: string;
  /** Where the app's pools are: a VM in another project or zone isn't one of them. */
  placements?: Placement[] | (() => Placement[] | Promise<Placement[]>);
  /** What pool VMs' names start with (their groups' base names); default `cz-pool-`. */
  prefix?: string;
  /** Google's keys, to check identity tokens with (a JWKS URL), for tests. */
  certs?: string;
  /** How often a refused request is tried again, and the first wait (ms; it doubles). */
  retries?: number;
  backoff?: number;
  /** How long an operation may take before it's given up on (ms); default 30 minutes. */
  timeout?: number;
  fetch?: typeof fetch;
};

/** Compute Engine's REST API. */
export const COMPUTE = "https://compute.googleapis.com/compute/v1";

/** What a computer's disks and snapshots are labeled with. */
export const LABELS = { app: "copilotz", role: "computer" };

/** An error from Compute Engine: its HTTP status and reason, when it said them. */
export type GceError = Error & { status?: number; reason?: string };

type Operation = {
  name: string;
  status: "PENDING" | "RUNNING" | "DONE";
  zone?: string;
  region?: string;
  operationType?: string;
  targetLink?: string;
  error?: { errors?: { code?: string; message?: string }[] };
  httpErrorStatusCode?: number;
  httpErrorMessage?: string;
};

type Call = { method?: string; query?: Record<string, string>; body?: unknown };

/** A size's pool VMs being taken out or removed aren't free ones. */
const LEAVING = new Set(["ABANDONING", "DELETING"]);

/** The Compute Engine host. */
export function gceHost(options: GceOptions = {}): CloudHost {
  const api = (options.api ?? COMPUTE).replace(/\/$/, "");
  const fetcher = options.fetch ?? fetch;
  const token = options.token ?? googleToken({ impersonate: options.impersonate, fetch: fetcher });
  const poolOf = options.pools ?? ((_: Placement, size: string) => ({ group: `cz-pool-${size}` }));
  const prefix = options.prefix ?? "cz-pool-";
  const retries = options.retries ?? 5;
  const backoff = options.backoff ?? 1000;
  const timeout = options.timeout ?? 30 * 60_000;

  const zonal = ({ project, zone }: Placement) =>
    `/projects/${encodeURIComponent(project)}/zones/${encodeURIComponent(zone)}`;
  const global = ({ project }: Placement) => `/projects/${encodeURIComponent(project)}/global`;
  const segment = encodeURIComponent;

  /** One API call, retried while it's refused for rate or quota, or fails in passing. */
  async function call<T>(path: string, request: Call = {}): Promise<T> {
    const method = request.method ?? (request.body === undefined ? "GET" : "POST");
    const url = new URL(api + path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }
    for (let attempt = 0;; attempt++) {
      const response = await fetcher(url, {
        method,
        headers: {
          authorization: `Bearer ${await token()}`,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      const text = await response.text();
      if (response.ok) return (text ? JSON.parse(text) : {}) as T;
      const error = failure(`${method} ${path}`, response.status, text);
      if (attempt >= retries || !passing(error)) throw error;
      const after = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(after) && after > 0
        ? Math.min(after, 60) * 1000
        : backoff * 2 ** attempt * (0.5 + Math.random() / 2);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  /** A change: its call, then its operation, waited for until it's done (or its error). */
  async function change(placement: Placement, path: string, request: Call): Promise<void> {
    const query = { ...request.query, requestId: crypto.randomUUID() };
    let operation = await call<Operation>(path, { method: "POST", ...request, query });
    const where = operation.zone
      ? `${zonal({ ...placement, zone: last(operation.zone) })}/operations`
      : operation.region
      ? `/projects/${segment(placement.project)}/regions/${
        segment(last(operation.region))
      }/operations`
      : `${global(placement)}/operations`;
    const deadline = Date.now() + timeout;
    while (operation.status !== "DONE") {
      if (Date.now() > deadline) {
        throw new Error(`Compute Engine: ${path} took too long (operation ${operation.name})`);
      }
      // `wait` answers when it's done, or after a while (up to two minutes) in any case.
      operation = await call<Operation>(`${where}/${segment(operation.name)}/wait`, {
        method: "POST",
      });
    }
    const errors = operation.error?.errors ?? [];
    if (errors.length) {
      const said = errors.map((e) => `${e.code}: ${e.message}`).join("; ");
      const error: GceError = new Error(
        `Compute Engine: ${operation.operationType ?? "operation"} ${
          operation.targetLink ? last(operation.targetLink) : path
        } failed: ${said}`,
      );
      error.status = operation.httpErrorStatusCode;
      error.reason = errors[0].code;
      throw error;
    }
  }

  /** A change, where what it changes being gone already is as good as done. */
  async function removal(placement: Placement, path: string, request: Call): Promise<void> {
    try {
      await change(placement, path, request);
    } catch (error) {
      if ((error as GceError).status !== 404) throw error;
    }
  }

  const diskPath = (placement: Placement, disk: string) =>
    `${zonal(placement)}/disks/${segment(disk)}`;
  const diskType = ({ project, zone }: Placement) =>
    `projects/${project}/zones/${zone}/diskTypes/pd-balanced`;
  const group = (placement: Placement, size: string) =>
    `${zonal(placement)}/instanceGroupManagers/${segment(poolOf(placement, size).group)}`;

  const placements = async () =>
    typeof options.placements === "function"
      ? await options.placements()
      : options.placements ?? [];

  return {
    async createDisk(placement, name, gb) {
      await change(placement, `${zonal(placement)}/disks`, {
        body: { name, sizeGb: String(gb), type: diskType(placement), labels: LABELS },
      });
    },

    async deleteDisk(placement, name) {
      await removal(placement, diskPath(placement, name), { method: "DELETE" });
    },

    async snapshot(placement, from, snapshot) {
      await change(placement, `${diskPath(placement, from)}/createSnapshot`, {
        body: { name: snapshot, labels: LABELS, storageLocations: [regionOf(placement.zone)] },
      });
    },

    async restore(placement, snapshot, name, gb) {
      await change(placement, `${zonal(placement)}/disks`, {
        body: {
          name,
          sizeGb: String(gb),
          type: diskType(placement),
          labels: LABELS,
          sourceSnapshot: `projects/${placement.project}/global/snapshots/${snapshot}`,
        },
      });
    },

    async deleteSnapshot(placement, snapshot) {
      await removal(placement, `${global(placement)}/snapshots/${segment(snapshot)}`, {
        method: "DELETE",
      });
    },

    async attach(placement, vm, disk, device) {
      await change(placement, `${zonal(placement)}/instances/${segment(vm)}/attachDisk`, {
        body: {
          source: `projects/${placement.project}/zones/${placement.zone}/disks/${disk}`,
          deviceName: device,
          mode: "READ_WRITE",
          type: "PERSISTENT",
          boot: false,
          autoDelete: false,
        },
      });
    },

    async detach(placement, vm, disk, force) {
      const instance = `${zonal(placement)}/instances/${segment(vm)}`;
      // Detaching goes by the disk's device in the VM: the VM says which it is.
      let disks: { source?: string; deviceName?: string }[];
      try {
        ({ disks = [] } = await call<{ disks?: typeof disks }>(instance));
      } catch (error) {
        if ((error as GceError).status === 404) return; // The VM's gone, and its disks with it.
        throw error;
      }
      const attached = disks.find((d) => d.source && last(d.source) === disk);
      if (!attached?.deviceName) return; // Detached already.
      try {
        await removal(placement, `${instance}/detachDisk`, {
          query: { deviceName: attached.deviceName },
        });
      } catch (error) {
        // By force: a VM that won't let its disk go is deleted, which does (its disks stay).
        if (!force) throw error;
        await removal(placement, instance, { method: "DELETE" });
      }
    },

    async pool(placement, size) {
      const path = group(placement, size);
      const { targetSize = 0 } = await call<{ targetSize?: number }>(path);
      const vms: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await call<{
          managedInstances?: { instance?: string; currentAction?: string }[];
          nextPageToken?: string;
        }>(`${path}/listManagedInstances`, {
          method: "POST",
          query: pageToken ? { pageToken } : {},
        });
        for (const vm of page.managedInstances ?? []) {
          if (vm.instance && !LEAVING.has(vm.currentAction ?? "")) vms.push(last(vm.instance));
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return { target: targetSize, vms };
    },

    async resize(placement, size, target) {
      await change(placement, `${group(placement, size)}/resize`, {
        query: { size: String(target) },
      });
    },

    async take(placement, size, vm) {
      const path = group(placement, size);
      // Abandoning a VM lowers the pool's target by one: the target it had is set again, so
      // the pool makes another, and keeps as many free.
      const { targetSize = 0 } = await call<{ targetSize?: number }>(path);
      await change(placement, `${path}/abandonInstances`, {
        body: { instances: [`zones/${placement.zone}/instances/${vm}`] },
      });
      await change(placement, `${path}/resize`, { query: { size: String(targetSize) } });
    },

    async deleteVm(placement, vm) {
      await removal(placement, `${zonal(placement)}/instances/${segment(vm)}`, {
        method: "DELETE",
      });
    },

    async verify(credential, audience) {
      const jwt = /^(?:pool:)?gce:(.+)$/.exec(credential)?.[1];
      if (!jwt) return null;
      let claims: ComputeEngine;
      try {
        claims = await verifyIdentityToken(jwt, audience, { certs: options.certs, fetch: fetcher });
      } catch {
        return null;
      }
      if (!claims.instance_name.startsWith(prefix)) return null;
      const placement = (await placements()).find((p) =>
        p.project === claims.project_id && p.zone === claims.zone
      );
      return placement ? { vm: claims.instance_name, placement } : null;
    },
  };
}

/** A zone's region: `us-central1-a`'s is `us-central1`. */
export const regionOf = (zone: string): string => zone.replace(/-[a-z]$/, "");

/** A resource URL's last part (its name). */
const last = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/** An error Compute Engine answered with, as an Error: its status, reason and message. */
function failure(what: string, status: number, text: string): GceError {
  let reason: string | undefined;
  let message = text.slice(0, 500);
  try {
    const { error } = JSON.parse(text);
    reason = error?.errors?.[0]?.reason ?? error?.status;
    message = error?.message ?? message;
  } catch {
    // Not JSON: its text says it.
  }
  const error: GceError = new Error(`Compute Engine: ${what}: HTTP ${status} ${message}`);
  error.status = status;
  error.reason = reason;
  return error;
}

/** Whether a refused request is worth trying again: rate and quota limits, passing failures. */
const passing = ({ status, reason }: GceError) =>
  status === 429 || status! >= 500 ||
  (status === 403 && /^(rateLimitExceeded|userRateLimitExceeded)$/.test(reason ?? ""));
