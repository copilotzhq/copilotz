import { ActionError } from "./errors.ts";
import { createContentPreparer } from "../content/preparer.ts";
import { validateCollectionPolicies } from "../collections/policy-registration.ts";
import type { CollectionPolicy } from "../collections/policy-types.ts";
import {
  collectionAssetAdopterFor,
  createDatabaseAssetRepository,
} from "../content/database-repository.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  bounded,
  commitProxy,
  localPostgresUrl,
} from "../testing/effect-commit-proxy.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createCollectionRuntime } from "../collections/kernel.ts";
import { defineCollection } from "../collections/definition.ts";
import { createBodyStorageRuntime } from "../content/storage.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { createProtectedValueRuntime } from "./protected-value.ts";
import { createProtectedActions } from "./protected-actions.ts";
import { createOwnerEffectClient } from "./effect-commands.ts";
import { createActionLifecycleAppender } from "./persistence.ts";
import { assertEventCommitted } from "../events/store.ts";
import { defineAction } from "./define.ts";
import { secret } from "./secret.ts";
import type { ActionInvocationFrame } from "./invoker.ts";
import type { ProtectedActionAdoptionContext } from "./protected-action-types.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const job = defineCollection({
  name: "adoption_job",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      name: { type: "string" },
      dueAt: { type: "string" },
      content: {},
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "name", "dueAt"],
  } as const,
  content: { fields: ["content"] },
  alarm: {
    deadline: (record) => record.dueAt as string,
    command: (record) => ({
      name: "touch",
      key: `wake:${record.id}`,
      input: {},
    }),
  },
  commands: { touch: { mutate: () => ({ set: { name: "touched" } }) } },
});
const action = defineAction({
  id: "fixture.adopt-job",
  ownerHooks: { prepareInput: true, acceptOutput: true },
  inputSchema: {
    type: "object",
    properties: { credential: secret({ type: "string" }) },
    additionalProperties: false,
  } as const,
  outputSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  } as const,
  execute: () => ({ ok: true }),
});
const frame = (id = "run"): ActionInvocationFrame => ({
  actionId: action.id,
  actionRunId: id,
  rootKey: id,
  operationKey: id,
  metadata: {},
  signal: new AbortController().signal,
  nextActionIndex: () => 1,
});
async function fixture(db?: TestDatabase, schema?: string) {
  db ??= await createTestDatabase({ url: url!, pgPoolMax: 1 });
  schema ??= `adopt_collections_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const store = createEventStore({ session: db, schema });
  const source = await store.commitMutation({
    draft: {
      namespace: "space",
      type: "fixture.request",
      payload: {
        dataRef: {
          eventBodyId: `source:${schema}`,
          schemaVersion: 1,
          mediaType: "application/json",
        },
      },
    },
    body: { id: `source:${schema}`, json: { member: "member" } },
    consumers: [],
  });
  let publications = 0;
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({ ...input, consumers: [] }),
        dispatch: { handles: [], failures: [] },
      };
    },
    flushCommitted(result) {
      assertEventCommitted(result.event);
      publications++;
      return Promise.resolve({ handles: [], failures: [] });
    },
    append() {
      throw new Error("unused");
    },
    recover() {
      throw new Error("unused");
    },
  };
  const adapter = await testSecretAdapter();
  const values = createProtectedValueRuntime({
    session: db,
    databaseSchema: schema,
    storage: createBodyStorageRuntime({}),
    adapter,
  });
  const assets = createDatabaseAssetRepository({
    session: db,
    eventStore: store,
    databaseSchema: schema,
    coordinator,
  });
  const build = (
    accept: (context: ProtectedActionAdoptionContext) => void | Promise<void>,
    policy?: CollectionPolicy["authorize"],
  ) => {
    const collections = createCollectionRuntime({
      session: db!,
      eventStore: store,
      coordinator,
      assets: collectionAssetAdopterFor(assets),
      policies: validateCollectionPolicies({
        jobs: {
          async authorize(intent, ctx) {
            assertEquals(ctx.scope, {
              databaseSchema: schema,
              namespace: "space",
            });
            assertEquals(ctx.invocation.kind, "action");
            assertEquals(ctx.invocation.id, action.id);
            assertEquals((await ctx.resolveSource()).data, {
              member: "member",
            });
            await policy?.(intent, ctx);
          },
        },
      }, { jobs: job }),
    });
    collections.bind(job);
    return createProtectedActions({
      definitions: {
        [action.id]: {
          authorize(_input, context) {
            assert(!("collections" in context));
          },
          prepareInput(_input, context) {
            assert(!("collections" in context));
            return { credential: "synthetic-credential" };
          },
          acceptOutput(_output, context) {
            return accept(context);
          },
        },
      },
      actions: { action },
      store,
      coordinator,
      namespace: "space",
      source: { eventId: source.event.id },
      signal: new AbortController().signal,
      protectedValues: values,
      collections: { runtime: collections, definitions: { jobs: job } },
    });
  };
  const complete = (hooks: ReturnType<typeof build>, f = frame()) =>
    createActionLifecycleAppender({
      store,
      coordinator,
      actions: { action },
      protectedValues: values,
      protectedActionOutput: () => hooks.output(f),
    })({
      draft: {
        namespace: "space",
        type: `${action.id}.completed`,
        subject: { type: action.id, id: f.actionRunId },
        metadata: { actionId: action.id, actionStatus: "completed" },
        deduplicationId: `${f.actionRunId}:action:terminal`,
      },
      data: {
        status: "completed",
        actionId: action.id,
        actionRunId: f.actionRunId,
        metadata: {},
        input: { credential: "synthetic-credential" },
        output: { ok: true },
      },
    });
  const client = (hooks: ReturnType<typeof build>, f = frame()) =>
    createOwnerEffectClient({
      session: db!,
      schema: schema!,
      namespace: "space",
      actionRunId: f.actionRunId,
      signal: f.signal,
      output: { action, protectedValues: values, ...hooks.output(f) },
    });
  const count = async (type: string) =>
    Number(
      (await db!.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${schema}".nodes WHERE type=$1`,
        [type],
      )).rows[0].n,
    );
  return {
    db,
    schema,
    store,
    values,
    adapter,
    assets,
    build,
    complete,
    client,
    count,
    publications: () => publications,
  };
}
const createJob = (ctx: ProtectedActionAdoptionContext, id = "job") =>
  ctx.collections.jobs.create({
    id,
    name: "job",
    dueAt: "2099-01-01T00:00:00.000Z",
  });
Deno.test({
  name:
    "acceptance joins registered Collection writes, alarms and hidden records once; public handles revoke before microtasks",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let retained: ProtectedActionAdoptionContext | undefined;
    let rejected: Promise<unknown> | undefined;
    let accepted = 0;
    try {
      const hooks = f.build((ctx) => {
        retained = ctx;
        accepted++;
        assertEquals(Object.keys(ctx.collections), ["jobs"]);
        void ctx.query(
          `INSERT INTO "${f.schema}".nodes(id,namespace,type,name) VALUES('delegation','space','delegation','hidden')`,
        );
        void createJob(ctx);
        queueMicrotask(() => {
          rejected = assertRejects(
            () => createJob(ctx, "late"),
            Error,
            "closed",
          );
        });
      });
      await hooks.prepareInput(frame(), {});
      const before = f.publications();
      const c = f.client(hooks);
      await c.begin("provider");
      await c.confirmOutput("provider", { ok: true });
      await rejected;
      await c.confirmOutput("provider", { ok: true });
      await f.complete(hooks);
      assertEquals(accepted, 1);
      assertEquals(await f.count(job.name), 1);
      assertEquals(await f.count("delegation"), 1);
      assert(f.publications() > before);
      assertEquals(
        (await f.db.query(
          `SELECT key FROM "${f.schema}".owner_deadlines WHERE source='collection:adoption_job'`,
        )).rows.length,
        1,
      );
      await assertRejects(
        () =>
          retained!.collections.jobs.update({
            id: "job",
            set: { name: "late" },
          }),
        Error,
        "closed",
      );
      const other = frame("ordinary");
      const normal = f.build((ctx) => createJob(ctx, "normal").then(() => {}));
      await normal.prepareInput(other, {});
      await f.complete(normal, other);
      await f.complete(normal, other);
      assertEquals(await f.count(job.name), 2);
    } finally {
      await f.db.close();
    }
  },
});
Deno.test({
  name:
    "acceptance failure rolls back hidden state, staged Collection, alarm and publication in both mutation orders",
  ignore: !url,
  async fn() {
    for (const order of ["hidden-first", "collection-first"]) {
      const f = await fixture();
      try {
        const hooks = f.build(async (ctx) => {
          const hidden = () =>
            ctx.query(
              `INSERT INTO "${f.schema}".nodes(id,namespace,type,name) VALUES('delegation','space','delegation','hidden')`,
            );
          if (order === "hidden-first") {
            await hidden();
            await createJob(ctx);
          } else {
            await createJob(ctx);
            await hidden();
          }
          throw new Error("synthetic-credential");
        });
        await hooks.prepareInput(frame(), {});
        const c = f.client(hooks);
        await c.begin("provider");
        const before = f.publications();
        const error = await assertRejects(() =>
          c.confirmOutput("provider", { ok: true })
        );
        assert(error instanceof Error);
        assert(!error.message.includes("synthetic-credential"));
        assertEquals(await f.count(job.name), 0);
        assertEquals(await f.count("delegation"), 0);
        assertEquals(f.publications(), before);
        assertEquals(
          (await f.db.query(
            `SELECT key FROM "${f.schema}".owner_deadlines WHERE source='collection:adoption_job'`,
          )).rows.length,
          0,
        );
        assertEquals(
          (await f.db.query(
            `SELECT key FROM "${f.schema}".owner_receipts WHERE kind='action.output.capture'`,
          )).rows.length,
          0,
        );
      } finally {
        await f.db.close();
      }
    }
  },
});
Deno.test({
  name:
    "lost acceptance COMMIT leaves one registered Collection adoption and alarm; receipt replay does not repeat mutation",
  ignore: !url,
  async fn() {
    const proxy = await commitProxy(localPostgresUrl(url!));
    const proxied = await createTestDatabase({ url: proxy.url, pgPoolMax: 1 });
    const f = await fixture(proxied);
    let next: TestDatabase | undefined;
    let accepted = 0;
    try {
      const hooks = f.build(async (ctx) => {
        accepted++;
        await createJob(ctx);
        proxy.arm();
      });
      await hooks.prepareInput(frame(), {});
      const c = f.client(hooks);
      await c.begin("provider");
      const reject = assertRejects(() =>
        c.confirmOutput("provider", { ok: true })
      );
      await bounded(proxy.forwarded, "adoption commit forwarded");
      assertEquals(
        await bounded(proxy.resolved, "adoption commit resolved"),
        "COMMIT",
      );
      proxy.cutClient();
      assertEquals(
        (await bounded(reject, "adoption commit response") as { code?: string })
          .code,
        "owner_commit_unknown",
      );
      next = await createTestDatabase({
        url: localPostgresUrl(url!),
        pgPoolMax: 1,
      });
      assertEquals(
        (await next.query(
          `SELECT id FROM "${f.schema}".nodes WHERE type='adoption_job'`,
        )).rows.length,
        1,
      );
      assertEquals(
        (await next.query(
          `SELECT key FROM "${f.schema}".owner_deadlines WHERE source='collection:adoption_job'`,
        )).rows.length,
        1,
      );
      const recoveredValues = createProtectedValueRuntime({
        session: next,
        databaseSchema: f.schema,
        storage: createBodyStorageRuntime({}),
        adapter: f.adapter,
      });
      const recovery = createOwnerEffectClient({
        session: next,
        schema: f.schema,
        namespace: "space",
        actionRunId: "run",
        signal: frame().signal,
        output: {
          action,
          protectedValues: recoveredValues,
          authorize: async () => {},
          accept: () => Promise.reject(new Error("must not adopt twice")),
        },
      });
      assertEquals(await recovery.inspect("provider"), {
        status: "replay",
        outcome: { ok: true },
      });
      await recovery.confirmOutput("provider", { ok: true });
      assertEquals(accepted, 1);
      assertEquals(proxy.errors, []);
    } finally {
      await proxy.close();
      await next?.close();
      await proxied.close();
    }
  },
});

Deno.test({
  name:
    "adoption result-policy refusal rolls back staged SQL; policy cannot recursively use mutation handles",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let retained: ProtectedActionAdoptionContext | undefined;
    let recursive = false;
    try {
      const hooks = f.build(async (ctx) => {
        retained = ctx;
        await createJob(ctx);
      }, async (intent) => {
        if (!recursive) {
          recursive = true;
          await assertRejects(() => createJob(retained!, "nested"), Error);
        }
        if (intent.phase === "result") {
          throw new ActionError("private policy detail", {
            code: "forbidden",
            status: 403,
          });
        }
      });
      await hooks.prepareInput(frame(), {});
      const c = f.client(hooks);
      await c.begin("provider");
      const before = f.publications();
      const refusal = await assertRejects(() =>
        c.confirmOutput("provider", { ok: true })
      );
      assert(refusal instanceof Error);
      assert(!refusal.message.includes("private policy detail"));
      assertEquals(await f.count(job.name), 0);
      assertEquals(f.publications(), before);
      assertEquals(
        (await f.db.query(
          `SELECT key FROM "${f.schema}".owner_receipts WHERE kind='action.output.capture'`,
        )).rows.length,
        0,
      );
    } finally {
      await f.db.close();
    }
  },
});
Deno.test({
  name:
    "adoption accepts current namespace canonical assets and refuses raw, pending, absent or cross-namespace references",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      const good = await f.assets.materialize({
        namespace: "space",
        content: await createContentPreparer().prepare({
          type: "text",
          text: "public scheduled message",
        }, { namespace: "space" }),
      });
      const other = await f.assets.materialize({
        namespace: "other",
        content: await createContentPreparer().prepare({
          type: "text",
          text: "other namespace message",
        }, { namespace: "other" }),
      });
      for (
        const [index, content] of [
          good,
          { type: "text", text: "new raw message" },
          [{
            pendingRef: "foreign",
            mediaType: "text/plain",
            digest: "sha256:wrong",
            byteLength: 1,
          }],
          [{ ...good[0], assetId: "absent" }],
          other,
        ].entries()
      ) {
        const run = frame(`content-${index}`);
        const hooks = f.build(async (ctx) => {
          await ctx.collections.jobs.create({
            id: `job-${index}`,
            name: "job",
            dueAt: "2099-01-01T00:00:00.000Z",
            content,
          });
        });
        await hooks.prepareInput(run, {});
        const c = f.client(hooks, run);
        await c.begin("provider");
        if (index === 0) await c.confirmOutput("provider", { ok: true });
        else {await assertRejects(() =>
            c.confirmOutput("provider", { ok: true })
          );}
      }
      assertEquals(await f.count(job.name), 1);
    } finally {
      await f.db.close();
    }
  },
});

Deno.test({
  name:
    "joined result policy checks staged SQL before acceptance and denial rolls it back without postcommit classification",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let sawStaged = false;
    try {
      const hooks = f.build(async (ctx) => {
        await createJob(ctx);
      }, async (intent, ctx) => {
        if (intent.phase === "result") {
          const row = await ctx.query(
            `SELECT id FROM "${f.schema}".nodes WHERE type='adoption_job'`,
          );
          sawStaged = row.rows.length === 1;
          throw new ActionError("domain private denial", {
            code: "forbidden",
            status: 403,
          });
        }
      });
      await hooks.prepareInput(frame(), {});
      const c = f.client(hooks);
      await c.begin("provider");
      const before = f.publications();
      const error = await assertRejects(() =>
        c.confirmOutput("provider", { ok: true })
      );
      assert(sawStaged);
      assertEquals((error as { code?: string }).code, "forbidden");
      assertEquals(await f.count(job.name), 0);
      assertEquals(f.publications(), before);
    } finally {
      await f.db.close();
    }
  },
});
