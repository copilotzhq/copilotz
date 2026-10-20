import type { DeviceSocket } from "./device.ts";

/** Native host upgrade used by the public factory and the server facade. */
export type DeviceUpgrade = (request: Request) => {
  socket: DeviceSocket;
  response: Response;
  /** Absolute host request deadline in epoch milliseconds. */
  requestDeadline?: number;
};

// Request identity keeps simultaneous runtimes/listeners isolated. Only the
// facade selects a device route; adapters do not duplicate its routing policy.
const upgrades = new WeakMap<Request, {
  select: () => DeviceUpgrade;
  track?: (socket: DeviceSocket) => void;
}>();
export function provideDeviceUpgrade(
  request: Request,
  select: () => DeviceUpgrade,
  track?: (socket: DeviceSocket) => void,
): void {
  upgrades.set(request, { select, track });
}
export function hostedDeviceUpgrade(
  request: Request,
): DeviceUpgrade | undefined {
  return upgrades.get(request)?.select();
}

export function trackHostedDeviceSocket(
  request: Request,
  socket: DeviceSocket,
): void {
  upgrades.get(request)?.track?.(socket);
}
