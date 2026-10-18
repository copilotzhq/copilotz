/** Test-only real-PostgreSQL helpers. Never imported by the runtime. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createConnection, createServer, type Socket } from "node:net";
import { defineCollection } from "../collections/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { createTestDatabase } from "./ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCommand,
  type OwnerJson,
} from "../owner/boundary.ts";
import { createOwnerCollectionCommand } from "../owner/collections.ts";

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
    const server = createConnection({
      host: target.hostname,
      port: Number(target.port || 5432),
    });
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

export const caller = (ownerEpoch: number) => ({
  principal: { kind: "worker" as const, workerId: "worker" },
  ownerEpoch,
});
export const command = (key: string, id = key): OwnerCommand => ({
  kind: "collections",
  domain: "logical",
  key,
  intent: {
    operations: [{
      collection: "notes",
      operation: "create",
      input: { id, title: id },
    }],
  },
});
export const mixedCommands = () => [
  command("existing"),
  command("existing", "conflict"),
  command("new"),
  command("failed"),
];

const notes = defineCollection({
  name: "note",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      title: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "title", "createdAt", "updatedAt"],
  } as const,
});

/** Real Collection kernel + event store + owner boundary; dispatch is a test
 * output sink so this fixture tests the durability gate, not Processor recovery. */
export async function ownerFixture(
  url: string,
  schema: string,
  holderId: string,
  notify: (value: Record<string, unknown>) => void,
  failCommand = false,
) {
  const db = await createTestDatabase({
    url: localPostgresUrl(url, `${schema}_${holderId}`),
    pgPoolMax: 1,
  });
  const processor = defineProcessor({
    id: "owner.pg.observe",
    on: [{ eventType: "note.created" }],
    handle() {},
  });
  const registry = createPluginRegistry({
    plugins: [
      definePlugin({
        id: "pg-owner",
        version: "1",
        collections: { notes },
        processors: { observe: processor },
      }),
    ],
  });
  const unavailable = (): Promise<never> =>
    Promise.reject(
      new Error("Unexpected execution through PostgreSQL output sink."),
    );
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "owner.pg.output-sink",
    workloads: {},
    scheduleDelivery(delivery) {
      notify({
        type: "dispatched",
        id: typeof delivery === "string" ? delivery : delivery.id,
      });
    },
    dispatchWork: unavailable,
    dispatchDelivery: unavailable,
    dispatchRecoverable: unavailable,
    settleOutputs: unavailable,
    awaitScopeProgress: unavailable,
    shutdown: unavailable,
  };
  const handler = createOwnerCollectionCommand({
    session: db,
    schema,
    registry,
    collections: { notes },
    scope: () => ({ namespace: "test-space" }),
    publish(event) {
      notify({ type: "published", id: event.durable ? event.id : undefined });
    },
    executor,
  });
  const owner = createOwnerCommandBoundary({
    session: db,
    schema,
    ownerId: "tenant",
    holderId,
    authorize(_tx, who) {
      assert.equal(
        who.principal.kind === "worker" ? who.principal.workerId : undefined,
        "worker",
      );
    },
    authenticateReceipt(_tx, who) {
      assert.equal(
        who.principal.kind === "worker" ? who.principal.workerId : undefined,
        "worker",
      );
    },
    handlers: {
      async collections(intent, ctx) {
        notify({ type: "handler", key: ctx.command.key });
        const result = await handler(intent, ctx);
        await ctx.tx.query(
          `INSERT INTO "${schema}".owner_alarms(owner,name,due_at) VALUES('tenant',$1,'2027-01-01T00:00:00Z')`,
          [ctx.command.key],
        );
        if (failCommand && ctx.command.key === "failed") {
          throw new Error("individual command failure after effects");
        }
        return result as OwnerJson;
      },
    },
  });
  return {
    db,
    owner,
    async close() {
      owner.stop();
      await db.close();
    },
  };
}
