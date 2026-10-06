/** Shared scoped hints and indexed selection-head scans. Payloads remain in the catalog. */
import type {
  OperationCatalog,
  OperationSelectionChange,
} from "../runtime/streams/catalog.ts";

type Entry = {
  listeners: Set<() => void>;
  head?: string;
  reads: Map<string, Promise<readonly OperationSelectionChange[]>>;
};
type Hub = {
  closed: boolean;
  entries: Map<string, Entry>;
  dirty: Set<string>;
  scan(keys: readonly string[]): Promise<void>;
  close(): void;
};
const catalogs = new WeakMap<OperationCatalog, Map<string, Promise<Hub>>>();

async function createHub(
  catalog: OperationCatalog,
  namespace: string,
): Promise<Hub> {
  const entries = new Map<string, Entry>();
  const dirty = new Set<string>();
  const remove = await catalog.onChange((_id, detail) => {
    for (const key of detail?.selectionKeys ?? []) {
      if (entries.has(key)) dirty.add(key);
    }
  }, { namespace });
  let scanning: Promise<void> | undefined;
  let lastSafety = performance.now();
  const scan = async (keys: readonly string[]) => {
    for (const key of keys) dirty.add(key);
    if (scanning) {
      await scanning;
      if (keys.some((key) => dirty.has(key))) await scan([]);
      return;
    }
    scanning = (async () => {
      const selected = [...dirty];
      for (const key of selected) dirty.delete(key);
      for (let offset = 0; offset < selected.length; offset += 1000) {
        const batch = selected.slice(offset, offset + 1000);
        const heads = new Map(
          (await catalog.getSelectionHeads({ namespace, selectionKeys: batch }))
            .map((head) => [head.selectionKey, head.changeOrdinal]),
        );
        for (const key of batch) {
          const entry = entries.get(key);
          if (!entry) continue;
          const head = heads.get(key) ?? "0";
          if (head === entry.head) continue;
          entry.head = head;
          entry.reads.clear();
          for (const listener of [...entry.listeners]) listener();
        }
      }
    })();
    try {
      await scanning;
    } finally {
      scanning = undefined;
    }
  };
  const timer = setInterval(() => {
    if (scanning) return;
    const safety = performance.now() - lastSafety >= 5000;
    if (safety) lastSafety = performance.now();
    if (safety || dirty.size) {
      void scan(safety ? [...entries.keys()] : []).catch(() => {
        // A failed notification/scan cannot establish absence. Wake each viewer
        // to do an authoritative read, which surfaces database failures.
        for (const [key, entry] of entries) {
          dirty.add(key);
          entry.reads.clear();
          for (const listener of [...entry.listeners]) listener();
        }
      });
    }
  }, 25);
  const hub: Hub = {
    closed: false,
    entries,
    dirty,
    scan,
    close() {
      hub.closed = true;
      clearInterval(timer);
      remove();
    },
  };
  return hub;
}

export async function watchSelection(
  catalog: OperationCatalog,
  namespace: string,
  selectionKey: string,
  changed: () => void,
) {
  let namespaces = catalogs.get(catalog);
  if (!namespaces) catalogs.set(catalog, namespaces = new Map());
  let pending = namespaces.get(namespace);
  if (!pending) {
    pending = createHub(catalog, namespace);
    namespaces.set(namespace, pending);
    const created = pending;
    void created.catch(() => {
      if (namespaces!.get(namespace) === created) {
        namespaces!.delete(namespace);
        if (!namespaces!.size) catalogs.delete(catalog);
      }
    });
  }
  const hub = await pending;
  if (hub.closed) {
    return await watchSelection(catalog, namespace, selectionKey, changed);
  }
  let entry = hub.entries.get(selectionKey);
  if (!entry) {
    entry = { listeners: new Set(), reads: new Map() };
    hub.entries.set(selectionKey, entry);
    hub.dirty.add(selectionKey);
  }
  entry.listeners.add(changed);
  let closed = false;
  return {
    /** Force a head check before forwarding an operation's terminal boundary. */
    refresh: () => hub.scan([selectionKey]),
    read(after: string): Promise<readonly OperationSelectionChange[]> {
      let result = entry!.reads.get(after);
      if (!result) {
        result = catalog.listSelectionChanges({
          namespace,
          selectionKey,
          afterChangeOrdinal: after,
          limit: 32,
        });
        // Distinct reconnect positions may differ; live followers share a page.
        if (entry!.reads.size >= 32) {
          entry!.reads.delete(entry!.reads.keys().next().value!);
        }
        entry!.reads.set(after, result);
        void result.catch(() => entry!.reads.delete(after));
      }
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      entry!.listeners.delete(changed);
      if (!entry!.listeners.size) {
        hub.entries.delete(selectionKey);
        hub.dirty.delete(selectionKey);
      }
      if (!hub.entries.size) {
        hub.close();
        namespaces!.delete(namespace);
        if (!namespaces!.size) catalogs.delete(catalog);
      }
    },
  };
}
