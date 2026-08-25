export * from "@oxian/oxian-js/hypervisor";
import type { createHypervisor } from "@oxian/oxian-js/hypervisor";

export type HypervisorLifecycleCallbacks = Parameters<
  typeof createHypervisor
>[1];
export type HypervisorTransport = Parameters<
  typeof createHypervisor
>[0]["transports"][number];
