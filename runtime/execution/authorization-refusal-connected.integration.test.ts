import { ActionError } from "../actions/errors.ts";
import { secret } from "../actions/secret.ts";
import type { OwnerAuthorization } from "../authorization/evaluator.ts";
import { bindTestActions, testAuthority } from "../testing/authority.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { createCopilotzGateway } from "../application/gateway.ts";
import { createCopilotzWorker } from "../application/worker.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { listen } from "../adapters/deno/listen.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";

const namespace = "connected";
type FixtureOptions = {
  actions: Record<string, ReturnType<typeof defineAction>>;
  authorization: OwnerAuthorization;
};
async function fixture(
  kind: "in-process" | "websocket",
  options: FixtureOptions,
) {
  const database = await createOwnerTestDatabase();
  const topic = crypto.randomUUID();
  const workerId = "connected-worker";
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
      admit: (binding) => ownerBinding.workerCalls.admit(binding),
      admitUnassigned: (binding) =>
        ownerBinding.workerCalls.admitUnassigned!(binding),
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
    actions: options.actions,
    adapters: { secrets: { default: await testSecretAdapter() } },
    authorization: options.authorization,
    dispatcher: (binding) => {
      ownerBinding = binding;
      return hypervisor;
    },
    target: { workerId },
    engine: {
      retryBaseMs: 0,
      random: () => 0,
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
    gateway: {
      ...gateway,
      actions: bindTestActions(
        gateway.actions,
        testAuthority("public", namespace),
      ),
    },
    database,
    worker,
    async close() {
      await worker.stop();
      await gateway.shutdown();
      await hypervisor.shutdown();
      await listener?.shutdown();
      await database.close();
    },
  };
}

for (const transport of ["in-process", "websocket"] as const) {
  Deno.test({
    name:
      `${transport}: protected policy refusal cannot be swallowed into success and worker error shapes grant no cleanup`,
    ignore: !Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL"),
    async fn() {
      let allowed = true;
      const child = defineAction({
        id: "refused.child",
        inputSchema: {
          type: "object",
          properties: { credential: secret({ type: "string" }) },
          additionalProperties: false,
        } as const,
        execute() {
          allowed = false;
          return "must-not-disclose";
        },
      });
      const run = defineAction({
        id: "refused.parent",
        async execute(_input: unknown, ctx: ActionContext) {
          try {
            await ctx.actions.child({}, { operationKey: "child" });
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
      const authorization: OwnerAuthorization = {
        policies: {
          fixture: {
            revision: "1",
            sources: [],
            evaluate({ intent }) {
              if (!allowed && intent.resource === "child") {
                throw new ActionError("Action access revoked", {
                  code: "forbidden",
                  status: 403,
                });
              }
              return {
                actions: {
                  run: {},
                  forged: {},
                  child: intent.operation === "capture"
                    ? { input: { credential: "owner-only-credential" } }
                    : {},
                },
              };
            },
          },
        },
        collections: {},
        actions: {
          run: { id: "fixture", revision: "1" },
          child: { id: "fixture", revision: "1" },
          forged: { id: "fixture", revision: "1" },
        },
      };
      const f = await fixture(transport, {
        actions: { run, child, forged },
        authorization,
      });
      try {
        await assertRejects(() =>
          f.gateway.actions.run({}, { idempotencyKey: "refusal" })
        );
        const terminals = await f.database.query<
          { body: { status: string; error?: { code: string } } }
        >("SELECT COALESCE(body->'data',body) AS body FROM public.event_bodies WHERE COALESCE(body->'data',body)->>'actionId' IN ('refused.child','refused.parent') AND COALESCE(body->'data',body)->>'status' IN ('completed','failed','cancelled')");
        assertEquals(terminals.rows.length, 2);
        assertEquals(
          terminals.rows.every((row) =>
            row.body.status === "failed" &&
            row.body.error?.code === "forbidden"
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
            "SELECT COALESCE(body->'data',body) AS body FROM public.event_bodies WHERE COALESCE(body->'data',body)->>'actionId'='refused.forged' AND COALESCE(body->'data',body)->>'status'='failed'",
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
