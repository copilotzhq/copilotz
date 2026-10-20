import {
  createHypervisor,
  type Hypervisor,
  type HypervisorListener,
} from "../../dependencies/oxian-hypervisor.ts";

type Hosted = Readonly<
  {
    close(reason?: string): Promise<void>;
    fetch?: (request: Request) => Promise<Response>;
  }
>;
type Binding = {
  hypervisor?: Hypervisor;
  fetch?: Hosted["fetch"];
  closed: boolean;
  listeners: Set<HypervisorListener>;
};
const hosting = Symbol("owned-hosting");
const bindingOf = (host: object): Binding | undefined =>
  (host as { [hosting]?: Binding })[hosting];

/** Internal association only: public handles never expose transport authority. */
export function withOwnedHosting<T extends Hosted>(
  host: T,
  hypervisor: Hypervisor | undefined,
): T {
  const binding: Binding = {
    hypervisor,
    fetch: host.fetch,
    closed: false,
    listeners: new Set(),
  };
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
          !hypervisor ? binding.hypervisor?.shutdown(reason) : undefined,
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
  Object.defineProperty(result, hosting, { value: binding });
  return result;
}

export function ownedHypervisor(host: object): Hypervisor | undefined {
  const binding = bindingOf(host);
  if (binding?.closed) throw new TypeError("Copilotz host is closed.");
  if (binding?.fetch) {
    binding.hypervisor ??= createHypervisor({
      transports: [{
        type: "in-process",
        config: { topic: `copilotz.http.${crypto.randomUUID()}` },
      }],
      fallback: binding.fetch,
    });
  }
  return binding?.hypervisor;
}

/** Also closes a listener whose asynchronous startup raced application close. */
export async function attachOwnedListener(
  host: object,
  listener: HypervisorListener,
): Promise<HypervisorListener> {
  if (!attach(host, listener)) {
    await listener.shutdown();
    throw new TypeError("Copilotz host is closed.");
  }
  return listener;
}

/** Synchronous adapter variant; closed state cannot change during this call. */
export function attachOwnedListenerSync(
  host: object,
  listener: HypervisorListener,
): HypervisorListener {
  if (!attach(host, listener)) {
    void listener.shutdown();
    throw new TypeError("Copilotz host is closed.");
  }
  return listener;
}
function attach(host: object, listener: HypervisorListener): boolean {
  const binding = bindingOf(host);
  if (!binding) return true;
  if (binding.closed) return false;
  binding.listeners.add(listener);
  void listener.finished.finally(() => binding.listeners.delete(listener))
    .catch(() => undefined);
  return true;
}
