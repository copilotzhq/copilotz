/** Shared owner push and indexed selection repair. Payloads remain in the catalog. */
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
  readonly error?: Error;
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
  let scanning: Promise<void> | undefined;
  let headSeq: string | undefined;
  let resetError: Error | undefined;
  let queued = false;
  const requestScan = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void scan([]).catch(() => {
        for (const [key, entry] of entries) {
          dirty.add(key);
          entry.reads.clear();
          for (const listener of [...entry.listeners]) listener();
        }
      });
    });
  };
  const remove = await catalog.onChange((_id, detail) => {
    if (detail.kind === "reset") {
      resetError = Object.assign(
        new Error("Owner push reset; replay from the applied checkpoint."),
        { code: "observation_reset_required" },
      );
      for (const entry of entries.values()) {
        for (const listener of [...entry.listeners]) {
          listener();
        }
      }
      return;
    }
    if (
      (detail.headSeq !== undefined && headSeq !== undefined &&
        BigInt(detail.headSeq) > BigInt(headSeq) + 1n) ||
      (detail.kind === "heartbeat" && headSeq !== undefined &&
        detail.headSeq !== headSeq)
    ) {
      for (const key of entries.keys()) dirty.add(key);
    } else {for (const key of detail.selectionKeys) {
        if (entries.has(key)) dirty.add(key);
      }}
    if (
      detail.headSeq !== undefined &&
      (headSeq === undefined || BigInt(detail.headSeq) > BigInt(headSeq))
    ) headSeq = detail.headSeq;
    if (dirty.size) requestScan();
  }, { namespace });
  const scan = async (keys: readonly string[]) => {
    if (resetError) throw resetError;
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
  const hub: Hub = {
    closed: false,
    get error() {
      return resetError;
    },
    entries,
    dirty,
    scan,
    close() {
      hub.closed = true;
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
  void hub.scan([selectionKey]).catch(() => changed());
  let closed = false;
  return {
    /** Force a head check before forwarding an operation's terminal boundary. */
    refresh: () => hub.scan([selectionKey]),
    read(after: string): Promise<readonly OperationSelectionChange[]> {
      if (hub.error) return Promise.reject(hub.error);
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
