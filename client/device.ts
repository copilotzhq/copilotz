import type { SubscriptionTransport } from "./live-query.ts";
import type { SubscriptionFrame } from "../runtime/subscriptions/types.ts";
import {
  channelIdentity,
  decodeControl,
  DEVICE_LIMITS,
  DEVICE_VERSION,
  type DeviceEnvelope,
  type DeviceSocket,
  encoded,
  protocolError,
  Reassembly,
  SubscriptionQueue,
} from "../runtime/subscriptions/device.ts";

export type DeviceTransportOptions = Readonly<{
  url: string;
  /** Match the facade limit when the host raises its default of 16. */
  maxSubscriptions?: number;
  /** Fresh proof from the HTTP-established session, never retained authority. */
  credentials(): unknown | Promise<unknown>;
  socket?(url: string): DeviceSocket;
}>;
export type DeviceTransport =
  & SubscriptionTransport
  & Readonly<{
    reauthenticate(): Promise<void>;
    close(): void;
  }>;
type Channel = {
  generation: number;
  queue: SubscriptionQueue<SubscriptionFrame>;
  reassembly: Reassembly;
  received?: string;
  applying: boolean;
  fenced?: boolean;
  stop(error?: unknown): void;
};

/** One lazily connected socket, multiplexing independently fenced live reads. */
export function createDeviceTransport(
  options: DeviceTransportOptions,
): DeviceTransport {
  const maxSubscriptions = options.maxSubscriptions ?? DEVICE_LIMITS.channels;
  if (!Number.isSafeInteger(maxSubscriptions) || maxSubscriptions < 1) {
    throw new RangeError("Invalid device subscription limit");
  }
  let socket: DeviceSocket | undefined, connection: Promise<void> | undefined;
  let welcome: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let closed = false;
  let authenticating: Promise<void> | undefined;
  const channels = new Map<string, Channel>();
  const identities = new WeakMap<
    AbortSignal,
    Map<string, { channel: string; generation: number }>
  >();
  const send = (frame: DeviceEnvelope) => {
    const bytes = encoded(frame);
    if (bytes.length > DEVICE_LIMITS.frame) {
      throw protocolError("Device control too large");
    }
    if (!socket || socket.readyState !== 1) {
      throw new Error("Device disconnected");
    }
    socket.send(new TextDecoder().decode(bytes));
  };
  const fail = (error?: unknown) => {
    for (const channel of [...channels.values()]) channel.stop(error);
  };
  const connect = () =>
    connection ??= (async () => {
      if (closed) throw protocolError("Device transport closed");
      const credentials = await options.credentials();
      if (closed) throw protocolError("Device transport closed");
      const current = (options.socket ?? ((url) => new WebSocket(url)))(
        options.url,
      );
      socket = current;
      welcome = Promise.withResolvers<void>();
      const ready = welcome.promise;
      const timeout = setTimeout(() => {
        welcome?.reject(new Error("Device handshake timed out"));
        current.close();
      }, 10_000);
      current.addEventListener("open", () => {
        if (socket !== current) return;
        try {
          send({
            t: "hello",
            version: DEVICE_VERSION,
            capabilities: ["subscriptions"],
            credentials,
          });
        } catch (error) {
          welcome?.reject(error);
          current.close();
        }
      });
      current.addEventListener("message", (event) => {
        if (socket !== current) return;
        let frame: DeviceEnvelope;
        try {
          frame = decodeControl(event.data);
          if (frame.t === "welcome") {
            if (
              frame.version !== DEVICE_VERSION ||
              !Array.isArray(frame.capabilities) ||
              !frame.capabilities.includes("subscriptions")
            ) throw protocolError("Unsupported device version/capabilities");
            welcome?.resolve();
            return;
          }
          if (frame.t === "error" && frame.channel === undefined) {
            throw Object.assign(
              new Error(String(frame.message ?? frame.code)),
              { code: frame.code, retryable: false },
            );
          }
          if (frame.t === "heartbeat") {
            if (
              !Array.isArray(frame.heads) ||
              frame.heads.length > maxSubscriptions
            ) throw protocolError("Invalid heartbeat heads");
            for (const head of frame.heads as DeviceEnvelope[]) {
              const { channel: id, generation } = channelIdentity(head),
                channel = channels.get(id);
              if (
                channel?.generation !== generation || channel.applying ||
                channel.queue.size
              ) continue;
              if (
                head.checkpoint &&
                (head.checkpoint !== channel.received ||
                  channel.reassembly.incomplete)
              ) channel.stop(new Error("Device heartbeat head mismatch"));
            }
            return;
          }
          const { channel: id, generation } = channelIdentity(frame),
            channel = channels.get(id);
          if (
            !channel || channel.generation !== generation || channel.fenced
          ) return;
          try {
            if (frame.t === "renew") {
              channel.stop(new Error("Device channel renewed"));
              return;
            }
            if (frame.t === "eof") {
              if (channel.reassembly.incomplete) {
                channel.stop(new Error("Interrupted logical output"));
              } else channel.queue.end();
              return;
            }
            if (frame.t === "error") {
              throw Object.assign(
                new Error(String(frame.message ?? frame.code)),
                { code: frame.code, retryable: frame.retryable },
              );
            }
            const output = frame.t === "reset" || frame.t === "revoked"
              ? frame
              : channel.reassembly.accept(frame);
            if (!output) return;
            if (
              !["snapshot", "batch", "reset", "revoked"].includes(output.t)
            ) throw protocolError("Unexpected device output");
            if (output.t === "snapshot" || output.t === "batch") {
              if (
                typeof output.checkpoint !== "string" || !output.checkpoint ||
                output.checkpoint.length > 16384
              ) throw protocolError("Missing output checkpoint");
              channel.received = output.checkpoint;
            }
            if (output.t === "reset" || output.t === "revoked") {
              channel.fenced = true;
              channel.queue.discard();
            }
            channel.queue.push(output as SubscriptionFrame);
          } catch (error) {
            channel.stop(error);
          }
        } catch (error) {
          welcome?.reject(error);
          fail(error);
          current.close(4002, "Device protocol error");
        }
      });
      current.addEventListener("close", (event) => {
        if (socket !== current) return;
        socket = undefined;
        connection = undefined;
        const error = event.code === 1000
          ? undefined
          : new Error("Device socket interrupted");
        welcome?.reject(
          error ?? new Error("Device socket closed before welcome"),
        );
        if (error) fail(error);
        else {for (const channel of channels.values()) {
            if (channel.reassembly.incomplete) {
              channel.stop(new Error("Interrupted logical output"));
            } else channel.queue.end();
          }}
      });
      current.addEventListener("error", () => {
        welcome?.reject(new Error("Device socket failed"));
      });
      try {
        await ready;
      } finally {
        clearTimeout(timeout);
      }
    })().catch((error) => {
      connection = undefined;
      throw error;
    });
  return {
    async observe(collection, query, observation) {
      observation.signal?.throwIfAborted();
      await connect();
      observation.signal?.throwIfAborted();
      if (channels.size >= maxSubscriptions) {
        throw protocolError(
          "Device channel capacity exceeded",
          "subscription_capacity_exceeded",
        );
      }
      const key = JSON.stringify([
        collection,
        query,
        observation.content,
        observation.progressOnly,
      ]);
      const slots = observation.signal
        ? identities.get(observation.signal) ?? new Map()
        : new Map();
      if (observation.signal) identities.set(observation.signal, slots);
      const identity = slots.get(key) ??
        { channel: crypto.randomUUID(), generation: 0 };
      slots.set(key, identity);
      identity.generation++;
      const id = identity.channel, generation = identity.generation;
      const queue = new SubscriptionQueue<SubscriptionFrame>();
      const abort = () => channel.stop();
      const channel: Channel = {
        generation,
        queue,
        reassembly: new Reassembly(),
        received: observation.checkpoint,
        applying: false,
        stop(error) {
          if (channels.get(id) !== channel) return;
          channels.delete(id);
          observation.signal?.removeEventListener("abort", abort);
          try {
            send({ t: "unsubscribe", channel: id, generation });
          } catch { /* Disconnected. */ }
          queue.end(error);
        },
      };
      channels.set(id, channel);
      observation.signal?.addEventListener("abort", abort, { once: true });
      try {
        send({
          t: "subscribe",
          channel: id,
          generation,
          collection,
          query,
          cursor: observation.checkpoint,
          content: observation.content,
          progressOnly: observation.progressOnly,
        });
      } catch (error) {
        channel.stop(error);
        throw error;
      }
      return {
        frames: {
          async *[Symbol.asyncIterator]() {
            for await (const frame of queue) {
              channel.applying = true;
              yield frame;
              channel.applying = false;
            }
          },
        },
        isActive: () => channels.get(id) === channel && !channel.fenced,
        applied(checkpoint) {
          if (channels.get(id) === channel && socket?.readyState === 1) {
            try {
              send({ t: "applied", channel: id, generation, checkpoint });
            } catch (error) {
              channel.stop(error);
            }
          }
          channel.applying = false;
        },
        detach: () => channel.stop(),
      };
    },
    reauthenticate() {
      return authenticating ??= (async () => {
        await connect();
        const credentials = await options.credentials();
        if (closed) throw protocolError("Device transport closed");
        welcome = Promise.withResolvers<void>();
        connection = welcome.promise;
        void connection.catch(() => {});
        const timeout = setTimeout(() => {
          welcome?.reject(new Error("Device reauthentication timed out"));
          socket?.close(4001, "Reauthentication timeout");
        }, 10_000);
        try {
          // Detach while still authenticated; no controls may follow reauthenticate
          // until the server sends welcome. Fence blocked callbacks immediately.
          fail(new Error("Device reauthentication"));
          send({ t: "reauthenticate", credentials });
          await connection;
        } catch (error) {
          welcome.reject(error);
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      })().finally(() => {
        authenticating = undefined;
      });
    },
    close() {
      closed = true;
      fail();
      socket?.close(1000, "Device closed");
    },
  };
}
