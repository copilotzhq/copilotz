import { withDeviceUpgrades } from "./device-upgrade.ts";
import { serve } from "../../../dependencies/oxian-node.ts";
import type {
  Hypervisor,
  HypervisorListener,
} from "../../../dependencies/oxian-hypervisor.ts";
import {
  attachOwnedListener,
  ownedHypervisor,
} from "../../application/hosting.ts";

export type ListenCopilotzOptions = Readonly<{
  hostname?: string;
  port?: number;
  signal?: AbortSignal;
}>;

/** Starts HTTP, device and worker WebSocket hosting for an owner application. */
export async function listen(
  application: object & Readonly<{ hypervisor?: Hypervisor }>,
  options: ListenCopilotzOptions = {},
): Promise<HypervisorListener> {
  const hypervisor = ownedHypervisor(application) ?? application.hypervisor;
  if (!hypervisor) {
    throw new TypeError(
      "Copilotz Node listener requires an owner application or Hypervisor.",
    );
  }
  const listener = await serve({
    hypervisor: withDeviceUpgrades(hypervisor),
    ...options,
  });
  return await attachOwnedListener(application, listener);
}
