/**
 * Apps on the web, their logic: an app's address as its name will make it
 * (its label, on the domain apps are served under, which the app's own
 * addresses say), each status as people read it, the app a job was
 * published as, a folder under the space's as it's typed, and a name to
 * start from.
 */
import type { AppDoc } from "../../collections/app.ts";
import { slugOf } from "../../shared/label.ts";

/**
 * A job that serves a port, as computers' `jobActions` Views are given it
 * (their item): the space and its computer, the job, what it goes by and
 * runs, the port it serves (and every one it listens on), and the space's
 * folder on the computer, as it shows.
 */
export type JobServed = {
  in: string;
  computer: string;
  /** The computer's desk in the space, when it's known: what's published comes from it. */
  desk?: string;
  job: string;
  name: string;
  command: string;
  port?: number;
  ports?: number[];
  folder?: string;
};

/** Where apps are served, unless the app's own addresses say otherwise. */
export const DOMAIN = "copilotz.app";

/** The domain apps are served under: from an app's address (`https://<label>.<domain>`), else the default. */
export function domainOf(apps: Pick<AppDoc, "url" | "label">[]): string {
  for (const app of apps) {
    try {
      const { host } = new URL(app.url);
      if (host.startsWith(`${app.label}.`)) return host.slice(app.label.length + 1);
    } catch { /* Not an address. */ }
  }
  return DOMAIN;
}

/** The address a name makes (when it's free; a taken one gets a short suffix), or none for no name. */
export function addressFor(name: string, domain: string): string | undefined {
  const label = name.trim() ? slugOf(name) : "";
  return label ? `https://${label}.${domain}` : undefined;
}

/** An address as it reads: without its scheme or a trailing slash. */
export const shown = (url: string): string => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** A status as people read it: its label, its badge's tone, whether it's on its way. */
export type Look = { label: string; tone: "info" | "success" | "destructive"; busy: boolean };

export function lookOf(app: Pick<AppDoc, "status">): Look {
  if (app.status === "building") return { label: "Building", tone: "info", busy: true };
  if (app.status === "live") return { label: "Live", tone: "success", busy: false };
  return { label: "Failed", tone: "destructive", busy: false };
}

/** The app a job on a computer was published as (the newest), while it's up. */
export const appOfJob = (apps: AppDoc[], job: string, computer: string): AppDoc | undefined =>
  apps.find((a) =>
    a.source.job === job && a.source.computer === computer && a.status !== "removed"
  );

/** A folder under the space's folder, as it's typed: `web/`, `./web` and `/web` are `web`; empty is all of it. */
export function folderOf(typed: string): { path?: string } | { error: string } {
  const path = typed.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (!path || path === ".") return {};
  if (path.split("/").some((part) => part === "..")) {
    return { error: "It has to be a folder inside the space's folder." };
  }
  return { path };
}

/** A name to start from: the job's own name, else its folder's, else "app". */
export function suggestedName(
  job: { name: string; command: string },
  folder?: string,
): string {
  if (job.name && job.name !== job.command) return job.name;
  const last = folder?.split(/[\\/]/).filter(Boolean).pop();
  return last && last !== "~" ? last : "app";
}
