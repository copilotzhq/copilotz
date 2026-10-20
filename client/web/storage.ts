import type { StorageAdapter } from "./types.ts";
import type { Row } from "./live.ts";
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
export function urlStorageAdapter(
  host: { read(): URL; replace(url: URL): void },
  parameter = "workspace",
): StorageAdapter {
  return {
    load(key) {
      const value = host.read().searchParams.get(`${parameter}.${key}`);
      return value === null ? undefined : JSON.parse(value) as readonly Row[];
    },
    save(key, rows) {
      const url = new URL(host.read());
      url.searchParams.set(`${parameter}.${key}`, JSON.stringify(rows));
      host.replace(url);
    },
  };
}
