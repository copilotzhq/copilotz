import type {
  Hypervisor,
  HypervisorRequestDecision,
} from "../../../dependencies/oxian-hypervisor.ts";
import {
  DEVICE_LIMITS,
  type DeviceSocket,
} from "../../subscriptions/device.ts";
import {
  type DeviceUpgrade,
  provideDeviceUpgrade,
} from "../../subscriptions/hosting.ts";

type UpgradeDecision = Extract<HypervisorRequestDecision, { kind: "upgrade" }>;
type Connection = Parameters<UpgradeDecision["attach"]>[0];

/** Bridge only native socket events; the facade remains the device server. */
function pendingUpgrade() {
  const events = new EventTarget();
  const response = new Response(null, { status: 204 });
  let connection: Connection | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false, active = false, bytes = 0;
  const pending: string[] = [];
  const close = (code = 1000, reason = "Device connection closed") => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    pending.length = 0;
    bytes = 0;
    unsubscribe?.();
    connection?.close(code, reason);
    events.dispatchEvent(new Event("close"));
  };
  // Covers asynchronous admission and attachment, before the facade installs
  // its own handshake deadline. Pending messages are also byte/frame bounded.
  const timer = setTimeout(
    () => close(4000, "Device admission timeout"),
    10_000,
  );
  const socket: DeviceSocket = {
    get readyState() {
      return closed ? 3 : connection?.state === "open" ? 1 : 0;
    },
    get bufferedAmount() {
      return connection?.bufferedAmount ?? 0;
    },
    send(data) {
      if (closed || !connection) throw new Error("Device socket is not open");
      if (data instanceof Blob) {
        throw new TypeError("Expected an encoded frame");
      }
      connection.send(
        typeof data === "string"
          ? data
          : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data),
      );
    },
    close,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  const upgrade: DeviceUpgrade = () => {
    if (closed) throw new Error("Device upgrade was cancelled");
    return { socket, response };
  };
  return {
    upgrade,
    close,
    attach(next: Connection) {
      if (closed || connection) {
        next.close(1000, "Device upgrade was cancelled");
        return;
      }
      connection = next;
      unsubscribe = next.subscribe({
        message(data) {
          if (closed) return;
          // Device control frames are JSON text. Refuse binary before buffering.
          if (typeof data !== "string") {
            close(4000, "Invalid device frame");
            return;
          }
          const size = new TextEncoder().encode(data).byteLength;
          if (size > DEVICE_LIMITS.frame) {
            close(4000, "Device frame too large");
            return;
          }
          if (active) {
            events.dispatchEvent(new MessageEvent("message", { data }));
          } else if (
            pending.length >= DEVICE_LIMITS.queuedFrames ||
            bytes + size > DEVICE_LIMITS.queuedBytes
          ) close(4000, "Device admission buffer exceeded");
          else {
            pending.push(data);
            bytes += size;
          }
        },
        close: () => close(),
        error: () => close(4000, "Device transport failed"),
      });
    },
    complete(result: Response) {
      if (closed) return;
      if (result !== response) {
        close(4000, "Device admission refused");
        return;
      }
      clearTimeout(timer);
      active = true;
      for (const data of pending.splice(0)) {
        if (closed) break;
        events.dispatchEvent(new MessageEvent("message", { data }));
      }
      bytes = 0;
    },
  };
}

/** Oxian 0.22 owns the listener, budget, native handshake and worker upgrades. */
export function withDeviceUpgrades(hypervisor: Hypervisor): Hypervisor {
  return {
    ...hypervisor,
    prepare(request) {
      let pending: ReturnType<typeof pendingUpgrade> | undefined;
      provideDeviceUpgrade(request, () => {
        pending ??= pendingUpgrade();
        return pending.upgrade;
      });
      const decision = hypervisor.prepare(request);
      if (!pending) return decision;
      const device = pending;
      if (
        decision.kind !== "response" || request.method !== "GET" ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      ) {
        device.close();
        return decision;
      }
      // prepare() cannot await recovery admission in Oxian 0.22. Native upgrade
      // happens now; no device messages are released until the facade completes.
      void Promise.resolve(decision.response).then(
        (response) => device.complete(response),
        () => device.close(4000, "Device admission refused"),
      );
      return {
        kind: "upgrade",
        protocol: "",
        attach: (connection) => device.attach(connection),
        cancel: () => device.close(),
      };
    },
  };
}
