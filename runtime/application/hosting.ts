import type {
  Hypervisor,
  HypervisorListener,
} from "../../dependencies/oxian-hypervisor.ts";

type Hosted = Readonly<{ close(reason?: string): Promise<void> }>;
type Binding = {
  hypervisor: Hypervisor;
  closed: boolean;
  listeners: Set<HypervisorListener>;
};
const owned = new WeakMap<object, Binding>();

/** Internal association only: public handles never expose transport authority. */
export function withOwnedHosting<T extends Hosted>(
  host: T,
  hypervisor: Hypervisor | undefined,
): T {
  if (!hypervisor) return host;
  const binding: Binding = { hypervisor, closed: false, listeners: new Set() };
  let closing: Promise<void> | undefined;
  const result = {
    ...host,
    close(reason?: string): Promise<void> {
      if (closing) return closing;
      binding.closed = true;
      closing = (async () => {
        const results = await Promise.allSettled([
          ...[...binding.listeners].map((listener) => listener.shutdown()),
          host.close(reason),
        ]);
        const failures = results.flatMap((entry) =>
          entry.status === "rejected" ? [entry.reason] : []
        );
        if (failures.length) {
          throw new AggregateError(failures, "Copilotz host shutdown failed.");
        }
      })();
      return closing;
    },
  };
  owned.set(result, binding);
  return result;
}

export function ownedHypervisor(host: object): Hypervisor | undefined {
  const binding = owned.get(host);
  if (binding?.closed) throw new TypeError("Copilotz host is closed.");
  return binding?.hypervisor;
}

/** Also closes a listener whose asynchronous startup raced application close. */
export async function attachOwnedListener(
  host: object,
  listener: HypervisorListener,
): Promise<HypervisorListener> {
  const binding = owned.get(host);
  if (!binding) return listener;
  if (binding.closed) {
    await listener.shutdown();
    throw new TypeError("Copilotz host is closed.");
  }
  binding.listeners.add(listener);
  void listener.finished.finally(() => binding.listeners.delete(listener))
    .catch(
      () => undefined,
    );
  return listener;
}

/** Synchronous adapter variant; closed state cannot change during this call. */
export function attachOwnedListenerSync(
  host: object,
  listener: HypervisorListener,
): HypervisorListener {
  const binding = owned.get(host);
  if (!binding) return listener;
  if (binding.closed) {
    void listener.shutdown();
    throw new TypeError("Copilotz host is closed.");
  }
  binding.listeners.add(listener);
  void listener.finished.finally(() => binding.listeners.delete(listener))
    .catch(
      () => undefined,
    );
  return listener;
}
