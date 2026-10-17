import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCopilotz,
  type OwnerStorageOptions,
} from "../../create-copilotz.ts";
import { plugin } from "../../contracts/package/fixtures/owner-whole-plugin.ts";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";
import type { Hypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { encodeOwnerMetadataConstraints } from "../owner/metadata-constraints.ts";
import { createTestDatabase } from "../testing/ominipg.ts";

const source = Deno.env.get("COPILOTZ_OXIAN_SOURCE_ROOT");
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Public restart fixture timed out.")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function eventually(check: () => Promise<boolean>) {
  await within((async () => {
    while (!await check()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })());
}
for (const mode of ["in-process", "websocket"] as const) {
  test(
    `public ${mode} storage resumes actual ordinary Collection, Processor and child history`,
    { skip: !source, timeout: 60000 },
    async () => {
      const { entrypoints } = await resolveOxianSource(source!);
      const { createHypervisor } = await import(entrypoints["./hypervisor"]);
      const { createWorker } = await import(entrypoints["./worker"]);
      const { serve } = await import(entrypoints["./adapters/node"]);
      const db = await createTestDatabase({
        pgliteMemoryProfile: "low-memory",
      });
      const closers: (() => Promise<void>)[] = [];
      const errors: unknown[] = [];
      async function start(prior: number) {
        const local = {
          type: "in-process" as const,
          config: { topic: crypto.randomUUID() },
        };
        let transport: Hypervisor | undefined;
        const workerOptions = (id: string, connection: unknown) => ({
          id,
          transport: connection,
          capacity: 4,
          hostCalls: { maxConcurrent: 16, timeoutMs: 10000 },
          activate: () => ({
            workerId: id,
            attemptId: crypto.randomUUID(),
            epoch: 1,
          }),
          register: () => ({
            credential: { kind: "registration", capability: "fixture" },
            expiresAtMs: Date.now() + 60000,
          }),
          reconnectDelay: false,
        });
        const options = {
          namespace: "space",
          plugins: [plugin],
          storage: {
            ownerId: "owner",
            holderId: `holder:${prior + 1}`,
            schema: "public",
            session: db,
            initialization: prior === 0
              ? "fresh"
              : { mode: "resume", expectedEpoch: prior },
            maxActive: 4,
            maxPending: 32,
            leaseMs: 5000,
            onError: (error) => errors.push(error),
            policy: {
              ingress: (_tx, { fence }) =>
                fence.identity.workerId === "remote"
                  ? {
                    namespace: "space",
                    principalKey: "api:restart",
                    principal: { actorId: "api:restart" },
                    route: { kind: "wrapper", id: "write-only" },
                    allowedActions: ["write"],
                    actionMetadata: {},
                    operationMetadata: { tenant: "space" },
                    metadataConstraints: encodeOwnerMetadataConstraints({
                      actorId: "api:restart",
                      tenant: "space",
                    }),
                    group: { key: "restart", actorId: "api:restart" },
                  }
                  : undefined,
              worker: () => ({ ctx: true, settlement: true }),
              input() {},
              collections: () => ({}),
              processorEvent() {},
              child(_tx, parent, actionId) {
                if (
                  parent.namespace !== "space" || actionId !== "public.child"
                ) throw new Error("Child denied.");
              },
              effectOutcome: () => false,
              effectNotStarted: () => false,
            },
            transport: {
              transports: mode === "websocket"
                ? [local, { type: "websocket", config: { path: "/workers" } }]
                : [local],
              admit: ({ identity, credential, workloads, capacity }) => ({
                definition: {
                  workerId: identity.workerId,
                  providerId: "fixture",
                  workloads,
                  capacity,
                  providerConfig: {},
                  labels: {},
                },
                sessionGeneration: 1,
                authenticatedWith: credential.kind,
                resume: {
                  credential: { kind: "resume", capability: "fixture" },
                  expiresAtMs: Date.now() + 60000,
                },
              }),
              assign: ({ available }) =>
                available.find((fence) => fence.identity.workerId === "remote"),
            },
            createTransport(options, lifecycle) {
              transport = createHypervisor(options, lifecycle);
              return transport!;
            },
          },
          worker: {
            connection: workerOptions("embedded", local) as never,
            createWorker,
          },
        } satisfies OwnerStorageOptions;
        const app = await createCopilotz(options);
        let listener: Awaited<ReturnType<typeof serve>> | undefined;
        const peers: { remote?: { close(reason?: string): Promise<void> } } =
          {};
        let closed = false;
        const close = async () => {
          if (closed) return;
          closed = true;
          await peers.remote?.close();
          await app.close();
          await listener?.shutdown();
        };
        closers.push(close);
        await within(app.ready);
        if (mode === "websocket") {
          listener = await serve({ hypervisor: transport });
        }
        const url = listener ? new URL("/workers", listener.url) : undefined;
        if (url) url.protocol = "ws:";
        const connected = await createCopilotz({
          namespace: "space",
          plugins: [plugin],
          owner: { id: "owner" },
          worker: {
            connection: workerOptions(
              "remote",
              url
                ? {
                  type: "websocket",
                  config: { url, allowInsecureLoopback: true },
                }
                : local,
            ) as never,
            createWorker,
          },
        });
        peers.remote = connected;
        await within(connected.ready);
        return { app: connected, close };
      }
      const settled = () =>
        eventually(async () =>
          (await db.query(
              "SELECT 1 FROM event_deliveries WHERE status NOT IN ('succeeded','dead_letter','cancelled')",
            )).rows.length === 0 &&
          (await db.query(
              "SELECT 1 FROM copilotz_operations WHERE state NOT IN ('completed','failed','cancelled')",
            )).rows.length === 0 &&
          (await db.query("SELECT 1 FROM owner_assignments WHERE NOT retired"))
              .rows.length === 0 &&
          (await db.query("SELECT 1 FROM owner_alarms")).rows.length === 0
        );
      try {
        const first = await start(0);
        assert.equal(
          await within(
            first.app.actions.write("one", { idempotencyKey: "same" }),
          ),
          "whole:one",
        );
        await settled();
        assert.equal((await db.query("SELECT 1 FROM nodes")).rows.length, 2);
        const before =
          (await db.query("SELECT count(*)::int AS count FROM events")).rows[0]
            .count;
        const claims = (await db.query(
          "SELECT count(*)::int AS count FROM owner_receipts WHERE kind IN ('execution.claim','processor.claim')",
        )).rows[0].count;
        assert.equal(claims, 3);
        await first.close();
        const second = await start(1);
        assert.equal(
          await within(
            second.app.actions.write("one", { idempotencyKey: "same" }),
          ),
          "whole:one",
        );
        await settled();
        assert.equal(
          (await db.query("SELECT count(*)::int AS count FROM events")).rows[0]
            .count,
          before,
        );
        assert.equal(
          (await db.query(
            "SELECT count(*)::int AS count FROM owner_receipts WHERE kind IN ('execution.claim','processor.claim')",
          )).rows[0].count,
          claims,
        );
        await assert.rejects(
          second.app.actions.write("changed", { idempotencyKey: "same" }),
        );
        assert.equal(
          await within(
            second.app.actions.write("two", { idempotencyKey: "next" }),
          ),
          "whole:two",
        );
        await settled();
        assert.equal((await db.query("SELECT 1 FROM nodes")).rows.length, 4);
        assert.equal(
          (await db.query(
            "SELECT 1 FROM owner_assignments WHERE epoch=2 AND binding->>'workerId'='remote'",
          )).rows.length,
          3,
        );
        assert.equal(
          Number(
            (await db.query(
              "SELECT epoch FROM owner_epochs WHERE owner='owner'",
            ))
              .rows[0].epoch,
          ),
          2,
        );
        await second.close();
        const third = await start(2);
        assert.equal(
          await within(
            third.app.actions.write("two", { idempotencyKey: "next" }),
          ),
          "whole:two",
        );
        await settled();
        assert.equal((await db.query("SELECT 1 FROM nodes")).rows.length, 4);
        assert.deepEqual(errors, []);
      } finally {
        for (const close of closers.reverse()) await close();
        await db.close();
      }
    },
  );
}
