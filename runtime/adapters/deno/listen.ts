import {
  attachOwnedListenerSync,
  ownedHypervisor,
} from "../../application/hosting.ts";
import { serve } from "../../../dependencies/oxian-deno.ts";
import {
  createHypervisor,
  type Hypervisor,
  type HypervisorListener,
} from "../../../dependencies/oxian-hypervisor.ts";

export type ListenCopilotzOptions = Readonly<{
  hostname?: string;
  port?: number;
  signal?: AbortSignal;
}>;
export type FetchCapableHost = Readonly<{
  fetch?: (request: Request) => Promise<Response>;
  hypervisor?: Hypervisor;
}>;

/** Oxian owns portable route upgrades and listener-scoped socket draining. */
export function listen(
  gateway: FetchCapableHost,
  options: ListenCopilotzOptions = {},
): HypervisorListener {
  const owned = ownedHypervisor(gateway) ?? gateway.hypervisor;
  if (!owned && !gateway.fetch) {
    throw new TypeError("Copilotz listener requires a Fetch-capable host.");
  }
  const hypervisor = owned ?? createHypervisor({
    transports: [{
      type: "in-process",
      config: { topic: crypto.randomUUID() },
    }],
    fallback: gateway.fetch,
  });
  const listener = serve({ hypervisor, ...options });
  return attachOwnedListenerSync(gateway, {
    ...listener,
    async shutdown() {
      await listener.shutdown();
      if (!owned) await hypervisor.shutdown();
    },
  });
}
