export * from "jsr:@oxian/oxian-js@0.21.0-rc.4/hypervisor";
import type { createHypervisor } from "jsr:@oxian/oxian-js@0.21.0-rc.4/hypervisor";

export type HypervisorLifecycleCallbacks = Parameters<
  typeof createHypervisor
>[1];
export type HypervisorTransport = Parameters<
  typeof createHypervisor
>[0]["transports"][number];
