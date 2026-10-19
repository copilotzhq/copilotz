/** Test-only loopback PostgreSQL commit-loss proxy. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createConnection, createServer, type Socket } from "node:net";
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}

export async function bounded<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${label}`);
}

export function localPostgresUrl(
  value: string,
  applicationName?: string,
): string {
  const url = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "This destructive fault fixture only accepts an explicitly supplied loopback test database",
  );
  assert.ok(
    !url.searchParams.has("sslmode") ||
      url.searchParams.get("sslmode") === "disable",
    "The test proxy requires a disposable plaintext loopback PostgreSQL connection",
  );
  url.searchParams.set("sslmode", "disable");
  if (applicationName) {
    url.searchParams.set("application_name", applicationName);
  }
  return url.toString();
}

/** A frame-aware transparent proxy. It retains the server leg after losing the
 * client leg, modeling a real broken client path while COMMIT is in flight.
 * It does not synthesize a SQL/driver error or choose a transaction outcome. */
export async function commitProxy(value: string) {
  const target = new URL(localPostgresUrl(value));
  const connections = new Set<{ client: Socket; server: Socket }>();
  let armed = false;
  let fault: { client: Socket; server: Socket; pid?: number } | undefined;
  const forwarded = deferred<number>();
  const resolved = deferred<string>();
  const evidence: string[] = [];
  const errors: Error[] = [];
  const listener = createServer((client) => {
    client.setNoDelay(true);
    const server = createConnection({
      host: target.hostname,
      port: Number(target.port || 5432),
    });
    server.setNoDelay(true);
    const pair: { client: Socket; server: Socket; pid?: number } = {
      client,
      server,
    };
    connections.add(pair);
    let frontend: Buffer = Buffer.alloc(0);
    let backend: Buffer = Buffer.alloc(0);
    let startup = true;
    client.on("data", (chunk: Buffer) => {
      frontend = Buffer.concat([frontend, chunk]);
      while (frontend.length >= (startup ? 4 : 5)) {
        const length = frontend.readInt32BE(startup ? 0 : 1) +
          (startup ? 0 : 1);
        if (frontend.length < length) break;
        const frame = frontend.subarray(0, length);
        frontend = frontend.subarray(length);
        if (startup) {
          assert.equal(
            frame.readInt32BE(4),
            196608,
            "Only PostgreSQL v3 plaintext startup is supported",
          );
          startup = false;
        } else if (
          armed && frame[0] === 81 &&
          /^COMMIT\s*;?\s*$/i.test(
            frame.toString("utf8", 5).replace(/\0$/, ""),
          )
        ) {
          armed = false;
          fault = pair;
          assert.ok(
            pair.pid,
            "BackendKeyData must identify the exact COMMIT backend",
          );
          evidence.push("COMMIT forwarded");
          server.write(frame, () => forwarded.resolve(pair.pid!));
          continue;
        }
        server.write(frame);
      }
    });
    server.on("data", (chunk: Buffer) => {
      backend = Buffer.concat([backend, chunk]);
      while (backend.length >= 5) {
        const length = backend.readInt32BE(1) + 1;
        if (backend.length < length) break;
        const frame = backend.subarray(0, length);
        backend = backend.subarray(length);
        if (frame[0] === 75) pair.pid = frame.readInt32BE(5);
        if (pair === fault) {
          if (frame[0] === 67) {
            const tag = frame.toString("utf8", 5).replace(/\0$/, "");
            evidence.push(`server ${tag}`);
            if (tag === "COMMIT") resolved.resolve("COMMIT");
          }
          // Deliberately never deliver a COMMIT result to the faulted client.
        } else if (!client.destroyed) client.write(frame);
      }
    });
    client.on("error", () => {}); // Expected when deliberately severing transport.
    server.on("error", (error) => {
      if (pair !== fault) errors.push(error);
      client.destroy();
    });
    client.on("close", () => {
      if (pair !== fault) server.destroy();
      else evidence.push("client transport closed");
    });
    server.on("close", () => {
      client.destroy();
      connections.delete(pair);
      if (pair === fault) resolved.resolve("server connection closed");
    });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.toString(),
    evidence,
    errors,
    forwarded: forwarded.promise,
    resolved: resolved.promise,
    arm() {
      armed = true;
    },
    cutClient() {
      assert.ok(fault, "COMMIT must be forwarded before losing the client");
      evidence.push("client cut requested");
      fault.client.destroy();
    },
    async close() {
      for (const { client, server } of connections) {
        client.destroy();
        server.destroy();
      }
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}
