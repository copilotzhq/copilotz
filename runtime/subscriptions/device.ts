/** Portable device binding primitives; no host or database dependencies. */
export const DEVICE_VERSION = "1.0";
export const DEVICE_LIMITS = Object.freeze({
  frame: 1024 * 1024,
  logical: 64 * 1024 * 1024,
  queuedFrames: 256,
  queuedBytes: 1024 * 1024,
  socketBytes: 4 * 1024 * 1024,
  channels: 16,
  heartbeatMs: 15_000,
  lifetimeMs: 5 * 60_000,
});
export type DeviceSocket = Pick<
  WebSocket,
  | "readyState"
  | "bufferedAmount"
  | "send"
  | "close"
  | "addEventListener"
  | "removeEventListener"
>;
export type DeviceEnvelope = Record<string, unknown> & {
  t: string;
  channel?: string;
  generation?: number;
};
// Typed content bodies are carried inside a logical JSON output. Their paths are
// envelope metadata, so application records cannot impersonate a binary marker.
export function stringifyControl(value: unknown): string {
  const paths: string[][] = [], parents = new WeakMap<object, string[]>();
  const json = JSON.stringify(value, function (key, item) {
    const path = parents.has(this) ? [...parents.get(this)!, key] : [];
    if (item instanceof Uint8Array) {
      paths.push(path);
      let binary = "";
      for (let offset = 0; offset < item.length; offset += 8192) {
        binary += String.fromCharCode(...item.subarray(offset, offset + 8192));
      }
      return btoa(binary);
    }
    if (item && typeof item === "object") parents.set(item, path);
    return item;
  });
  if (!paths.length) return json;
  if (!json.startsWith("{") || paths.length > 4096) {
    throw protocolError("Invalid typed content envelope");
  }
  return json.slice(0, -1) + ',"binaryPaths":' + JSON.stringify(paths) + "}";
}
function parseControl(data: string): DeviceEnvelope {
  const value = JSON.parse(data);
  if (value?.binaryPaths !== undefined) {
    if (!Array.isArray(value.binaryPaths) || value.binaryPaths.length > 4096) {
      throw protocolError("Invalid binary paths");
    }
    for (const path of value.binaryPaths) {
      if (
        !Array.isArray(path) || !path.length || path.length > 64 ||
        path.some((key) =>
          typeof key !== "string" ||
          ["__proto__", "constructor", "prototype", "binaryPaths"].includes(key)
        )
      ) throw protocolError("Invalid binary path");
      let target = value;
      for (const key of path.slice(0, -1)) {
        if (
          !target || typeof target !== "object" || !Object.hasOwn(target, key)
        ) throw protocolError("Missing binary path");
        target = target[key];
      }
      const key = path.at(-1);
      if (
        !target || !Object.hasOwn(target, key) ||
        typeof target[key] !== "string"
      ) throw protocolError("Invalid binary body");
      target[key] = Uint8Array.from(atob(target[key]), (c) => c.charCodeAt(0));
    }
    delete value.binaryPaths;
  }
  return value;
}
export const encoded = (value: unknown) =>
  new TextEncoder().encode(stringifyControl(value));
export function protocolError(message: string, code = "protocol_error") {
  return Object.assign(new Error(message), { code, retryable: false });
}
export function decodeControl(data: unknown): DeviceEnvelope {
  if (
    typeof data !== "string" ||
    new TextEncoder().encode(data).length > DEVICE_LIMITS.frame
  ) {
    throw protocolError("Device control exceeds frame bound or is not text");
  }
  const value = parseControl(data);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    typeof value.t !== "string"
  ) {
    throw protocolError("Invalid device control");
  }
  return value;
}
export function channelIdentity(
  frame: DeviceEnvelope,
): { channel: string; generation: number } {
  if (
    typeof frame.channel !== "string" || !frame.channel ||
    frame.channel.length > 128 ||
    !Number.isSafeInteger(frame.generation) || frame.generation! < 1
  ) throw protocolError("Invalid device channel");
  return { channel: frame.channel, generation: frame.generation! };
}
/** Fragments are bounded text controls. Only the last fragment certifies output. */
export function* fragments(frame: DeviceEnvelope): Generator<string> {
  const bytes = encoded(frame);
  if (bytes.length > DEVICE_LIMITS.logical) {
    throw protocolError(
      "Logical output capacity exceeded",
      "observation_frame_capacity_exceeded",
    );
  }
  if (bytes.length <= DEVICE_LIMITS.frame) {
    yield new TextDecoder().decode(bytes);
    return;
  }
  const size = 512 * 1024,
    count = Math.ceil(bytes.length / size),
    id = crypto.randomUUID();
  for (let index = 0; index < count; index++) {
    const part = bytes.subarray(index * size, (index + 1) * size);
    let binary = "";
    for (let offset = 0; offset < part.length; offset += 8192) {
      binary += String.fromCharCode(...part.subarray(offset, offset + 8192));
    }
    yield JSON.stringify({
      t: "fragment",
      channel: frame.channel,
      generation: frame.generation,
      id,
      index,
      count,
      total: bytes.length,
      bytes: btoa(binary),
      ...(index === count - 1 ? { checkpoint: frame.checkpoint } : {}),
    });
  }
}
export class Reassembly {
  private pending?: {
    id: string;
    count: number;
    total: number;
    parts: Uint8Array[];
    length: number;
  };
  accept(frame: DeviceEnvelope): DeviceEnvelope | undefined {
    if (frame.t !== "fragment") {
      if (this.pending) throw protocolError("Interrupted logical output");
      return frame;
    }
    const { index, count, total, id } = frame;
    if (
      !Number.isSafeInteger(index) || !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(total) ||
      (count as number) < 2 || (count as number) > 128 ||
      (index as number) < 0 || (index as number) >= (count as number) ||
      (total as number) < 1 || (total as number) > DEVICE_LIMITS.logical ||
      typeof id !== "string" || id.length > 128 ||
      typeof frame.bytes !== "string"
    ) throw protocolError("Invalid fragment declaration");
    if (index === 0) {
      if (this.pending) throw protocolError("Overlapping logical outputs");
      this.pending = {
        id,
        count: count as number,
        total: total as number,
        parts: [],
        length: 0,
      };
    }
    const pending = this.pending;
    if (
      !pending || pending.id !== id || pending.count !== count ||
      pending.total !== total || pending.parts.length !== index
    ) throw protocolError("Fragment gap or overlap");
    const part = Uint8Array.from(atob(frame.bytes), (c) => c.charCodeAt(0));
    if (
      !part.length || pending.length + part.length > pending.total ||
      (index !== (count as number) - 1 && frame.checkpoint !== undefined)
    ) throw protocolError("Invalid fragment bytes or checkpoint");
    pending.parts.push(part);
    pending.length += part.length;
    if (index !== (count as number) - 1) return;
    if (
      pending.length !== pending.total ||
      typeof frame.checkpoint !== "string" || !frame.checkpoint
    ) throw protocolError("Incomplete logical output");
    const bytes = new Uint8Array(pending.total);
    let offset = 0;
    for (const part of pending.parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const output = parseControl(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    this.pending = undefined;
    if (
      !output || output.channel !== frame.channel ||
      output.generation !== frame.generation ||
      output.checkpoint !== frame.checkpoint ||
      !["snapshot", "batch"].includes(output.t)
    ) throw protocolError("Invalid logical output");
    return output;
  }
  get incomplete() {
    return Boolean(this.pending);
  }
}
/** Bounded async delivery shared by the socket and deterministic test transports. */
export class SubscriptionQueue<T> implements AsyncIterable<T> {
  private values: { value: T; size: number }[] = [];
  private bytes = 0;
  private ended = false;
  private failure?: unknown;
  private wake?: () => void;
  push(value: T, size = encoded(value).length) {
    if (this.ended) return;
    if (
      this.values.length >= DEVICE_LIMITS.queuedFrames ||
      (this.bytes + size > DEVICE_LIMITS.queuedBytes &&
        this.values.length > 0) ||
      size > DEVICE_LIMITS.logical
    ) throw new Error("Device channel queue overflow");
    this.values.push({ value, size });
    this.bytes += size;
    this.wake?.();
  }
  discard() {
    this.values = [];
    this.bytes = 0;
  }
  end(error?: unknown) {
    this.ended = true;
    this.failure = error;
    if (error) {
      this.values = [];
      this.bytes = 0;
    }
    this.wake?.();
  }
  get size() {
    return this.values.length;
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.failure) throw this.failure;
      const next = this.values.shift();
      if (next) {
        this.bytes -= next.size;
        yield next.value;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
