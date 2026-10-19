import { assert, assertEquals, assertRejects } from "@std/assert";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import type { ActionPreparations } from "../actions/preparation.ts";
import { defineCollection } from "../collections/definition.ts";
import { createCopilotz } from "../application/copilotz.ts";
import { createCopilotzGateway } from "../application/gateway.ts";
import { createCopilotzWorker } from "../application/worker.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { listen } from "../adapters/deno/listen.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";

const namespace = "cleanup-connected";
const records = defineCollection({
  name: "cleanup_record",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      text: { type: "string" },
    },
    required: ["id", "namespace", "text"],
  } as const,
});

async function fixture(
  transport: "in-process" | "websocket",
  actions: Record<string, ReturnType<typeof defineAction>>,
  preparations: ActionPreparations,
) {
  const database = await createOwnerTestDatabase();
  const seed = defineAction({
    id: "cleanup.seed",
    execute: (_input: unknown, ctx: ActionContext) =>
      ctx.content.publish({
        id: "cleanup-body",
        mediaType: "text/plain",
        body: new TextEncoder().encode("private bytes"),
      }, { operationKey: "body" }),
  });
  actions = { ...actions, seed };
  // Restart removes the owner repository's prepared-body cache. The tested open
  // must acquire retained canonical bytes rather than reuse the seed's memory.
  const seeder = await createCopilotz({
    namespace,
    database,
    actions,
    collections: { records },
    engine: { preparations, retryBaseMs: 0, random: () => 0 },
  });
  try {
    await seeder.actions.seed({}, { idempotencyKey: "seed" });
  } finally {
    await seeder.close();
  }
  const topic = crypto.randomUUID();
  const workerId = "cleanup-worker";
  let completing = 0;
  let completed = 0;
  const completions = new Map<string, "pending" | "done">();
  let ownerBinding: Parameters<
    NonNullable<
      NonNullable<Parameters<typeof createCopilotzGateway>[0]>["dispatcher"]
    >
  >[0];
  const hypervisor = createHypervisor({
    transports: [
      transport === "in-process"
        ? { type: "in-process", config: { topic } }
        : { type: "websocket", config: { path: "/worker" } },
    ],
    workerCalls: {
      admit: (binding) => ownerBinding.workerCalls.admit(binding),
      admitUnassigned: (binding) =>
        ownerBinding.workerCalls.admitUnassigned!(binding),
      maxPerConnection: 128,
      maxConcurrent: 256,
    },
    ...(transport === "websocket"
      ? {
        admit(context) {
          return {
            definition: {
              workerId,
              providerId: "test",
              workloads: [...context.workloads],
              capacity: context.capacity,
              providerConfig: {},
              labels: {},
            },
            sessionGeneration: 1,
            authenticatedWith: context.credential.kind,
            resume: {
              credential: { kind: "resume", capability: "test-resume" },
              expiresAtMs: Date.now() + 60000,
            },
          };
        },
      }
      : {}),
  }, {
    onDisconnect: (event) => ownerBinding?.lifecycle?.onDisconnect?.(event),
    async onComplete(event) {
      const deliveryId = String(event.metadata.deliveryId);
      completions.set(deliveryId, "pending");
      completing++;
      try {
        await ownerBinding?.lifecycle?.onComplete?.(event);
      } finally {
        completing--;
        completed++;
        completions.set(deliveryId, "done");
      }
    },
  });
  const gateway = await createCopilotzGateway({
    namespace,
    database,
    actions,
    collections: { records },
    dispatcher: (binding) => {
      ownerBinding = binding;
      return hypervisor;
    },
    target: { workerId },
    engine: { preparations, retryBaseMs: 0, random: () => 0 },
  });
  const listener = transport === "websocket"
    ? listen({ hypervisor }, { hostname: "127.0.0.1", port: 0 })
    : undefined;
  const url = listener ? new URL("/worker", listener.url) : undefined;
  if (url) url.protocol = "ws:";
  const worker = await createCopilotzWorker({
    namespace,
    actions,
    collections: { records },
    id: workerId,
    capacity: 1,
    transport: transport === "in-process"
      ? { type: "in-process", config: { topic } }
      : {
        type: "websocket",
        config: { url: url!, allowInsecureLoopback: true },
      },
    ...(transport === "websocket"
      ? {
        activate: () => ({ workerId, attemptId: "attempt", epoch: 1 }),
        register: () => ({
          credential: {
            kind: "registration" as const,
            capability: "test-registration",
          },
          expiresAtMs: Date.now() + 60000,
        }),
        reconnectDelay: false as const,
      }
      : {}),
  });
  await worker.ready;
  return {
    gateway,
    database,
    worker,
    hypervisor,
    completionSnapshot: () => ({ completing, completed }),
    completion: (deliveryId: string) => completions.get(deliveryId),
    async close() {
      await worker.stop();
      await gateway.shutdown();
      await hypervisor.shutdown();
      await listener?.shutdown();
      await database.close();
    },
  };
}

async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out: condition");
}

const enabled = Boolean(Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL"));
for (const transport of ["in-process", "websocket"] as const) {
  for (const detached of [false, true]) {
    Deno.test({
      name: `${transport}: ${
        detached ? "detached" : "awaited"
      } denied acquisition retains owner completion through late cancellation at capacity one`,
      ignore: !enabled,
      async fn() {
        let allowed = true;
        let armRead = false;
        let armCancel = false;
        let physicalReads = 0;
        let cancellationCalls = 0;
        let successorStarts = 0;
        let disclosed = false;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const bodyEntered = Promise.withResolvers<void>();
        const acquire = Promise.withResolvers<void>();
        let workerReturned = false;
        const child = defineAction({
          id: "cleanup.child",
          async execute(_input: unknown, ctx: ActionContext) {
            armRead = true;
            const opened = ctx.content.open({
              assetId: "cleanup-body",
              kind: "text",
              role: "body",
              mediaType: "text/plain",
            }).then(() => {
              disclosed = true;
            }, () => undefined);
            if (detached) {
              await bodyEntered.promise;
            } else await opened;
            workerReturned = true;
            return "must not succeed";
          },
        });
        const run = defineAction({
          id: "cleanup.parent",
          execute: (_input: unknown, ctx: ActionContext) =>
            ctx.actions.child.prepareNamed({
              preparation: "note",
              recordId: "original",
              mode: "context",
            }, { operationKey: "prepared" }),
        });
        const successor = defineAction({
          id: "cleanup.successor",
          execute: () => {
            successorStarts++;
            return "after cleanup";
          },
        });
        const preparations: ActionPreparations = {
          registrations: {
            note: {
              source: "records",
              actionAlias: "child",
              shows: "note",
              modes: ["context"],
              mapInput: (text) => ({ text }),
            },
          },
          source: {
            sources: {
              records: { collectionAlias: "records", fields: ["/text"] },
            },
            authorize: () => ({ namespace, audience: "member" }),
            projectRecord: (record) => record,
            authorizeOriginal: () => allowed,
          },
          projectResource: () => null,
          authorizeResource: () => true,
          authorizeView: () => true,
        };
        const f = await fixture(
          transport,
          { run, child, successor },
          preparations,
        );
        const cancel = ReadableStream.prototype.cancel;
        const arrayBuffer = Response.prototype.arrayBuffer;
        // The first fault holds only this canonical Body read's acknowledgement.
        // It permits a detached worker body to return while the owner acquisition
        // is still physically pending, without holding the owner command queue.
        Response.prototype.arrayBuffer = function () {
          const pending = arrayBuffer.call(this);
          if (armRead && new Error().stack?.includes("logicalBytes")) {
            armRead = false;
            physicalReads++;
            return pending.then(async (bytes) => {
              bodyEntered.resolve();
              await acquire.promise;
              allowed = false;
              armCancel = true;
              return bytes;
            });
          }
          return pending;
        };
        // content.open constructs a native stream after reading canonical bytes.
        // Hold only disposeUndisclosed's cancellation acknowledgement for that
        // acquisition. This is fault injection, not a noncooperative BodyStore
        // implementation; unrelated streams retain their native cancellation.
        ReadableStream.prototype.cancel = function (reason?: unknown) {
          const pending = cancel.call(this, reason);
          if (
            armCancel && !this.locked && reason === undefined &&
            new Error().stack?.includes("disposeUndisclosed")
          ) {
            armCancel = false;
            cancellationCalls++;
            entered.resolve();
            return pending.then(() => release.promise);
          }
          return pending;
        };
        let firstSettled = false;
        let first: Promise<unknown> | undefined;
        let next: Promise<unknown> | undefined;
        try {
          await f.gateway.collections.records.create({
            id: "original",
            text: "first",
          });
          await until(() =>
            f.worker.snapshot().occupiedExecutions === 0 &&
              f.completionSnapshot().completing === 0
              ? true
              : undefined
          );
          first = f.gateway.actions.run({}, {
            idempotencyKey: "cleanup-first",
          });
          void first.then(() => {
            firstSettled = true;
          }, () => {
            firstSettled = true;
          });
          await bounded(
            bodyEntered.promise,
            "canonical body acquisition entered",
          );
          const originalDelivery =
            (await f.database.query<{ owner_delivery_id: string }>(
              "SELECT owner_delivery_id FROM public.open_actions WHERE action_id='cleanup.child'",
            )).rows;
          assertEquals(originalDelivery.length, 1);
          const deliveryId = originalDelivery[0].owner_delivery_id;
          assert(typeof deliveryId === "string");
          assertEquals(physicalReads, 1);
          assertEquals(disclosed, false);
          assertEquals(f.worker.snapshot().occupiedExecutions, 1);
          next = f.gateway.actions.successor({}, {
            idempotencyKey: "cleanup-next",
          });
          void next.catch(() => undefined);
          await until(async () => {
            const rows = await f.database.query(
              `SELECT event_body_id FROM public.event_bodies
               WHERE body->>'actionAlias'='successor'`,
            );
            return rows.rows.length ? rows.rows : undefined;
          });
          // The second request is durably admitted. Observe the real reservation
          // during acquisition, then again during the later cancellation tail.
          await new Promise((resolve) => setTimeout(resolve, 100));
          assertEquals(workerReturned, detached);
          assertEquals(firstSettled, false);
          assertEquals(successorStarts, 0);
          assertEquals(f.worker.snapshot().occupiedExecutions, 1);
          acquire.resolve();
          await bounded(entered.promise, "native cancellation entered");
          await new Promise((resolve) => setTimeout(resolve, 100));
          assertEquals(firstSettled, false);
          assertEquals(successorStarts, 0);
          assertEquals(cancellationCalls, 1);
          // The worker handler can finish while cleanup runs on its owner.
          // The owner lifecycle callback must still retain the old assignment.
          // Require a real offer for the independent successor, not merely a
          // durable request waiting on an unrelated dispatcher retry timer.
          await until(() => {
            assertEquals(
              successorStarts,
              0,
              "successor executed before owner cleanup settled",
            );
            assert(
              f.completion(deliveryId) !== "done",
              "owner assignment released before physical cleanup settled",
            );
            return f.hypervisor.snapshot().work.offered === 1 &&
                f.completion(deliveryId) === "pending"
              ? true
              : undefined;
          });
          assertEquals(f.completion(deliveryId), "pending");
          assertEquals(f.hypervisor.snapshot().work.committed, 0);
          assertEquals(f.worker.snapshot().occupiedExecutions, 1);
          assertEquals(successorStarts, 0);
          assertEquals(firstSettled, false);
          assertEquals(
            (await f.database.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM public.event_deliveries WHERE id=$1 AND status='leased'",
              [deliveryId],
            )).rows[0].n,
            1,
          );
          // This reservation is now the offered successor; its execution may not
          // begin until the old owner's physical cancellation tail settles.
          await new Promise((resolve) => setTimeout(resolve, 100));
          assertEquals(f.completion(deliveryId), "pending");
          assertEquals(f.hypervisor.snapshot().work.offered, 1);
          assertEquals(successorStarts, 0);
          assertEquals(
            (await f.database.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM public.event_bodies
             WHERE body->>'actionId'='cleanup.child'
             AND body->>'status' IN ('completed','failed','cancelled')`,
            )).rows[0].n,
            0,
          );
          release.resolve();
          await assertRejects(() => bounded(first!, "first request refused"));
          assertEquals(
            await bounded(next, "successor completes"),
            "after cleanup",
          );
          assertEquals(successorStarts, 1);
          assertEquals(f.completion(deliveryId), "done");
          assertEquals(disclosed, false);
          assertEquals(cancellationCalls, 1);
          const terminal = await f.database.query<
            { body: { status: string; error?: { code: string } } }
          >(
            `SELECT body FROM public.event_bodies WHERE body->>'actionId'='cleanup.child'
           AND body->>'status' IN ('completed','failed','cancelled')`,
          );
          assertEquals(terminal.rows.length, 1);
          assertEquals(terminal.rows[0].body.status, "failed");
          assertEquals(
            terminal.rows[0].body.error?.code,
            "action_authorization_refused",
          );
          await until(() =>
            f.worker.snapshot().occupiedExecutions === 0 &&
              f.completionSnapshot().completing === 0
              ? true
              : undefined
          );
          assertEquals(
            (await f.database.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM public.open_actions",
            )).rows[0].n,
            0,
          );
        } finally {
          bodyEntered.resolve();
          acquire.resolve();
          release.resolve();
          ReadableStream.prototype.cancel = cancel;
          Response.prototype.arrayBuffer = arrayBuffer;
          allowed = true;
          await Promise.allSettled([first, next]);
          await f.close();
        }
        assert(
          !armCancel,
          "the fault must target the actual undisclosed acquisition",
        );
      },
    });
  }
}
