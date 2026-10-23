import { defineCollection } from "../collections/definition.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { bindSqlDatabaseIdentity } from "../events/database-identity.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";

import type { OwnerAuthorization } from "../authorization/evaluator.ts";
import { bindTestActions, testAuthority } from "../testing/authority.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { assertEquals } from "@std/assert";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { createCopilotzGateway } from "../application/gateway.ts";
import { createCopilotzWorker } from "../application/worker.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { listen } from "../adapters/deno/listen.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";

const namespace = "connected";
const records = defineCollection({
  name: "record",
  ownerPolicy: "required",
  schema: { type: "object" },
});
const facts = defineCollection({ name: "fact", schema: { type: "object" } });
const collections = { records, facts };
type FixtureOptions = {
  actions: Record<string, ReturnType<typeof defineAction>>;
  authorization: OwnerAuthorization;
};
async function fixture(
  kind: "in-process" | "websocket",
  options: FixtureOptions,
) {
  const storage = await createOwnerTestDatabase();
  const queries: string[] = [];
  let transactions = 0;
  const track = (tx: SqlExecutor): SqlExecutor => ({
    query(sql, params) {
      queries.push(sql);
      return tx.query(sql, params);
    },
  });
  const session: SqlSession = bindSqlDatabaseIdentity({
    ...track(storage),
    transaction(fn) {
      transactions++;
      return storage.transaction((tx) => fn(track(tx)));
    },
  }, storage);
  const database = bindSqlDatabaseIdentity({
    ...session,
    session,
    close: () => storage.close(),
  }, storage);
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
    collections,
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
    collections,
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
  await createSchemaCommandRunner(session, "public")(
    "seed",
    {},
    async (_, c) => {
      for (let i = 0; i < 10; i++) {
        await c.transaction.query(
          `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES($1,'connected','fact',$1,'{"allowed":true}')`,
          [`fact-${i}`],
        );
      }
      await c.transaction.query(
        `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES('record','connected','record','record','{"value":1}')`,
      );
      await c.transaction.query(
        `INSERT INTO public.authorization_sessions(namespace,tenant,id,principal,expires_at) VALUES('connected','fixture','session','member',$1)`,
        [new Date(Date.now() + 600_000).toISOString()],
      );
    },
  );
  return {
    queries,
    get transactions() {
      return transactions;
    },
    gateway: {
      ...gateway,
      actions: bindTestActions(
        gateway.actions,
        {
          ...testAuthority("public", namespace),
          principal: { kind: "session", id: "member" },
          authorityBasis: { kind: "session", id: "session" },
        },
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

for (const acrossRuns of [false, true]) {
  Deno.test(`WebSocket worker get: end-to-end authorization reuse ${acrossRuns ? "across Action runs" : "within an Action run"}`, async () => {
    let evaluations = 0;
    const samples: {
      ms: number;
      sql: number;
      evals: number;
      transactions: number;
    }[] = [];
    const run = defineAction({
      id: "agent.read",
      async execute(_input: unknown, ctx: ActionContext) {
        for (let i = 0; i < (acrossRuns ? 1 : 21); i++) {
          const start = performance.now(),
            sql = f.queries.length,
            evals = evaluations,
            transactions = f.transactions;
          await ctx.collections.records.get({ id: "record" });
          samples.push({
            ms: performance.now() - start,
            sql: f.queries.length - sql,
            evals: evaluations - evals,
            transactions: f.transactions - transactions,
          });
        }
        return "done";
      },
    });
    const f = await fixture("websocket", {
      actions: { run },
      authorization: {
        policies: {
          fixture: {
            revision: "1",
            sources: ["facts"],
            async evaluate({ intent, read }) {
              if (intent.kind === "collection") evaluations++;
              for (let i = 0; i < 10; i++) await read.get("facts", `fact-${i}`);
              return { actions: { run: {} }, collections: { records: {} } };
            },
          },
        },
        actions: { run: { id: "fixture", revision: "1" } },
        collections: { records: { id: "fixture", revision: "1" } },
      },
    });
    try {
      for (let run = 0; run < (acrossRuns ? 21 : 1); run++) {
        assertEquals(
          await f.gateway.actions.run({}, {
            idempotencyKey: `get-benchmark-${run}`,
          }),
          "done",
        );
      }
      const warm = samples.slice(1);
      const times = warm.map((s) => s.ms).sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          connectedGet: {
            acrossRuns,
            first: samples[0],
            warm,
            medianMs: times[Math.floor(times.length / 2)],
            evaluations,
          },
        }),
      );
      assertEquals(samples.length, 21);
      if (
        Deno.env.get("AUTHZ_REUSE_BASELINE") !== "1" &&
        Deno.env.get("AUTHZ_READSET_BASELINE") !== "1"
      ) {
        assertEquals(evaluations, 2);
        assertEquals(warm.map((s) => s.evals), Array(20).fill(0));
        // Background owner work may add statements; the median isolates a get.
        const sql = warm.map((s) => s.sql).sort((a, b) => a - b);
        assertEquals(sql[Math.floor(sql.length / 2)], acrossRuns ? 4 : 3);
      }
    } finally {
      await f.close();
    }
  });
}
