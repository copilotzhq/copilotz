import { createCopilotz as createWorkerCopilotz } from "../../create-copilotz.ts";
import { ActionError } from "../actions/errors.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createFixtureCopilotz as createCopilotz } from "../testing/fixture-commands.test.ts";
import { type ActionContext, defineAction } from "../actions/index.ts";
import { defineCollection } from "./definition.ts";
import type {
  CollectionPolicyContext,
  CollectionPolicyIntent,
} from "./policy-types.ts";
import { validateCollectionPolicies } from "./policy-registration.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createFixtureGateway as createCopilotzGateway } from "../testing/fixture-commands.test.ts";
import { listen } from "../adapters/deno/listen.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { bounded, until } from "../testing/effect-commit-proxy.ts";

const definition = defineCollection({
  name: "policyEntry",
  ownerPolicy: "required",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, value: { type: "string" } },
    required: ["value"],
  } as const,
  queries: { all: { query: () => ({}) } },
});
// Host result reconstruction preserves safe name/code/message, not HTTP status
// or the original Error prototype.
async function assertActionForbidden(run: () => Promise<unknown>) {
  const error = await assertRejects(run, Error);
  assertEquals(error.name, "ActionError");
  assertEquals(error.message, "Forbidden");
  assertEquals((error as { code?: unknown }).code, "forbidden");
  return error;
}

Deno.test("Collection policy required registration fails closed and Worker host options are refused", async () => {
  assertThrows(
    () => validateCollectionPolicies(undefined, { entry: definition }),
    TypeError,
    "required",
  );
  assertThrows(
    () =>
      validateCollectionPolicies({ forged: { authorize() {} } }, {
        entry: definition,
      }),
    TypeError,
    "registered alias",
  );
  assertThrows(
    () =>
      validateCollectionPolicies({ entry: { authorize() {} } }, {
        entry: definition,
        other: definition,
      }),
    TypeError,
    "exactly one",
  );
  await assertRejects(
    () =>
      createWorkerCopilotz({ role: "worker", collectionPolicies: {} } as never),
    TypeError,
    "Workers accept",
  );
});

Deno.test("required Collection policy refuses startup before schema provisioning", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `policy_missing_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await assertRejects(
      () =>
        createCopilotz({
          database: db,
          databaseSchema: schema,
          namespace: "space",
          collections: { entry: definition },
        }),
      TypeError,
      "required Collection owner policy is missing",
    );
    assertEquals(
      (await db.query("SELECT nspname FROM pg_namespace WHERE nspname=$1", [
        schema,
      ])).rows,
      [],
    );
  } finally {
    await db.close();
  }
});

for (const topology of ["embedded", "websocket"] as const) {
  Deno.test(`Collection policies use actual owner intent and fresh state (${topology})`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
      pgPoolMax: 4,
    });
    const schema = `policy_${crypto.randomUUID().replaceAll("-", "")}`;
    const seen: {
      intent: CollectionPolicyIntent;
      context: CollectionPolicyContext;
    }[] = [];
    const microtasks: Promise<unknown>[] = [];
    const replayOpened = Promise.withResolvers<void>();
    const replayContinue = Promise.withResolvers<void>();
    let committedResultChecks = 0;
    const batchResultChecks = new Map<string, number>();
    const processed = new Map<string, number>();
    const concurrentOpened = Promise.withResolvers<void>();
    const concurrentContinue = Promise.withResolvers<void>();
    const staleOpened = Promise.withResolvers<void>();
    const staleContinue = Promise.withResolvers<void>();
    const staleProbe = Promise.withResolvers<void>();
    void staleProbe.promise.catch(() => undefined);
    const cancelOpened = Promise.withResolvers<void>();
    const cancelContinue = Promise.withResolvers<void>();
    const cancelledProbe = Promise.withResolvers<void>();
    void cancelledProbe.promise.catch(() => undefined);
    const snapshotOpened = Promise.withResolvers<void>();
    const snapshotContinue = Promise.withResolvers<void>();
    const processorDenied = Promise.withResolvers<unknown>();
    let retained: ActionContext | undefined;
    let retainedQuery: CollectionPolicyContext["query"] | undefined;
    const action = (id: string) =>
      defineAction({
        id,
        async execute(input: unknown, ctx: ActionContext) {
          const request = input as { op: string; id?: string; value?: string };
          const key = request.id ?? "one";
          if (request.op === "child-replay") {
            const first = await ctx.actions.allowed({ op: "get" }, {
              operationKey: "read-child",
            });
            const replay = await ctx.actions.allowed({ op: "get" }, {
              operationKey: "read-child",
            });
            assertEquals(first, replay);
            return replay;
          }
          if (request.op === "concurrent-gate") {
            await ctx.collections.entry.get({ id: key });
            concurrentOpened.resolve();
            await concurrentContinue.promise;
            return await ctx.collections.entry.get({ id: key });
          }
          if (request.op === "stale-gate") {
            staleOpened.resolve();
            await staleContinue.promise;
            try {
              await ctx.collections.entry.get({ id: key });
              staleProbe.reject(
                new Error("Stale execution disclosed a record"),
              );
            } catch {
              staleProbe.resolve();
            }
            return true;
          }
          if (request.op === "cancel-gate") {
            cancelOpened.resolve();
            await cancelContinue.promise;
            try {
              await ctx.collections.entry.get({ id: key });
              cancelledProbe.reject(
                new Error("Cancelled invocation disclosed a record"),
              );
            } catch {
              cancelledProbe.resolve();
            }
            return true;
          }
          if (request.op === "retain") {
            retained = ctx;
            return true;
          }
          if (
            request.op === "dependency" || request.op === "batch-postcommit"
          ) {
            const dependency = request.op === "dependency";
            return await ctx.transaction(async ({ collections }) => {
              await collections.entry.create({
                id: dependency ? "predecessor" : "batch-committed:a",
                value: dependency ? "ok" : "batch-committed",
              });
              await collections.entry.create({
                id: dependency ? "dependent" : "batch-committed:b",
                value: dependency ? "ok" : "batch-committed",
              });
              return true;
            }, { operationKey: request.op });
          }
          if (request.op === "receipt-gate") {
            const commit = () =>
              ctx.transaction(async ({ collections }) => {
                await collections.entry.create({
                  id: "receipt:a",
                  value: "ok",
                });
                await collections.entry.create({
                  id: "receipt:b",
                  value: "ok",
                });
                return true;
              }, { operationKey: "receipt-replay" });
            await commit();
            replayOpened.resolve();
            await replayContinue.promise;
            return await commit();
          }
          if (request.op === "create") {
            return await ctx.collections.entry.create({
              id: key,
              value: request.value ?? "ok",
            }, { operationKey: `create:${key}` });
          }
          if (request.op === "delete") {
            return await ctx.collections.entry.delete({ id: key });
          }
          if (request.op === "snapshot-gate") {
            return await ctx.readSnapshot(async ({ collections }) => {
              await collections.entry.get({ id: key });
              snapshotOpened.resolve();
              await snapshotContinue.promise;
              return await collections.entry.get({ id: key });
            });
          }
          if (
            request.op === "vector-write" ||
            request.op === "hidden-vector-write"
          ) {
            return await ctx.transaction(async ({ vectors }) => {
              await vectors.upsert({
                ownerType: request.op === "hidden-vector-write"
                  ? "hiddenAuthority"
                  : "policyEntry",
                ownerId: "one",
                field: "fixture",
                sourceField: "value",
                source: "ok",
                values: [1, 0, 0],
                profile: {
                  model: "fixture",
                  revision: "1",
                  dimensions: 3,
                  metric: "cosine",
                },
              });
            });
          }
          if (
            request.op === "relation-write" ||
            request.op === "hidden-relation-write"
          ) {
            return await ctx.transaction(async ({ relations }) => {
              await relations.upsert({
                id: key,
                type: "linked",
                source: { type: "policyEntry", id: "one" },
                target: {
                  type: request.op === "hidden-relation-write"
                    ? "hiddenAuthority"
                    : "policyEntry",
                  id: "predecessor",
                },
              });
            });
          }
          if (request.op === "vectors") {
            return await ctx.vectors.search({
              ownerType: "policyEntry",
              values: [1, 0, 0],
              field: "fixture",
              profile: {
                model: "fixture",
                revision: "1",
                dimensions: 3,
                metric: "cosine",
              },
              filter: { field: "id", eq: "one" },
              limit: 1,
            });
          }
          if (request.op === "hidden") {
            return await ctx.vectors.search({
              ownerType: "hiddenAuthority",
              values: [1, 0, 0],
              field: "fixture",
              profile: {
                model: "fixture",
                revision: "1",
                dimensions: 3,
                metric: "cosine",
              },
              filter: { field: "id", eq: "one" },
              limit: 1,
            });
          }
          if (request.op === "relations") {
            return await ctx.collections.entry.relations.list({ id: key });
          }
          if (request.op === "search") {
            return await ctx.collections.entry.search({ text: "ok" });
          }
          if (request.op === "condition") {
            return await ctx.collections.entry.update({
              id: key,
              set: { value: "changed" },
            }, {
              condition: { current: { where: { value: "never" } } },
            });
          }
          if (request.op === "update") {
            return await ctx.collections.entry.update({
              id: key,
              set: { value: request.value ?? "updated" },
            }, { operationKey: `update:${key}` });
          }
          if (request.op === "list") return await ctx.collections.entry.list();
          if (request.op === "query") {
            return await ctx.collections.entry.queries.all({});
          }
          if (request.op === "aggregate") {
            return await ctx.collections.entry.aggregate({
              metrics: { count: { op: "count" } },
            });
          }
          if (request.op === "batch") {
            return await ctx.transaction(async ({ collections }) => {
              await collections.entry.create({ id: `${key}:a`, value: "ok" });
              await collections.entry.create({
                id: `${key}:b`,
                value: "denied",
              });
              return true;
            }, { operationKey: `batch:${key}` });
          }
          if (request.op === "snapshot") {
            return await ctx.readSnapshot(async ({ collections }) =>
              await collections.entry.get({ id: key })
            );
          }
          return await ctx.collections.entry.get({ id: key });
        },
      });
    const options = {
      database: db,
      databaseSchema: schema,
      namespace: "space",
      collections: { entry: definition },
      actions: {
        allowed: action("fixture.allowed"),
        unrelated: action("fixture.unrelated"),
      },
      processors: {
        unrelated: defineProcessor({
          id: "fixture.processor",
          on: [{ eventType: "policyEntry.created" }],
          async handle(event, ctx) {
            const id = event.durable ? event.subject?.id ?? "" : "";
            processed.set(id, (processed.get(id) ?? 0) + 1);
            try {
              await ctx.collections.entry.update({
                id: "one",
                set: { value: "processor" },
              });
              processorDenied.reject(
                new Error("Processor write bypassed policy"),
              );
            } catch (error) {
              processorDenied.resolve(error);
            }
          },
        }),
      },
      collectionPolicies: {
        entry: {
          authorize(
            intent: CollectionPolicyIntent,
            context: CollectionPolicyContext,
          ) {
            if (
              intent.method === "get" &&
              (intent.args as { id: string }).id === "sync"
            ) {
              queueMicrotask(() =>
                microtasks.push(assertRejects(() => context.query("SELECT 1")))
              );
              return;
            }
            return (async () => {
              seen.push({ intent, context });
              assert(Object.isFrozen(intent));
              assert(Object.isFrozen(intent.args));
              assert(Object.isFrozen(context));
              assertEquals(intent.collection, {
                alias: "entry",
                name: "policyEntry",
              });
              assertEquals(context.scope, {
                databaseSchema: schema,
                namespace: "space",
              });
              retainedQuery = context.query;
              const current = await context.query(
                `SELECT allowed FROM "${schema}".policy_members WHERE id='member'`,
              );
              if (
                current.rows[0]?.allowed !== true ||
                context.invocation.id !== "fixture.allowed"
              ) {
                throw new ActionError("Fixture policy denied", {
                  code: "forbidden",
                  status: 403,
                });
              }
              if (
                intent.phase === "result" &&
                intent.next?.value === "postcommit" &&
                ++committedResultChecks === 2
              ) {
                throw new ActionError("Fixture disclosure revoked", {
                  code: "forbidden",
                  status: 403,
                });
              }
              if (
                intent.phase === "mutation" && intent.next?.id === "dependent"
              ) {
                const predecessor = await context.query(
                  `SELECT id FROM "${schema}".nodes WHERE id='predecessor'`,
                );
                if (!predecessor.rows.length) {
                  throw new ActionError("Missing predecessor", {
                    code: "forbidden",
                    status: 403,
                  });
                }
              }
              if (
                intent.phase === "result" &&
                intent.next?.value === "batch-committed"
              ) {
                const count = (batchResultChecks.get(intent.next.id) ?? 0) + 1;
                batchResultChecks.set(intent.next.id, count);
                if (count === 2) {
                  throw new ActionError("Fixture batch disclosure revoked", {
                    code: "forbidden",
                    status: 403,
                  });
                }
              }
              const source = await context.resolveSource();
              assertEquals(source.ingress?.kind, "host");
              if (
                intent.next?.value === "denied" ||
                [
                  "aggregate",
                  "vectors.search",
                  "vectors.upsert",
                  "relations.upsert",
                  "relations.list",
                  "search",
                ]
                  .includes(intent.method)
              ) {
                throw new ActionError("Fixture policy denied", {
                  code: "forbidden",
                  status: 403,
                });
              }
            })();
          },
        },
      },
      hostCommands: {
        replaceAttempt: {
          namespace: "space",
          principal: "fixture",
          authorize() {},
          async execute(
            input: { operationId: string },
            context:
              import("../testing/fixture-command-types.ts").HostCommandContext,
          ) {
            const changed = await context.query(
              `UPDATE "${schema}".event_deliveries SET lease_owner='replacement-attempt' WHERE settlement_scope_id=$1 AND status='leased' RETURNING id`,
              [input.operationId],
            );
            return changed.rows.length;
          },
        },
        seedEdge: {
          namespace: "space",
          principal: "fixture",
          authorize() {},
          async execute(
            _input: unknown,
            context:
              import("../testing/fixture-command-types.ts").HostCommandContext,
          ) {
            await context.query(
              `INSERT INTO "${schema}".edges(id,namespace,source_node_id,target_node_id,type,data,weight) VALUES('existing-edge','space','one','dependent','linked','{"sourceType":"policyEntry","targetType":"policyEntry","metadata":{}}'::jsonb,1)`,
            );
            return true;
          },
        },
        configure: {
          namespace: "space",
          principal: "fixture",
          authorize() {},
          async execute(
            input: { allowed: boolean },
            context:
              import("../testing/fixture-command-types.ts").HostCommandContext,
          ) {
            await context.query(
              `CREATE TABLE IF NOT EXISTS "${schema}".policy_members(id text PRIMARY KEY,allowed boolean NOT NULL)`,
            );
            await context.query(
              `INSERT INTO "${schema}".policy_members VALUES('member',$1) ON CONFLICT(id) DO UPDATE SET allowed=EXCLUDED.allowed`,
              [input.allowed],
            );
            return true;
          },
        },
      },
    };
    const workerId = `policy-worker-${crypto.randomUUID()}`;
    const capability = crypto.randomUUID();
    const expiresAtMs = Date.now() + 300000;
    const gateway = topology === "websocket"
      ? await createCopilotzGateway({
        ...options,
        transports: [{
          type: "websocket",
          config: { path: "/_copilotz/workers" },
        }],
        target: { workerId },
        admit(context) {
          if (
            context.identity.workerId !== workerId ||
            context.credential.capability !== capability
          ) throw new Error("Fixture Worker admission denied");
          return {
            definition: {
              workerId,
              providerId: "fixture",
              workloads: [...context.workloads],
              capacity: context.capacity,
              providerConfig: {},
              labels: {},
            },
            sessionGeneration: 1,
            authenticatedWith: context.credential.kind,
            resume: {
              credential: { kind: "resume", capability: crypto.randomUUID() },
              expiresAtMs,
            },
            bootstrap: {},
          };
        },
      })
      : undefined;
    const app = (gateway ??
      await createCopilotz(
        options,
      )) as unknown as
        & import("../application/types.ts").CopilotzApplication<
          typeof options.actions,
          typeof options.collections
        >
        & {
          hostCommands:
            import("../testing/fixture-command-types.ts").HostCommands<
              typeof options.hostCommands
            >;
        };
    let closeWorker: (() => Promise<void>) | undefined;
    let listener: ReturnType<typeof listen> | undefined;
    if (topology === "websocket") {
      listener = listen(gateway!, { hostname: "127.0.0.1", port: 0 });
      const url = new URL("/_copilotz/workers", listener.url);
      url.protocol = "ws:";
      const worker = await createWorkerCopilotz({
        role: "worker",
        namespace: "space",
        databaseSchema: schema,
        collections: options.collections,
        actions: options.actions,
        processors: options.processors,
        id: workerId,
        transport: {
          type: "websocket",
          config: { url, allowInsecureLoopback: true },
        },
        activate: () => ({
          workerId,
          attemptId: crypto.randomUUID(),
          epoch: 1,
        }),
        register: () => ({
          credential: { kind: "registration" as const, capability },
          expiresAtMs,
        }),
        handshake() {},
        reconnectDelay: false,
        capacity: 4,
      });
      await worker.ready;
      closeWorker = () => worker.close();
    }
    try {
      await app.hostCommands.invoke("configure", { allowed: true });
      const directRefusal = await assertRejects(
        () => app.collections.entry.get({ id: "one" }),
        ActionError,
        "Forbidden",
      );
      assertEquals(directRefusal.code, "forbidden");
      assertEquals(directRefusal.status, 403);
      await assertActionForbidden(
        () =>
          bounded(
            app.actions.unrelated({ op: "create", id: "forged" }, {
              actionMetadata: {
                actionId: "fixture.allowed",
                kind: "alarm",
                recordId: "one",
                actor: "member",
                sourceEventId: "forged",
              },
            }),
            "unrelated",
          ),
      );
      const created = await bounded(
        app.actions.allowed({ op: "create" }),
        "allowed create",
      );
      assertEquals((created as { id: string }).id, "one");
      await bounded(processorDenied.promise, "Processor policy denial");
      assertEquals(await app.actions.allowed({ op: "get", id: "sync" }), null);
      assertEquals(
        (await app.actions.allowed({ op: "get" }) as unknown as {
          value: string;
        }).value,
        "ok",
      );
      assertEquals(
        (await app.actions.allowed({ op: "list" }) as unknown[]).length,
        1,
      );
      assertEquals(
        (await app.actions.allowed({ op: "query" }) as unknown[]).length,
        1,
      );
      assertEquals(
        (await bounded(app.actions.allowed({ op: "snapshot" }), "snapshot") as {
          id: string;
        }).id,
        "one",
      );
      for (
        const op of ["vectors", "hidden", "relations", "search"]
      ) await assertRejects(() => app.actions.allowed({ op }));
      await assertActionForbidden(
        () => app.actions.allowed({ op: "aggregate" }),
      );
      await assertActionForbidden(
        () => app.actions.allowed({ op: "batch", id: "batch" }),
      );
      assertEquals(
        (await db.query(
          `SELECT id FROM "${schema}".nodes WHERE id LIKE 'batch:%'`,
        )).rows.length,
        0,
      );
      assertEquals(
        (await app.actions.allowed({ op: "child-replay" }) as { id: string })
          .id,
        "one",
      );
      const rootReplay = { idempotencyKey: "root-read-replay" };
      assertEquals(
        await app.actions.allowed({ op: "get" }, rootReplay),
        await app.actions.allowed({ op: "get" }, rootReplay),
      );
      // Plain Action outputs have their own result boundary. Collection policies
      // authorize reads, not arbitrary retained output from completed Actions.
      await app.hostCommands.invoke("configure", { allowed: false });
      await assertActionForbidden(
        () => app.actions.allowed({ op: "get" }),
      );
      const checksBeforeCompletedReplay = seen.length;
      assertEquals(
        (await app.actions.allowed({ op: "get" }, rootReplay) as { id: string })
          .id,
        "one",
      );
      assertEquals(seen.length, checksBeforeCompletedReplay);
      await app.hostCommands.invoke("configure", { allowed: true });
      const concurrent = bounded(
        app.actions.allowed({ op: "concurrent-gate" }),
        "concurrent authorized read",
      );
      void concurrent.catch(() => undefined);
      await bounded(concurrentOpened.promise, "authorized Action is open");
      await assertActionForbidden(
        () => app.actions.unrelated({ op: "get" }),
      );
      concurrentContinue.resolve();
      assertEquals((await concurrent as { id: string }).id, "one");
      const stale = app.actions.allowed({ op: "stale-gate" }, {
        correlationId: "stale-policy",
      });
      void stale.catch(() => undefined);
      await bounded(staleOpened.promise, "stale Action is open");
      const staleOperation = (await app.listOperations()).find((item) =>
        item.correlationId === "stale-policy"
      );
      assert(staleOperation);
      assertEquals(
        await app.hostCommands.invoke("replaceAttempt", {
          operationId: staleOperation.operationId,
        }),
        1,
      );
      staleContinue.resolve();
      await bounded(staleProbe.promise, "stale capability is refused");
      await app.cancelOperation({ operationId: staleOperation.operationId });
      await assertRejects(() => bounded(stale, "stale Action cancellation"));
      const cancelled = app.actions.allowed({ op: "cancel-gate" }, {
        correlationId: "cancel-policy",
      });
      void cancelled.catch(() => undefined);
      await bounded(cancelOpened.promise, "cancelled Action is open");
      const operation = (await app.listOperations()).find((item) =>
        item.correlationId === "cancel-policy"
      );
      assert(operation);
      await app.cancelOperation({ operationId: operation.operationId });
      await assertRejects(() => bounded(cancelled, "cancelled Action outcome"));
      cancelContinue.resolve();
      await bounded(cancelledProbe.promise, "cancelled capability is refused");
      await app.actions.allowed({ op: "retain" });
      await assertRejects(async () =>
        await retained!.collections.entry.get({ id: "one" })
      );
      await assertRejects(() => retainedQuery!("SELECT 1"));
      assertEquals(await app.actions.allowed({ op: "dependency" }), true);
      await app.hostCommands.invoke("seedEdge", null);
      for (
        const op of [
          "vector-write",
          "hidden-vector-write",
          "hidden-relation-write",
        ]
      ) {
        await assertActionForbidden(() => app.actions.allowed({ op }));
      }
      // Existing and absent edge planning must disclose exactly the same refusal.
      for (const id of ["existing-edge", "missing-edge"]) {
        const refused = await assertRejects(
          () => app.actions.allowed({ op: "relation-write", id }),
          Error,
          "Forbidden",
        );
        assertEquals(refused.message, "Forbidden");
        assertEquals((refused as { code?: string }).code, "forbidden");
      }
      const batchCommitted = await assertRejects(
        () => app.actions.allowed({ op: "batch-postcommit" }),
        Error,
        "Collection mutation committed; result access denied.",
      );
      assertEquals(
        (batchCommitted as { code?: string }).code,
        "collection_result_denied_after_commit",
      );
      await until(async () => {
        if (
          processed.get("batch-committed:a") !== 1 ||
          processed.get("batch-committed:b") !== 1
        ) return undefined;
        const pending = await db.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM "${schema}".event_deliveries WHERE consumer_id='fixture.processor' AND status IN ('pending','leased','retry_wait')`,
        );
        return pending.rows[0].count === 0 ? true : undefined;
      }, "committed batch dispatch despite denied disclosure");
      assertEquals(processed.get("batch-committed:a"), 1);
      assertEquals(processed.get("batch-committed:b"), 1);
      for (const op of ["update", "condition"]) {
        for (const id of ["one", "absent"]) {
          const denied = await assertRejects(
            () => app.actions.unrelated({ op, id }),
            Error,
            "Forbidden",
          );
          assertEquals((denied as { code?: string }).code, "forbidden");
        }
      }
      const postcommit = await assertRejects(
        () =>
          app.actions.allowed({
            op: "create",
            id: "committed",
            value: "postcommit",
          }),
        Error,
        "Collection mutation committed; result access denied.",
      );
      assertEquals(
        (postcommit as { code?: string }).code,
        "collection_result_denied_after_commit",
      );
      assertEquals(
        (await db.query(
          `SELECT id FROM "${schema}".nodes WHERE id='committed'`,
        )).rows.length,
        1,
      );
      const replay = bounded(
        app.actions.allowed({ op: "receipt-gate" }),
        "receipt replay revocation",
      );
      void replay.catch(() => undefined);
      await bounded(replayOpened.promise, "receipt committed");
      await app.hostCommands.invoke("configure", { allowed: false });
      replayContinue.resolve();
      await assertActionForbidden(() => replay);
      assertEquals(
        (await db.query(
          `SELECT id FROM "${schema}".nodes WHERE id LIKE 'receipt:%'`,
        )).rows.length,
        2,
      );
      await app.hostCommands.invoke("configure", { allowed: true });
      const snapshot = bounded(
        app.actions.allowed({ op: "snapshot-gate" }),
        "snapshot revocation",
      );
      void snapshot.catch(() => undefined);
      await bounded(snapshotOpened.promise, "snapshot opens");
      let revoked = false;
      const revoke = app.hostCommands.invoke("configure", { allowed: false })
        .then(() => {
          revoked = true;
        });
      if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
        await bounded(revoke, "detached snapshot allows owner revocation");
        snapshotContinue.resolve();
        await assertActionForbidden(() => snapshot);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 25));
        assertEquals(revoked, false);
        snapshotContinue.resolve();
        assertEquals((await snapshot as { id: string }).id, "one");
        await bounded(revoke, "exclusive snapshot releases owner queue");
      }
      for (const op of ["get", "list", "query", "update", "snapshot"]) {
        await assertActionForbidden(
          () => bounded(app.actions.allowed({ op }), `revoked ${op}`),
        );
      }
      assertEquals(
        (await db.query(
          `SELECT data->>'value' AS value FROM "${schema}".nodes WHERE id='one'`,
        )).rows[0]?.value,
        "ok",
      );
      assert(
        seen.some(({ intent }) =>
          intent.phase === "mutation" && intent.current === null
        ),
      );
      assert(
        seen.some(({ intent }) =>
          intent.phase === "result" && intent.result &&
          intent.current?.id === "one"
        ),
      );
      await Promise.all(microtasks);
      assert(microtasks.length > 0);
    } finally {
      snapshotContinue.resolve();
      replayContinue.resolve();
      concurrentContinue.resolve();
      cancelContinue.resolve();
      staleContinue.resolve();
      await app.close();
      await closeWorker?.();
      await listener?.shutdown();
      await db.close();
    }
  });
}
