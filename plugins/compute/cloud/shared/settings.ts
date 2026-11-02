/**
 * The cloud plugin's settings (the `cloud` resource), which an app patches
 * field by field (`resources: { cloud: { host: "gce", placements: [...] } }`;
 * a size set to `null` isn't offered):
 *
 * - `host`: the `cloudHost` adapter that drives the cloud (`local` for
 *   development and tests);
 * - `placements`: where disks and VMs go; new computers go in the first;
 * - `sizes`: what people choose from, by id;
 * - `diskGb`: a new computer's disk;
 * - `warmMinutes`: how long a VM stays with a computer after its last use;
 *   `viewMinutes`: how long a person having it open (its terminal, a preview)
 *   keeps it awake past that; `coldDays`: unused this long, its disk becomes
 *   a snapshot;
 * - `pool`: the free VMs to keep (`floor`, by the hour in a time zone, per
 *   size unless it names one; 0 outside its hours) besides those expected,
 *   up to `max` per placement and size;
 * - `approve`: what agents on a cloud computer ask their person before doing
 *   (`terminal`, `jobs`, `writes`), in place of the computers plugin's:
 *   nothing by default (publishing an app is always asked);
 * - `audience`: what pool VMs' identity tokens are for: the app's origin, as
 *   the program asks for it (by default, the origin of the computers plugin's
 *   `url`).
 */
import type { Resources } from "../../../../runtime/mod.ts";
import type { Placement, Size } from "../contract.ts";

/** A pool's floor in some hours: `count` free VMs from `from` to `to` (hours, 0–24, in `tz`). */
export type Floor = {
  from: number;
  to: number;
  /** An IANA time zone (UTC unless given). */
  tz?: string;
  count: number;
  /** Only this size's pool (every size's unless given), only in this zone. */
  size?: string;
  zone?: string;
};

export type CloudSettings = {
  host: string;
  placements: Placement[];
  sizes: Record<string, Size>;
  diskGb: number;
  warmMinutes: number;
  viewMinutes: number;
  coldDays: number;
  pool: { floor: Floor[]; max: number };
  approve: ("terminal" | "jobs" | "writes")[];
  audience?: string;
};

export const DEFAULTS: CloudSettings = {
  host: "local",
  placements: [{ project: "local", zone: "local" }],
  sizes: {
    small: { label: "Small", machine: "e2-medium", vcpu: 2, memory: 4, shared: true },
    // N2, not N4: N4 takes only Hyperdisk, and disks here are pd-balanced.
    standard: { label: "Standard", machine: "n2-standard-2", vcpu: 2, memory: 8 },
  },
  diskGb: 10,
  warmMinutes: 10,
  viewMinutes: 120,
  coldDays: 7,
  pool: { floor: [{ from: 9, to: 21, tz: "America/Sao_Paulo", count: 1, size: "small" }], max: 10 },
  approve: [],
};

/** The settings as the app patched them; sizes it removed (`null`) aren't there. */
export function settingsOf(ctx: { resources: Resources }): CloudSettings {
  const set = { ...DEFAULTS, ...(ctx.resources.cloud ?? {}) } as CloudSettings;
  const sizes = Object.fromEntries(
    Object.entries(set.sizes ?? {}).filter(([, size]) => size && typeof size === "object"),
  );
  return { ...set, sizes, pool: { ...DEFAULTS.pool, ...set.pool } };
}

/** What pool VMs' identity tokens must be for: `audience`, else the origin computers connect to. */
export function audienceOf(ctx: { resources: Resources }): string {
  const set = settingsOf(ctx);
  if (set.audience) return set.audience;
  const url = (ctx.resources.computers as { url?: string } | undefined)?.url;
  try {
    return url ? new URL(url.replace(/^ws/, "http")).origin : "";
  } catch {
    return "";
  }
}

/**
 * The app's address as computers connect to it, as the computers plugin's
 * settings say it: its `url`, plus the org's base in an app of many orgs.
 */
export function appOf(resources: Resources): string | undefined {
  const url = (resources.computers as { url?: string } | undefined)?.url;
  const base = (resources.org as { base?: string } | undefined)?.base ?? "";
  return url ? url.replace(/\/+$/, "") + base : undefined;
}

/** The same placement: its account, project and zone. */
export const samePlace = (a: Placement, b: Placement) =>
  (a.account ?? "") === (b.account ?? "") && a.project === b.project && a.zone === b.zone;

/** A placement as one key, for maps. */
export const placeKey = (p: Placement) => `${p.account ?? ""}/${p.project}/${p.zone}`;
