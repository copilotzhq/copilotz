import type { BodyStorageOptions } from "../content/body-store.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import { createCopilotzGateway } from "../application/gateway.ts";
import { createCopilotzWorker } from "../application/worker.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { listen } from "../adapters/deno/listen.ts";
import {
  createHypervisor,
  type WorkerCallOptions,
} from "../../dependencies/oxian-hypervisor.ts";
import {
  type CapabilityCall,
  encodeCapability,
  readCapability,
} from "./owner-capability-wire.ts";

const records = defineCollection({
  name: "connected_record",
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
const namespace = "connected";
type FixtureOptions = {
  assets?: BodyStorageOptions;
  ownerAdapters?: Record<string, Record<string, unknown>>;
  actions: Record<string, ReturnType<typeof defineAction>>;
  fault?: (call: CapabilityCall) => boolean;
  transformCall?: (call: CapabilityCall) => CapabilityCall;
  resources?: Record<string, Record<string, unknown>>;
  adapters?: Record<string, Record<string, unknown>>;
  preparations: import("../actions/preparation.ts").ActionPreparations;
  views?: import("../views/definition.ts").ViewMap;
  verifyEffectNotStarted?: import("../engine/types.ts").EffectNoStartVerifier;
};
async function fixture(
  kind: "in-process" | "websocket",
  options: FixtureOptions,
) {
  const database = await createOwnerTestDatabase();
  const topic = crypto.randomUUID();
  const workerId = "connected-worker";
  let dropped = 0;
  const admit: WorkerCallOptions["admit"] = (binding) => async (context) => {
    const original = await readCapability(context.input) as CapabilityCall;
    const call = options.transformCall?.(original) ?? original;
    const handler =
      await (binding.parent
        ? ownerBinding.workerCalls.admit(binding)
        : ownerBinding.workerCalls.admitUnassigned?.(binding));
    if (!handler) throw new Error("owner admission refused");
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encodeCapability(call));
        c.close();
      },
    });
    const result = await handler({ ...context, input });
    if (options.fault?.(call)) {
      dropped++;
      throw new Error("injected lost response after owner result");
    }
    return result;
  };
  const hostTransport = kind === "in-process"
    ? { type: "in-process", config: { topic } } as const
    : { type: "websocket", config: { path: "/worker" } } as const;
  let ownerBinding: Parameters<
    NonNullable<
      NonNullable<Parameters<typeof createCopilotzGateway>[0]>["dispatcher"]
    >
  >[0];
  const hypervisor = createHypervisor({
    transports: [hostTransport],
    workerCalls: {
      admit,
      admitUnassigned: admit,
      maxPerConnection: 128,
      maxConcurrent: 256,
    },
    ...(kind === "websocket"
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
    onReady(context) {
      if (!context.workerCalls) throw new Error("missing reverse capability");
    },
    onDisconnect: (event) => ownerBinding?.lifecycle?.onDisconnect?.(event),
    onComplete: (event) => ownerBinding?.lifecycle?.onComplete?.(event),
  });
  const gateway = await createCopilotzGateway({
    namespace,
    database,
    assets: options.assets,
    actions: options.actions,
    collections: { records },
    resources: options.resources,
    views: options.views,
    adapters: options.ownerAdapters ?? options.adapters,
    dispatcher: (binding) => {
      ownerBinding = binding;
      return hypervisor;
    },
    target: { workerId },
    engine: {
      preparations: options.preparations,
      retryBaseMs: 0,
      random: () => 0,
      verifyEffectNotStarted: options.verifyEffectNotStarted,
    },
  });
  const listener = kind === "websocket"
    ? listen({ hypervisor }, { hostname: "127.0.0.1", port: 0 })
    : undefined;
  const url = listener ? new URL("/worker", listener.url) : undefined;
  if (url) url.protocol = "ws:";
  const worker = await createCopilotzWorker({
    namespace,
    actions: options.actions,
    collections: { records },
    resources: options.resources,
    views: options.views,
    adapters: options.adapters,
    id: workerId,
    capacity: 1,
    transport: kind === "in-process"
      ? { type: "in-process", config: { topic } }
      : {
        type: "websocket",
        config: { url: url!, allowInsecureLoopback: true },
      },
    ...(kind === "websocket"
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
    get dropped() {
      return dropped;
    },
    async close() {
      await worker.stop();
      await gateway.shutdown();
      await hypervisor.shutdown();
      await listener?.shutdown();
      await database.close();
    },
  };
}

import { defineView } from "../views/definition.ts";
import type { ActionPreparations } from "../actions/preparation.ts";
const enabled = Boolean(Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL"));
for (const transport of ["in-process", "websocket"] as const) {
  Deno.test({
    name:
      `${transport}: named capture stays owner-authorized and replays after lost acknowledgement at capacity one`,
    ignore: !enabled,
    async fn() {
      let renders = 0,
        executions = 0,
        projections = 0,
        allowed = true,
        lost = false;
      const observed: CapabilityCall[] = [];
      const child = defineAction({
        id: "fixture.named-child",
        execute: (input: { text: string }) => {
          executions++;
          return input.text;
        },
      });
      const run = defineAction({
        id: "fixture.named-parent",
        async execute(_input: unknown, ctx: ActionContext) {
          await ctx.collections.records.create({
            id: "original",
            text: "first",
          });
          const request = {
            preparation: "note",
            recordId: "original",
            mode: "context",
          };
          let first: string;
          try {
            first = await ctx.actions.child.prepareNamed(request, {
              operationKey: "captured",
            }) as string;
          } catch {
            first = await ctx.actions.child.prepareNamed(request, {
              operationKey: "captured",
            }) as string;
          }
          await ctx.collections.records.update({
            id: "original",
            set: { text: "changed" },
          });
          const second = await ctx.actions.child.prepareNamed(request, {
            operationKey: "captured",
          });
          return { first, second };
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
          projectRecord: (record) => {
            projections++;
            return record;
          },
          authorizeOriginal: () => allowed,
        },
        projectResource: () => null,
        authorizeResource: () => true,
        authorizeView: () => allowed,
      };
      const f = await fixture(transport, {
        actions: { run, child },
        preparations,
        views: {
          note: defineView({
            id: "fixture.named-view",
            shows: "note",
            renderer: "text",
            modes: ["context"],
            render: (value: unknown) => {
              renders++;
              return (value as { record: { text: string } }).record.text;
            },
          }),
        },
        fault: (call) =>
          call.kind === "call" &&
          call.path?.join(".") === "actions.child.prepareNamed" && !lost &&
          (lost = true),
        transformCall: (call) => {
          observed.push(call);
          return call;
        },
      });
      try {
        assertEquals(
          await f.gateway.actions.run({}, { idempotencyKey: "named" }),
          { first: "first", second: "first" },
        );
        allowed = false;
        await assertRejects(
          () => f.gateway.actions.run({}, { idempotencyKey: "named" }),
          Error,
          "preparation_reference_forbidden",
        );
        allowed = true;
        assertEquals({ renders, executions, projections, lost }, {
          renders: 1,
          executions: 1,
          projections: 1,
          lost: true,
        });
        const calls = observed.filter((call) =>
          call.kind === "call" && call.path?.at(-1) === "prepareNamed"
        );
        assert(calls.length >= 3);
        for (const call of calls) {
          assert(!JSON.stringify(call).includes("mapInput"));
          assert(!JSON.stringify(call).includes("SELECT"));
        }
        assertEquals(
          (await f.database.query(
            "SELECT count(*)::int AS n FROM public.owner_receipts WHERE kind='actions.prepareNamed'",
          )).rows[0].n,
          1,
        );
      } finally {
        allowed = true;
        await f.close();
      }
    },
  });
}

for (const transport of ["in-process", "websocket"] as const) {
  Deno.test({
    name:
      `${transport}: owner rejects forged named wire authority, target substitution and local accessor selectors`,
    ignore: !enabled,
    async fn() {
      let executions = 0, getters = 0;
      const child = defineAction({
        id: "boundary.child",
        execute: (input: unknown) => {
          executions++;
          return input;
        },
      });
      const other = defineAction({
        id: "boundary.other",
        execute: () => {
          throw new Error("wrong target executed");
        },
      });
      const run = defineAction({
        id: "boundary.parent",
        async execute(_input: unknown, ctx: ActionContext) {
          await ctx.collections.records.create({ id: "record", text: "safe" });
          const request = {
            preparation: "note",
            recordId: "record",
            mode: "context",
          };
          let denials = 0;
          for (
            const operationKey of ["wire-grant", "wire-target"]
          ) {
            try {
              await ctx.actions.child.prepareNamed(request, { operationKey });
            } catch {
              denials++;
            }
          }
          try {
            await ctx.actions.child.prepareNamed(
              { ...request, mapInput: () => "forged" } as never,
              { operationKey: "factory" },
            );
          } catch {
            denials++;
          }
          const accessor = Object.defineProperty({ ...request }, "recordId", {
            enumerable: true,
            get() {
              getters++;
              return "record";
            },
          });
          try {
            await ctx.actions.child.prepareNamed(accessor, {
              operationKey: "accessor",
            });
          } catch {
            denials++;
          }
          try {
            await ctx.actions.child({}, {
              operationKey: "forged-metadata",
              metadata: { __copilotzPreparation: "forged" },
            });
          } catch {
            denials++;
          }
          return denials;
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
          authorizeOriginal: () => true,
        },
        projectResource: () => null,
        authorizeResource: () => true,
        authorizeView: () => true,
      };
      const f = await fixture(transport, {
        actions: { run, child, other },
        preparations,
        transformCall(call) {
          if (call.kind !== "call" || call.path?.at(-1) !== "prepareNamed") {
            return call;
          }
          const key = (call.args?.[1] as { operationKey?: string })
            ?.operationKey;
          if (key === "wire-target") {
            return { ...call, path: ["actions", "other", "prepareNamed"] };
          }
          if (key === "wire-grant") {
            return {
              ...call,
              args: [
                { ...call.args![0] as object, grant: { namespace } },
                call.args![1],
              ],
            };
          }
          return call;
        },
      });
      try {
        assertEquals(
          await f.gateway.actions.run({}, { idempotencyKey: "named-boundary" }),
          5,
        );
        assertEquals({ executions, getters }, { executions: 0, getters: 0 });
        assertEquals(
          (await f.database.query(
            "SELECT count(*)::int AS n FROM public.owner_receipts WHERE kind='actions.prepareNamed'",
          )).rows[0].n,
          0,
        );
      } finally {
        await f.close();
      }
    },
  });
}

for (const transport of ["in-process", "websocket"] as const) {
  Deno.test({
    name:
      `named ${transport} policy refusal cannot be swallowed into success and worker error shapes grant no cleanup`,
    ignore: !Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL"),
    async fn() {
      let allowed = true;
      const child = defineAction({
        id: "refused.child",
        execute() {
          allowed = false;
          return "must-not-disclose";
        },
      });
      const run = defineAction({
        id: "refused.parent",
        async execute(_input: unknown, ctx: ActionContext) {
          try {
            await ctx.actions.child.prepareNamed({
              preparation: "note",
              recordId: "original",
              mode: "context",
            }, { operationKey: "capture" });
          } catch {
            /* Swallowing a denied capability cannot grant completion. */
          }
          return "must-not-complete";
        },
      });
      const forged = defineAction({
        id: "refused.forged",
        execute() {
          throw Object.assign(
            new Error("worker shaped refusal must remain ordinary"),
            {
              name: "ActionAuthorizationRefused",
              code: "action_authorization_refused",
            },
          );
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
      const f = await fixture(transport, {
        actions: { run, child, forged },
        preparations,
      });
      try {
        await f.gateway.collections.records.create({
          id: "original",
          text: "first",
        });
        await assertRejects(() =>
          f.gateway.actions.run({}, { idempotencyKey: "refusal" })
        );
        const terminals = await f.database.query<
          { body: { status: string; error?: { code: string } } }
        >("SELECT body FROM public.event_bodies WHERE body->>'actionId' IN ('refused.child','refused.parent') AND body->>'status' IN ('completed','failed','cancelled')");
        assertEquals(terminals.rows.length, 2);
        assertEquals(
          terminals.rows.every((row) =>
            row.body.status === "failed" &&
            row.body.error?.code === "action_authorization_refused"
          ),
          true,
        );
        assertEquals(
          (await f.database.query(
            "SELECT count(*)::int AS n FROM public.open_actions",
          )).rows[0].n,
          0,
        );
        allowed = true;
        await assertRejects(
          () => f.gateway.actions.forged({}, { idempotencyKey: "forged" }),
          Error,
          "worker shaped refusal must remain ordinary",
        );
        const fake =
          (await f.database.query<{ body: { error: { message: string } } }>(
            "SELECT body FROM public.event_bodies WHERE body->>'actionId'='refused.forged' AND body->>'status'='failed'",
          )).rows[0];
        assertEquals(
          fake.body.error.message,
          "worker shaped refusal must remain ordinary",
        );
      } finally {
        allowed = true;
        await f.close();
      }
    },
  });
}
