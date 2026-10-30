/**
 * Chrome DevTools over a pipe: Chrome reads commands on fd 3 and writes
 * replies and events on fd 4, each a JSON message ending in NUL. No debugging
 * port is opened, so nothing else on the machine can reach this browser.
 */
import type { Readable, Writable } from "node:stream";
import { browserError } from "./async.ts";

export type Params = Record<string, unknown>;
export type Packet = {
  id?: number;
  method?: string;
  params?: Params;
  result?: Params;
  error?: { code: number; message: string };
  sessionId?: string;
};

/** How packets come and go. */
export type Wire = {
  send(packet: Packet): Promise<void>;
  /** Hears every packet, then the end (with an error if it broke). */
  listen(packet: (packet: Packet) => void, end: (error?: unknown) => void): void;
  close(): Promise<void>;
};

/** Commands and events, for the browser or one of its pages. */
export type DevTools = {
  send<T = Params>(method: string, params?: Params, signal?: AbortSignal): Promise<T>;
  on<T = Params>(method: string, listener: (params: T) => void): () => void;
};

/** A DevTools connection: the browser's, with its pages' sessions. */
export type Client = DevTools & {
  session(sessionId: string): DevTools;
  readonly closed: boolean;
  close(): Promise<void>;
};

const MOST = 32 * 1024 * 1024;

/** The pipe protocol on a child's streams: NUL-delimited JSON. */
export function pipeWire(readable: Readable, writable: Writable): Wire {
  writable.on("error", () => {});
  return {
    send: (packet) =>
      new Promise((resolve, reject) => {
        writable.write(JSON.stringify(packet) + "\0", (error) => error ? reject(error) : resolve());
      }),
    listen(packet, end) {
      let buffer = "";
      let ended = false;
      const finish = (error?: unknown) => {
        if (ended) return;
        ended = true;
        end(error);
      };
      readable.setEncoding("utf8");
      readable.on("data", (chunk: string) => {
        if (ended) return;
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf("\0")) >= 0) {
          const text = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          try {
            if (text) packet(JSON.parse(text) as Packet);
          } catch (error) {
            return finish(error);
          }
        }
        if (buffer.length > MOST) finish(new Error("DevTools message too large"));
      });
      readable.on(
        "end",
        () => finish(buffer ? new Error("Truncated DevTools message") : undefined),
      );
      readable.on("error", (error) => finish(error));
      readable.on("close", () => finish());
    },
    close() {
      writable.end();
      readable.destroy();
      return Promise.resolve();
    },
  };
}

/** A DevTools client on `wire`; a command unanswered in `timeoutMs` fails. */
export function createClient(wire: Wire, timeoutMs = 30_000): Client {
  let next = 0;
  let failure: unknown;
  const pending = new Map<number, {
    method: string;
    resolve(value: Params): void;
    reject(error: unknown): void;
    cleanup(): void;
  }>();
  const listeners = new Map<string, Set<(params: Params) => void>>();

  const fail = (error: unknown) => {
    failure ??= error;
    for (const call of pending.values()) {
      call.cleanup();
      call.reject(error);
    }
    pending.clear();
  };

  const listen = <T>(method: string, listener: (params: T) => void, sessionId = "") => {
    const key = `${sessionId}:${method}`;
    const set = listeners.get(key) ?? new Set();
    const wrapped = (params: Params) => listener(params as T);
    set.add(wrapped);
    listeners.set(key, set);
    return () => {
      set.delete(wrapped);
      if (!set.size) listeners.delete(key);
    };
  };

  const request = <T>(
    method: string,
    params: Params = {},
    signal?: AbortSignal,
    sessionId?: string,
  ) => {
    if (failure) return Promise.reject(failure);
    signal?.throwIfAborted();
    const id = ++next;
    return new Promise<T>((resolve, reject) => {
      const drop = (error: unknown) => {
        const call = pending.get(id);
        if (!call) return;
        pending.delete(id);
        call.cleanup();
        reject(error);
      };
      const abort = () => drop(signal?.reason);
      const timer = setTimeout(
        () => drop(browserError("timeout", `DevTools ${method} timed out`)),
        timeoutMs,
      );
      pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      void wire.send({ id, method, params, ...(sessionId ? { sessionId } : {}) }).catch(drop);
    });
  };

  let done!: () => void;
  const ended = new Promise<void>((resolve) => done = resolve);
  wire.listen((packet) => {
    if (packet.id !== undefined) {
      const call = pending.get(packet.id);
      if (!call) return;
      pending.delete(packet.id);
      call.cleanup();
      if (packet.error) {
        call.reject(browserError("devtools_error", `${call.method}: ${packet.error.message}`));
      } else call.resolve(packet.result ?? {});
    } else if (packet.method) {
      for (const listener of listeners.get(`${packet.sessionId ?? ""}:${packet.method}`) ?? []) {
        try {
          listener(packet.params ?? {});
        } catch {
          // A listener's failure doesn't stop the protocol.
        }
      }
    }
  }, (error) => {
    fail(error ?? browserError("disconnected", "Chrome's DevTools pipe closed"));
    done();
  });

  return {
    send: (method, params, signal) => request(method, params, signal),
    on: (method, listener) => listen(method, listener),
    session: (sessionId) => ({
      send: (method, params, signal) => request(method, params, signal, sessionId),
      on: (method, listener) => listen(method, listener, sessionId),
    }),
    get closed() {
      return failure !== undefined;
    },
    async close() {
      fail(browserError("disconnected", "DevTools client closed"));
      await wire.close();
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 1000))]);
      listeners.clear();
    },
  };
}
