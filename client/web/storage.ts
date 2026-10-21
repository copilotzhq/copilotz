import type { StorageAdapter } from "./types.ts";
import type { Row } from "./reads.ts";
import {
  type ViewReference,
  type ViewShows,
  viewShowsKey,
} from "../../runtime/views/definition.ts";
/** Ports are injected so importing core never touches browser globals. */
export function localStorageAdapter(
  storage: Pick<Storage, "getItem" | "setItem">,
  prefix = "copilotz:",
): StorageAdapter {
  return {
    load(key) {
      const value = storage.getItem(prefix + key);
      return value === null ? undefined : JSON.parse(value);
    },
    save(key, rows) {
      storage.setItem(prefix + key, JSON.stringify(rows));
    },
  };
}

/** A reference admitted from URL state; the runtime checks its View's `url` before rendering. */
export type UrlReference<T = unknown> =
  & ViewReference<T>
  & Readonly<{
    origin: "url";
  }>;
const isUrlScalar = (value: unknown) =>
  value === null || typeof value === "string" || typeof value === "boolean" ||
  typeof value === "number" && Number.isFinite(value);
/** Identifiers and plain navigation scalars: a scalar or a flat plain record of them. */
function isUrlValue(value: unknown): boolean {
  return isUrlScalar(value) ||
    !!value && typeof value === "object" && !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Object.values(value).every(isUrlScalar);
}
/**
 * Admit a reference decoded from a URL. Its value must be identifiers and plain
 * scalars (record IDs, a tab, a page); a record payload, a nested value or an
 * invalid `shows` is refused as null. The result is marked `origin: "url"`, so
 * the browser runtime renders it only with a View that declares `url`.
 */
export function urlReference(candidate: unknown): UrlReference | null {
  if (!candidate || typeof candidate !== "object") return null;
  const { shows, value = null } = candidate as {
    shows?: unknown;
    value?: unknown;
  };
  try {
    viewShowsKey(shows as ViewShows);
  } catch {
    return null;
  }
  if (!isUrlValue(value)) return null;
  return {
    shows: typeof shows === "string" ? shows : { ...shows as object },
    value: value && typeof value === "object" ? { ...value } : value,
    origin: "url",
  } as UrlReference;
}
/** Collection rows in URL state: flat records of plain scalars with an `id`. */
function isUrlRows(rows: unknown): rows is readonly Row[] {
  return Array.isArray(rows) &&
    rows.every((row) =>
      row && typeof row === "object" && typeof row.id === "string" &&
      isUrlValue(row)
    );
}
/**
 * Small navigation state in the URL, such as a selected ID, tab or page. Rows
 * are flat records of plain scalars; records are never carried in a URL, so
 * Views read them again through their Collections. A malformed or non-scalar
 * parameter restores as absent, and saving a nested row is refused.
 */
export function urlStorageAdapter(
  host: {
    read(): URL;
    replace(url: URL): void;
    events?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  },
  parameter = "workspace",
): StorageAdapter {
  return {
    ...(host.events
      ? {
        subscribe(listener: () => void) {
          host.events!.addEventListener("popstate", listener);
          return () => host.events!.removeEventListener("popstate", listener);
        },
      }
      : {}),
    load(key) {
      const value = host.read().searchParams.get(`${parameter}.${key}`);
      if (value === null) return undefined;
      try {
        const rows: unknown = JSON.parse(value);
        return isUrlRows(rows) ? rows : undefined;
      } catch {
        return undefined;
      }
    },
    save(key, rows) {
      if (!isUrlRows(rows)) {
        throw new TypeError(
          `URL storage carries flat scalar rows only; '${key}' has nested values`,
        );
      }
      const url = new URL(host.read());
      url.searchParams.set(`${parameter}.${key}`, JSON.stringify(rows));
      host.replace(url);
    },
  };
}
