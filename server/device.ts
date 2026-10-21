import type { SubscriptionTransport } from "../client/live-query.ts";
import type {
  CollectionSubscription,
  SubscriptionOptions,
} from "../runtime/subscriptions/types.ts";
import type { CollectionQuery } from "../runtime/collections/types.ts";
import {
  channelIdentity,
  decodeControl,
  DEVICE_LIMITS,
  DEVICE_VERSION,
  type DeviceEnvelope,
  type DeviceSocket,
  encoded,
  fragments,
  protocolError,
} from "../runtime/subscriptions/device.ts";

export type DeviceSessionOptions = Readonly<{
  /** Resolve session proof to existing authorized read capabilities. Never trust client authority. */
  authenticate(
    credentials: unknown,
  ): SubscriptionTransport | Promise<SubscriptionTransport>;
  maxSubscriptions?: number;
  maxPendingControls?: number;
  maxPendingBytes?: number;
  heartbeatMs?: number;
  lifetimeMs?: number;
  /** Absolute host request deadline; renew one second before it. */
  requestDeadline?: number;
}>;
type Channel = {
  id: string;
  generation: number;
  abort: AbortController;
  subscription?: CollectionSubscription;
  timer: ReturnType<typeof setTimeout>;
  queue: { frames: Generator<string>; bytes: number }[];
  bytes: number;
  head?: { checkpoint: string; sequence: string };
  sent: Set<string>;
};

/** Portable authenticated subscription binding, shared by WebSocket hosts. */
export function attachDeviceSocket(
  socket: DeviceSocket,
  options: DeviceSessionOptions,
): { close(): void } {
  for (
    const value of [
      options.maxSubscriptions ?? DEVICE_LIMITS.channels,
      options.maxPendingControls ?? DEVICE_LIMITS.queuedFrames,
      options.maxPendingBytes ?? DEVICE_LIMITS.queuedBytes,
      options.heartbeatMs ?? DEVICE_LIMITS.heartbeatMs,
      options.lifetimeMs ?? DEVICE_LIMITS.lifetimeMs,
    ]
  ) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError("Device time bounds must be positive integers");
    }
  }
  if (
    options.requestDeadline !== undefined &&
    !Number.isFinite(options.requestDeadline)
  ) throw new RangeError("Invalid device request deadline");
  const channels = new Map<string, Channel>(),
    generations = new Map<string, number>();
  let transport: SubscriptionTransport | undefined,
    authenticated = false,
    closed = false;
  let epoch = 0,
    pendingControls = 0,
    pendingBytes = 0,
    helloReceived = false,
    controls = Promise.resolve();
  let pumpTimer: ReturnType<typeof setTimeout> | undefined;
  const control = (frame: DeviceEnvelope) => {
    if (closed || socket.readyState !== 1) return;
    const data = JSON.stringify(frame);
    if (encoded(frame).length > DEVICE_LIMITS.frame) {
      throw protocolError("Device control too large");
    }
    socket.send(data);
  };
  const stop = (channel: Channel) => {
    if (channels.get(channel.id) !== channel) return;
    channels.delete(channel.id);
    clearTimeout(channel.timer);
    channel.abort.abort();
    channel.subscription?.detach();
    channel.queue = [];
    channel.bytes = 0;
  };
  const renew = (channel: Channel, reason: string) => {
    stop(channel);
    control({
      t: "renew",
      channel: channel.id,
      generation: channel.generation,
      reason,
    });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    epoch++;
    clearInterval(heartbeat);
    clearTimeout(pumpTimer);
    clearTimeout(handshakeTimer);
    clearTimeout(renewalTimer);
    for (const channel of [...channels.values()]) stop(channel);
    socket.removeEventListener("message", message);
    socket.removeEventListener("close", close);
    socket.removeEventListener("error", close);
    if (socket.readyState < 2) socket.close(1000, "Device session closed");
  };
  const schedule = () => {
    if (pumpTimer !== undefined || closed) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = undefined;
      // Round-robin channels. Control messages bypass these queued data frames.
      for (const channel of [...channels.values()]) {
        const output = channel.queue[0];
        if (!output) continue;
        if (
          (channel.subscription?.canPublish?.() ??
            channel.subscription?.isActive?.()) === false
        ) {
          renew(channel, "authority_changed");
          continue;
        }
        if (
          socket.bufferedAmount >=
            DEVICE_LIMITS.socketBytes - DEVICE_LIMITS.frame
        ) {
          const largest = [...channels.values()].sort((a, b) =>
            b.bytes - a.bytes
          )[0];
          if (largest) renew(largest, "send_buffer");
          continue;
        }
        try {
          const next = output.frames.next();
          if (next.done) {
            channel.queue.shift();
            channel.bytes -= output.bytes;
          } else socket.send(next.value);
        } catch (error) {
          stop(channel);
          control({
            t: "error",
            channel: channel.id,
            generation: channel.generation,
            code: (error as { code?: string }).code ?? "protocol_error",
            retryable: false,
          });
        }
      }
      if ([...channels.values()].some((channel) => channel.queue.length)) {
        schedule();
      }
    }, 0);
  };
  const authenticate = async (credentials: unknown, renewal: boolean) => {
    if (
      !credentials ||
      typeof credentials === "object" &&
        (Array.isArray(credentials) || !Object.keys(credentials).length)
    ) {
      throw protocolError("Nonempty session proof required", "forbidden");
    }
    const current = ++epoch;
    authenticated = false;
    transport = undefined;
    clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(close, 10_000);
    for (const channel of [...channels.values()]) {
      renew(channel, "reauthentication");
    }
    const next = await options.authenticate(credentials);
    if (closed || current !== epoch) return;
    transport = next;
    authenticated = true;
    clearTimeout(handshakeTimer);
    control({
      t: "welcome",
      version: DEVICE_VERSION,
      capabilities: ["subscriptions"],
      reauthenticated: renewal,
    });
  };
  const subscribe = async (frame: DeviceEnvelope) => {
    const { channel: id, generation } = channelIdentity(frame);
    if (generation <= (generations.get(id) ?? 0)) return;
    if (generations.size >= 4096 && !generations.has(id)) {
      throw protocolError("Device generation capacity exceeded");
    }
    generations.set(id, generation);
    const previous = channels.get(id);
    if (previous) stop(previous);
    if (!authenticated || !transport) {
      throw protocolError("Device is not authenticated", "forbidden");
    }
    if (channels.size >= (options.maxSubscriptions ?? DEVICE_LIMITS.channels)) {
      control({
        t: "error",
        channel: id,
        generation,
        code: "subscription_capacity_exceeded",
        retryable: false,
      });
      return;
    }
    if (
      typeof frame.collection !== "string" || !frame.collection ||
      frame.collection.length > 256 ||
      !frame.query || typeof frame.query !== "object" ||
      Array.isArray(frame.query) ||
      frame.progressOnly !== undefined &&
        typeof frame.progressOnly !== "boolean" ||
      frame.cursor !== undefined &&
        (typeof frame.cursor !== "string" || !frame.cursor ||
          frame.cursor.length > 16384)
    ) throw protocolError("Invalid subscription request");
    const channel: Channel = {
      id,
      generation,
      abort: new AbortController(),
      queue: [],
      bytes: 0,
      sent: new Set(),
      timer: setTimeout(
        () => renew(channel, "lifetime"),
        options.lifetimeMs ?? DEVICE_LIMITS.lifetimeMs,
      ),
    };
    channels.set(id, channel);
    try {
      const subscription = await transport.observe(
        frame.collection,
        frame.query as CollectionQuery,
        {
          checkpoint: frame.cursor as string | undefined,
          progressOnly: frame.progressOnly as boolean | undefined,
          content: frame.content as SubscriptionOptions["content"],
          signal: channel.abort.signal,
        },
      );
      channel.subscription = subscription;
      if (channels.get(id) !== channel) {
        subscription.detach();
        return;
      }
      for await (const output of subscription.frames) {
        if (channels.get(id) !== channel) return;
        const envelope = { ...output, channel: id, generation };
        if (output.t === "reset" || output.t === "revoked") {
          stop(channel);
          control(envelope);
          return;
        }
        const size = encoded(envelope).length;
        if (size > DEVICE_LIMITS.logical) {
          throw protocolError(
            "Logical output exceeds capacity",
            "observation_frame_capacity_exceeded",
          );
        }
        channel.head = {
          checkpoint: output.checkpoint,
          sequence: output.t === "snapshot" ? output.sequence : output.to,
        };
        channel.sent.add(output.checkpoint);
        channel.queue.push({ frames: fragments(envelope), bytes: size });
        channel.bytes += size;
        if (channel.sent.size > DEVICE_LIMITS.queuedFrames) {
          renew(channel, "unapplied_capacity");
          return;
        }
        const queued = [...channels.values()].reduce(
          (n, item) => n + item.bytes,
          0,
        );
        if (
          queued > DEVICE_LIMITS.socketBytes &&
          !([...channels.values()].filter((c) => c.queue.length).length === 1 &&
            channel.queue.length === 1)
        ) {
          const largest = [...channels.values()].sort((a, b) =>
            b.bytes - a.bytes
          )[0];
          renew(largest, "send_buffer");
        }
        schedule();
      }
      // Drain complete outputs before clean EOF.
      if (channels.get(id) === channel) {
        if (channel.queue.length) {
          channel.queue.push({
            frames: (function* () {
              yield JSON.stringify({ t: "eof", channel: id, generation });
            })(),
            bytes: 0,
          });
          schedule();
        } else {
          stop(channel);
          control({ t: "eof", channel: id, generation });
        }
      }
    } catch (error) {
      if (channels.get(id) !== channel) return;
      stop(channel);
      const typed = error as {
        code?: string;
        status?: number;
        retryable?: boolean;
      };
      control({
        t: "error",
        channel: id,
        generation,
        code: typed.code ??
          (typed.status === 403 ? "forbidden" : "subscription_failed"),
        retryable: typed.retryable ??
          !(error instanceof TypeError || error instanceof RangeError ||
            typed.status === 403),
      });
    }
  };
  const handle = async (frame: DeviceEnvelope) => {
    if (frame.t === "hello") {
      if (
        authenticated || frame.version !== DEVICE_VERSION ||
        !Array.isArray(frame.capabilities) ||
        !frame.capabilities.includes("subscriptions")
      ) throw protocolError("Unsupported device handshake");
      await authenticate(frame.credentials, false);
      return;
    }
    if (frame.t === "reauthenticate") {
      await authenticate(frame.credentials, true);
      return;
    }
    const { channel: id, generation } = channelIdentity(frame);
    if (frame.t === "subscribe") {
      void subscribe(frame).catch(fatal);
      return;
    }
    const channel = channels.get(id);
    if (!channel || channel.generation !== generation) return;
    if (frame.t === "unsubscribe" || frame.t === "detach") {
      stop(channel);
      return;
    }
    if (frame.t === "applied") {
      if (
        typeof frame.checkpoint !== "string" ||
        !channel.sent.has(frame.checkpoint)
      ) throw protocolError("Unknown applied checkpoint");
      for (const checkpoint of channel.sent) {
        channel.sent.delete(checkpoint);
        if (checkpoint === frame.checkpoint) break;
      }
      return;
    }
    throw protocolError("Unknown device control");
  };
  const fatal = (error: unknown) => {
    control({
      t: "error",
      code: (error as { code?: string }).code ?? "forbidden",
      retryable: false,
    });
    close();
  };
  const message = (event: MessageEvent) => {
    try {
      const frame = decodeControl(event.data); // Bound before authentication sees credentials/input.
      if (!authenticated) {
        if (frame.t !== "hello" || helloReceived) {
          throw protocolError(
            "Only one hello is accepted before authentication",
            "forbidden",
          );
        }
        helloReceived = true;
      }
      const size = encoded(frame).length;
      if (
        pendingControls + 1 >
          (options.maxPendingControls ?? DEVICE_LIMITS.queuedFrames) ||
        pendingBytes + size >
          (options.maxPendingBytes ?? DEVICE_LIMITS.queuedBytes)
      ) {
        throw protocolError("Device control queue overflow");
      }
      pendingControls++;
      pendingBytes += size;
      controls = controls.then(() => {
        if (!closed) return handle(frame);
      }).catch(fatal).finally(() => {
        pendingControls--;
        pendingBytes -= size;
      });
    } catch (error) {
      fatal(error);
    }
  };
  const renewalTimer = options.requestDeadline === undefined
    ? undefined
    : setTimeout(() => {
      for (const channel of [...channels.values()]) {
        renew(channel, "request_deadline");
      }
      socket.close(4000, "Device connection renewal");
      close();
    }, Math.max(0, options.requestDeadline - Date.now() - 1000));
  let handshakeTimer = setTimeout(close, 10_000);
  const heartbeat = setInterval(() => {
    if (!authenticated) return;
    control({
      t: "heartbeat",
      heads: [...channels.values()].filter((c) => c.head && !c.queue.length)
        .map((c) => ({ channel: c.id, generation: c.generation, ...c.head })),
    });
  }, options.heartbeatMs ?? DEVICE_LIMITS.heartbeatMs);
  socket.addEventListener("message", message);
  socket.addEventListener("close", close);
  socket.addEventListener("error", close);
  return { close };
}
