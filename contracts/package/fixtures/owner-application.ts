/** Selected-sibling acceptance harness; never part of the published package. */
import {
  createCopilotz,
  type OwnerConnectionOptions,
  type OwnerStorageOptions,
} from "../../../create-copilotz.ts";
import { plugin } from "./owner-whole-plugin.ts";
import { createTestDatabase } from "../../../runtime/testing/ominipg.ts";
import { resolveOxianSource } from "../../../scripts/test-owner-connected.mjs";
import { encodeOwnerMetadataConstraints } from "../../../runtime/owner/metadata-constraints.ts";
import type { SqlSession } from "../../../runtime/events/session.ts";
import type { Hypervisor } from "../../../dependencies/oxian-hypervisor.ts";

export async function ownerApplicationFixture(
  source: string,
  mode: "in-process" | "websocket",
  mutateDuringProvisioning = false,
) {
  const { entrypoints } = await resolveOxianSource(source);
  const { createHypervisor } = await import(entrypoints["./hypervisor"]);
  const { createWorker } = await import(entrypoints["./worker"]);
  const { serve } = await import(entrypoints["./adapters/node"]);
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  const local = {
    type: "in-process" as const,
    config: { topic: crypto.randomUUID() },
  };
  const remoteLocal = { ...local, config: { ...local.config } };
  let selected = "embedded";
  let transport: Hypervisor | undefined;
  const errors: unknown[] = [];
  let loseAdmissionReply = false;
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      let admitted = false;
      const result = await db.transaction((tx) =>
        run({
          async query(sql, params) {
            if (
              sql.startsWith("INSERT INTO") && sql.includes("owner_receipts") &&
              params?.includes("action.admit")
            ) admitted = true;
            return await tx.query(sql, params);
          },
        })
      );
      if (admitted && loseAdmissionReply) {
        loseAdmissionReply = false;
        throw new Error("fixture lost committed root admission reply");
      }
      return result;
    },
  };
  const workerOptions = (id: string, connection: unknown) => ({
    id,
    transport: connection,
    capacity: 4,
    hostCalls: { maxConcurrent: 16, timeoutMs: 10_000 },
    activate: () => ({
      workerId: id,
      attemptId: crypto.randomUUID(),
      epoch: 1,
    }),
    register: () => ({
      credential: { kind: "registration", capability: "fixture" },
      expiresAtMs: Date.now() + 60_000,
    }),
    reconnectDelay: false,
  });
  const options = {
    namespace: "space",
    plugins: [plugin],
    storage: {
      ownerId: "owner",
      holderId: "holder",
      schema: "public",
      session,
      initialization: "fresh",
      policy: {
        ingress: (_tx, { fence }) =>
          ["embedded", "remote"].includes(fence.identity.workerId)
            ? {
              namespace: "space",
              principalKey: "api:fixture",
              principal: { actorId: "api:fixture" },
              route: { kind: "wrapper", id: "write-only" },
              allowedActions: ["write"],
              actionMetadata: {},
              operationMetadata: { tenant: "space" },
              metadataConstraints: encodeOwnerMetadataConstraints({
                actorId: "api:fixture",
                tenant: "space",
              }),
              group: { key: "fixture", actorId: "api:fixture" },
            }
            : undefined,
        worker: () => ({ ctx: true, settlement: true }),
        input() {},
        collections: () => ({}),
        processorEvent() {},
        child(_tx, parent, actionId) {
          if (parent.namespace !== "space" || actionId !== "public.child") {
            throw new Error("child denied");
          }
        },
        effectOutcome: () => false,
        effectNotStarted: () => false,
      },
      maxActive: 4,
      maxPending: 32,
      onError: (error) => errors.push(error),
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
            expiresAtMs: Date.now() + 60_000,
          },
        }),
        assign: ({ available }) =>
          available.find((fence) => fence.identity.workerId === selected),
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
  if (mutateDuringProvisioning) {
    let mutated = false;
    options.storage.session = {
      async query(sql, parameters) {
        if (!mutated) {
          mutated = true;
          await Promise.resolve();
          options.namespace = "mutated-namespace";
          options.storage.ownerId = "mutated-owner";
          options.storage.holderId = "mutated-holder";
          options.storage.schema = "mutated-schema";
          options.storage.policy.ingress = () => undefined;
          options.worker.createWorker = () => {
            throw new Error("mutated worker factory");
          };
          (options.worker.connection as unknown as {
            transport: { config: { topic: string } };
          }).transport.config.topic = "mutated-topic";
        }
        return await db.query(sql, parameters);
      },
      transaction: session.transaction,
    };
  }
  const app = await createCopilotz(options);
  let listener: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    await app.ready;
    if (mode === "websocket") listener = await serve({ hypervisor: transport });
    const url = listener ? new URL("/workers", listener.url) : undefined;
    if (url) url.protocol = "ws:";
    const ownerOptions: Omit<OwnerConnectionOptions, "plugins"> = {
      namespace: "space",
      owner: { id: "owner" },
      worker: {
        connection: workerOptions(
          "remote",
          url
            ? {
              type: "websocket",
              config: { url, allowInsecureLoopback: true },
            }
            : remoteLocal,
        ) as never,
        createWorker,
      },
    };
    return {
      app,
      ownerOptions,
      loseNextAdmissionReply() {
        loseAdmissionReply = true;
      },
      errors,
      setExecutionWorker(id: "embedded" | "remote") {
        selected = id;
      },
      query: db.query,
      async close() {
        try {
          await app.close();
        } finally {
          await listener?.shutdown();
          await db.close();
        }
      },
    };
  } catch (error) {
    await app.close().catch(() => undefined);
    await listener?.shutdown();
    await db.close();
    throw error;
  }
}
