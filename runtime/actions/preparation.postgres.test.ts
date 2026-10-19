import { ActionError } from "./errors.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { withOwnerCommandAuthorization } from "../engine/command-authorization.ts";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { defineView } from "../views/definition.ts";
import { defineAction } from "./define.ts";
import { secret } from "./secret.ts";
import {
  type ActionPreparations,
  compileActionPreparations,
  createNamedPreparations,
  preparationReceiptKey,
} from "./preparation.ts";
import type { ActionInvocationFrame } from "./invoker.ts";
import type { ContentResolver } from "../content/resolver.ts";
import type { PreparationSourceReference } from "./preparation-capture.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const namespace = "space";
const request = { preparation: "note", recordId: "record", mode: "context" };
const frame = (run = "run"): ActionInvocationFrame => ({
  actionId: "fixture.prepared",
  actionRunId: run,
  rootKey: "root",
  operationKey: run,
  metadata: {},
  signal: new AbortController().signal,
  nextActionIndex: () => 1,
});
async function fixture() {
  const db = await createTestDatabase({ url, pgPoolMax: 4 });
  const schema = `preparation_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const store = createEventStore({ session: db, schema });
  const root = await store.commitMutation({
    draft: {
      namespace,
      type: "fixture.request",
      payload: {
        dataRef: {
          eventBodyId: "request",
          schemaVersion: 1,
          mediaType: "application/json",
        },
      },
    },
    body: { id: "request", json: { actor: "member" } },
    consumers: [],
  });
  const run = createSchemaCommandRunner(db, schema);
  const change = (sql: string, params: unknown[] = []) =>
    run("fixture.change", {}, async (_, ctx) => {
      await ctx.transaction.query(sql, params);
    });
  await change(
    `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('record','space','note','record',$1::jsonb),('member','space','member','member','{}')`,
    [JSON.stringify({
      title: "first",
      audience: "member",
      credential: "must-never-enter-view",
    })],
  );
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({ ...input, consumers: [] }),
        dispatch: { handles: [], failures: [] },
      };
    },
    flushCommitted() {
      return Promise.resolve({ handles: [], failures: [] });
    },
    append() {
      throw new Error("unused");
    },
    recover() {
      throw new Error("unused");
    },
  };
  let renders = 0, projections = 0, mappings = 0, resourceProjections = 0;
  let permitted = true,
    viewPermitted = true,
    resourcePermitted = true,
    failMapping = false,
    invalidInput = false;
  const seen: Array<
    { purpose: string; reference: PreparationSourceReference }
  > = [];
  const action = defineAction({
    id: "fixture.prepared",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    } as const,
    execute: (input: { text: string }) => input.text,
  });
  const records = defineCollection({
    name: "note",
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        audience: { type: "string" },
        credential: secret({ type: "string" }),
      },
    } as const,
  });
  const resources = { presentation: { style: { prefix: "original" } } };
  const registry = createPluginRegistry({
    actions: { child: action },
    collections: { records },
    resources,
    views: {
      note: defineView({
        id: "fixture.note",
        shows: "note",
        renderer: "text",
        modes: ["context"],
        render: (value: unknown, ctx) => {
          renders++;
          assert(!JSON.stringify(value).includes("must-never"));
          return `${
            (ctx.resources.presentation.style as { prefix: string }).prefix
          }:${(value as { record: { title: string } }).record.title}`;
        },
      }),
    },
  });
  const config: ActionPreparations = {
    registrations: {
      note: {
        source: "notes",
        actionAlias: "child",
        shows: "note",
        modes: ["context"],
        resources: [{ namespace: "presentation", alias: "style" }],
        mapInput(text) {
          mappings++;
          if (failMapping) throw new Error("injected mapping failure");
          return invalidInput ? { wrong: text } : { text };
        },
      },
    },
    source: {
      sources: { notes: { collectionAlias: "records", fields: ["/title"] } },
      authorize(_tx, { binding }) {
        assertEquals(binding.sourceEventId, root.event.id);
        return { namespace, audience: "member" };
      },
      projectRecord(record) {
        projections++;
        assertEquals(Object.keys(record), ["title"]);
        return record;
      },
      async authorizeOriginal(tx, input) {
        seen.push({ purpose: input.purpose, reference: input.reference });
        const membership = await tx.query(
          `SELECT id FROM "${schema}".nodes WHERE type='member'`,
        );
        const record = await tx.query<{ data: { audience: string } }>(
          `SELECT data FROM "${schema}".nodes WHERE id='record' AND namespace=$1`,
          [namespace],
        );
        return permitted && membership.rows.length === 1 &&
          record.rows[0]?.data.audience === "member";
      },
    },
    projectResource(_tx, { value }) {
      resourceProjections++;
      return value as { prefix: string };
    },
    authorizeResource() {
      if (!resourcePermitted) throw new Error("original resource denied");
      return true;
    },
    authorizeView() {
      return viewPermitted;
    },
  };
  const content: ContentResolver = {
    authorize: () => Promise.resolve(),
    get() {
      throw new Error("unexpected content");
    },
    getMany(refs) {
      assertEquals(refs, []);
      return Promise.resolve([]);
    },
    open() {
      throw new Error("unexpected content");
    },
  };
  const build = (
    override: Partial<ActionPreparations> = {},
    collectionPolicies?:
      import("../collections/policy-registration.ts").CollectionPolicyRegistrations,
  ) =>
    createNamedPreparations({
      compiled: compileActionPreparations(registry, { ...config, ...override }),
      collectionPolicies,
      registry,
      store,
      coordinator,
      namespace,
      source: { eventId: root.event.id },
      content,
      signal: new AbortController().signal,
    });
  return {
    db,
    schema,
    store,
    root,
    coordinator,
    run,
    change,
    registry,
    resources,
    config,
    build,
    hooks: build(),
    seen,
    stats: () => ({ renders, projections, mappings, resourceProjections }),
    set: (
      value: Partial<
        {
          permitted: boolean;
          viewPermitted: boolean;
          resourcePermitted: boolean;
          failMapping: boolean;
          invalidInput: boolean;
        }
      >,
    ) => {
      permitted = value.permitted ?? permitted;
      viewPermitted = value.viewPermitted ?? viewPermitted;
      resourcePermitted = value.resourcePermitted ?? resourcePermitted;
      failMapping = value.failMapping ?? failMapping;
      invalidInput = value.invalidInput ?? invalidInput;
    },
  };
}
Deno.test({
  name:
    "named preparation atomically captures once and reauthorizes original fields, resources and View",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      const [one, two] = await Promise.all([
        f.hooks.prepare(frame(), request),
        f.hooks.prepare(frame(), request),
      ]);
      assertEquals(one, two);
      assertEquals(one.input, { text: "original:first" });
      assertEquals(f.stats(), {
        renders: 1,
        projections: 1,
        mappings: 1,
        resourceProjections: 1,
      });
      assertEquals(f.seen[0].reference.source.fields, ["/title"]);
      await f.change(
        `UPDATE "${f.schema}".nodes SET data=jsonb_set(data,'{title}','"now public"') WHERE id='record'`,
      );
      f.resources.presentation.style.prefix = "replacement";
      const restarted = f.build();
      assertEquals(
        (await restarted.prepare(frame(), request)).input,
        one.input,
      );
      assertEquals(f.stats(), {
        renders: 1,
        projections: 1,
        mappings: 1,
        resourceProjections: 1,
      });
      for (
        const purpose of ["claim", "input", "mutation", "result"] as const
      ) await restarted.authorize(frame(), purpose);
      assert(f.seen.some((item) => item.purpose === "duplicate"));
      assert(
        f.seen.every((item) =>
          item.reference.source.digest === f.seen[0].reference.source.digest
        ),
      );
      await assertRejects(
        () => f.hooks.prepare(frame(), { ...request, recordId: "other" }),
        Error,
        "owner_intent_conflict",
      );
      f.set({ permitted: false });
      await assertRejects(
        () => restarted.prepare(frame(), request),
        Error,
        "preparation_reference_forbidden",
      );
      f.set({ permitted: true, resourcePermitted: false });
      await assertRejects(
        () => restarted.authorize(frame(), "input"),
        Error,
        "original resource denied",
      );
      f.set({ resourcePermitted: true, viewPermitted: false });
      await assertRejects(
        () => restarted.authorize(frame(), "result"),
        Error,
        "preparation_view_forbidden",
      );
      f.set({ viewPermitted: true });
      await f.change(
        `UPDATE "${f.schema}".nodes SET data=jsonb_set(data,'{audience}','"other"') WHERE id='record'`,
      );
      await assertRejects(
        () => restarted.authorize(frame(), "claim"),
        Error,
        "preparation_reference_forbidden",
      );
      await f.change(
        `UPDATE "${f.schema}".nodes SET data=jsonb_set(data,'{audience}','"member"') WHERE id='record'`,
      );
      await f.change(`DELETE FROM "${f.schema}".nodes WHERE type='member'`);
      await assertRejects(
        () => restarted.authorize(frame(), "mutation"),
        Error,
        "preparation_reference_forbidden",
      );
    } finally {
      await f.db.close();
    }
  },
});
Deno.test({
  name:
    "named preparation rejects forged selectors, snapshots registration, rolls back invalid child capture and guards mutations",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      let getter = 0;
      assertThrows(() =>
        compileActionPreparations(f.registry, {
          ...f.config,
          get registrations() {
            getter++;
            return f.config.registrations;
          },
        })
      );
      assertEquals(getter, 0);
      await assertRejects(() =>
        f.hooks.prepare(frame(), { ...request, grant: true } as never)
      );
      await assertRejects(
        () => f.hooks.prepare({ ...frame(), actionId: "other" }, request),
        Error,
        "preparation_forbidden",
      );
      await assertRejects(
        () => f.hooks.prepare(frame(), { ...request, mode: "unknown" }),
        Error,
        "preparation_renderer_unavailable",
      );
      f.set({ failMapping: true });
      await assertRejects(
        () => f.hooks.prepare(frame(), request),
        Error,
        "injected mapping failure",
      );
      f.set({ failMapping: false, invalidInput: true });
      await assertRejects(() => f.hooks.prepare(frame(), request));
      assertEquals(
        (await f.db.query(
          `SELECT count(*)::int AS n FROM "${f.schema}".events WHERE deduplication_id=$1`,
          ["run:action:invoked"],
        )).rows[0].n,
        0,
      );
      f.set({ invalidInput: false });
      await f.hooks.prepare(frame(), request);
      await assertRejects(
        () =>
          withOwnerCommandAuthorization(
            (command, purpose) =>
              f.hooks.authorize(frame(), purpose, command.transaction),
            () =>
              f.run("test.mutation", {}, async (_, ctx) => {
                await ctx.transaction.query(
                  `INSERT INTO "${f.schema}".nodes(id,namespace,type,name) VALUES('rolled-back','space','proof','proof')`,
                );
                f.set({ permitted: false });
              }),
          ),
        Error,
        "preparation_reference_forbidden",
      );
      assertEquals(
        (await f.db.query(
          `SELECT count(*)::int AS n FROM "${f.schema}".nodes WHERE id='rolled-back'`,
        )).rows[0].n,
        0,
      );
      f.set({ permitted: true });
      await f.change(`DELETE FROM "${f.schema}".owner_receipts WHERE key=$1`, [
        preparationReceiptKey(namespace, "root", "run"),
      ]);
      await assertRejects(
        () => f.hooks.authorize(frame(), "input"),
        Error,
        "preparation_capture_orphan",
      );
    } finally {
      await f.db.close();
    }
  },
});

import { createDatabaseAssetRepository } from "../content/database-repository.ts";
import { createContentPreparer } from "../content/preparer.ts";
import { createContentResolver } from "../content/resolver.ts";
import { contentRefSchema } from "../content/schema.ts";
import { validateNamedPreparationHistory } from "./preparation-history.ts";
Deno.test({
  name:
    "named content capture retains original plain reference versions and fails closed when originals disappear",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      const assets = createDatabaseAssetRepository({
        session: f.db,
        databaseSchema: f.schema,
        eventStore: f.store,
        coordinator: f.coordinator,
      });
      const original = await assets.materialize({
        namespace,
        content: await createContentPreparer().prepare("original body", {
          namespace,
        }),
      });
      const replacement = await assets.materialize({
        namespace,
        content: await createContentPreparer().prepare("replacement body", {
          namespace,
        }),
      });
      await f.change(
        `UPDATE "${f.schema}".nodes SET data=jsonb_set(data,'{content}',$1::jsonb) WHERE id='record'`,
        [JSON.stringify(original)],
      );
      const registry = createPluginRegistry({
        actions: f.registry.actions,
        resources: f.registry.resources,
        collections: {
          records: defineCollection({
            name: "note",
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                content: { type: "array", items: contentRefSchema },
              },
            },
            content: { fields: ["content"] },
          }),
        },
        views: {
          note: defineView({
            id: "fixture.note",
            shows: "note",
            renderer: "text",
            modes: ["context"],
            render: (value: unknown) =>
              (value as { content: Array<{ value: string }> }).content[0].value,
          }),
        },
      });
      const config = {
        ...f.config,
        source: {
          ...f.config.source,
          sources: {
            notes: {
              collectionAlias: "records",
              fields: ["/title"],
              contentPath: "content",
            },
          },
        },
      };
      const compiled = compileActionPreparations(registry, config);
      const build = () =>
        createNamedPreparations({
          compiled,
          registry,
          store: f.store,
          coordinator: f.coordinator,
          namespace,
          source: { eventId: f.root.event.id },
          content: createContentResolver({ assets }),
          signal: new AbortController().signal,
        });
      const first = await build().prepare(frame(), request);
      assertEquals(first.input, { text: "original body" });
      const receipt = (await f.db.query<
        { result: { capture: { source: PreparationSourceReference } } }
      >(`SELECT result FROM "${f.schema}".owner_receipts WHERE kind='actions.prepareNamed'`))
        .rows[0];
      assertEquals<unknown>(
        receipt.result.capture.source.content[0].ref,
        original[0],
      );
      assertEquals(
        receipt.result.capture.source.content[0].version.byteLength,
        13,
      );
      await f.change(
        `UPDATE "${f.schema}".nodes SET data=jsonb_set(data,'{content}',$1::jsonb) WHERE id='record'`,
        [JSON.stringify(replacement)],
      );
      assertEquals(
        (await build().prepare(frame(), request)).input,
        first.input,
      );
      await f.run(
        "history",
        {},
        async (_, command) =>
          await validateNamedPreparationHistory(
            command.transaction,
            f.schema,
            registry,
            compiled,
          ),
      );
      await assets.markDeleted(namespace, original[0].assetId);
      await assertRejects(
        () => build().prepare(frame(), request),
        Error,
        "preparation_content_missing",
      );
      assertEquals(
        (await f.db.query(
          `SELECT count(*)::int AS n FROM "${f.schema}".owner_receipts WHERE kind='actions.prepareNamed'`,
        )).rows[0].n,
        1,
      );
    } finally {
      await f.db.close();
    }
  },
});
Deno.test({
  name:
    "retained named capture rejects missing registration, malformed provenance, orphaned receipts and target rebinding",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      await f.hooks.prepare(frame(), request);
      const validate = (
        compiled = compileActionPreparations(f.registry, f.config),
      ) =>
        f.run(
          "history",
          {},
          async (_, command) =>
            await validateNamedPreparationHistory(
              command.transaction,
              f.schema,
              f.registry,
              compiled,
            ),
        );
      await validate();
      await assertRejects(
        () =>
          f.run(
            "history",
            {},
            async (_, command) =>
              await validateNamedPreparationHistory(
                command.transaction,
                f.schema,
                f.registry,
              ),
          ),
        Error,
        "preparation_registration_missing",
      );
      const original = (await f.db.query<{ result: unknown }>(
        `SELECT result FROM "${f.schema}".owner_receipts WHERE kind='actions.prepareNamed'`,
      )).rows[0].result;
      await f.change(
        `UPDATE "${f.schema}".owner_receipts SET result=jsonb_set(result,'{capture,source,source,digest}','"not-a-digest"') WHERE kind='actions.prepareNamed'`,
      );
      await assertRejects(
        () => validate(),
        Error,
        "preparation_capture_invalid",
      );
      await f.change(
        `UPDATE "${f.schema}".owner_receipts SET result=$1::jsonb WHERE kind='actions.prepareNamed'`,
        [JSON.stringify(original)],
      );
      const other = defineAction({
        id: "fixture.other",
        execute: (input: unknown) => input,
      });
      const registry = createPluginRegistry({
        actions: { ...f.registry.actions, other },
        collections: f.registry.collections,
        views: f.registry.views,
        resources: f.registry.resources,
      });
      const compiled = compileActionPreparations(registry, {
        ...f.config,
        registrations: {
          note: { ...f.config.registrations.note, actionAlias: "other" },
        },
      });
      const rebound = createNamedPreparations({
        compiled,
        registry,
        store: f.store,
        coordinator: f.coordinator,
        namespace,
        source: { eventId: f.root.event.id },
        content: {
          authorize: () => Promise.resolve(),
          getMany: () => Promise.resolve([]),
        } as unknown as ContentResolver,
        signal: new AbortController().signal,
      });
      await assertRejects(
        () =>
          rebound.prepare(
            { ...frame("other-run"), actionId: other.id },
            request,
            "run",
          ),
        Error,
        "owner_intent_conflict",
      );
      await f.change(
        `DELETE FROM "${f.schema}".owner_receipts WHERE kind='actions.prepareNamed'`,
      );
      await assertRejects(
        () => validate(),
        Error,
        "preparation_capture_orphan",
      );
    } finally {
      await f.db.close();
    }
  },
});

Deno.test({
  name:
    "named originals reject scope substitution, missing source, replacement View and unsafe projections",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      await f.hooks.prepare(frame(), request);
      for (
        const changed of [{ namespace: "other", audience: "member" }, {
          namespace,
          audience: "other",
        }]
      ) {
        const rebound = f.build({
          source: { ...f.config.source, authorize: () => changed },
        });
        await assertRejects(
          () => rebound.prepare(frame(), request),
          Error,
          "preparation_forbidden",
        );
      }
      const registry = createPluginRegistry({
        actions: f.registry.actions,
        collections: f.registry.collections,
        resources: f.registry.resources,
        views: {
          replacement: defineView({
            id: "replacement.view",
            shows: "note",
            renderer: "text",
            modes: ["context"],
            render: () => {
              throw new Error("replacement must never render");
            },
          }),
        },
      });
      const rebound = createNamedPreparations({
        compiled: compileActionPreparations(registry, f.config),
        registry,
        store: f.store,
        coordinator: f.coordinator,
        namespace,
        source: { eventId: f.root.event.id },
        content: {
          getMany: () => Promise.resolve([]),
        } as unknown as ContentResolver,
        signal: new AbortController().signal,
      });
      await assertRejects(
        () => rebound.prepare(frame(), request),
        Error,
        "preparation_view_forbidden",
      );
      for (
        const value of [{ schema: "copilotz.action.protected-value.v1" }, {
          $secret: true,
        }, { nested: { ciphertext: "secret" } }]
      ) {
        const unsafe = f.build({
          source: { ...f.config.source, projectRecord: () => value },
        });
        await assertRejects(
          () => unsafe.prepare(frame(crypto.randomUUID()), request),
          Error,
          "preparation_projection_unsafe",
        );
        const unsafeMap = f.build({
          registrations: {
            note: {
              ...f.config.registrations.note,
              mapInput: () => value,
            },
          },
        });
        await assertRejects(
          () => unsafeMap.prepare(frame(crypto.randomUUID()), request),
          Error,
          "preparation_projection_unsafe",
        );
      }
      await f.change(
        `DELETE FROM "${f.schema}".nodes WHERE type='note' AND id='record'`,
      );
      const missing = f.build({
        source: { ...f.config.source, authorizeOriginal: () => true },
      });
      await assertRejects(
        () => missing.prepare(frame(), request),
        Error,
        "preparation_source_missing",
      );
      assertEquals(
        (await f.db.query(
          `SELECT count(*)::int AS n FROM "${f.schema}".owner_receipts WHERE kind='actions.prepareNamed'`,
        )).rows[0].n,
        1,
      );
    } finally {
      await f.db.close();
    }
  },
});

Deno.test({
  name:
    "timed-out named rendering rolls back child admission and retains physical capacity until settlement",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => release = resolve);
    try {
      const registry = createPluginRegistry({
        actions: f.registry.actions,
        collections: f.registry.collections,
        resources: f.registry.resources,
        views: {
          note: defineView({
            id: "blocked.note",
            shows: "note",
            renderer: "text",
            modes: ["context"],
            async render() {
              await blocked;
              return "settled";
            },
          }),
        },
      });
      const compiled = compileActionPreparations(registry, {
        ...f.config,
        maxPendingRenders: 1,
        renderTimeoutMs: 20,
      });
      const hooks = createNamedPreparations({
        compiled,
        registry,
        store: f.store,
        coordinator: f.coordinator,
        namespace,
        source: { eventId: f.root.event.id },
        content: {
          getMany: () => Promise.resolve([]),
        } as unknown as ContentResolver,
        signal: new AbortController().signal,
      });
      await assertRejects(
        () => hooks.prepare(frame(), request),
        Error,
        "preparation_timeout",
      );
      assertEquals(compiled.renderer.snapshot().pending, 1);
      await assertRejects(
        () => hooks.prepare(frame("second"), request),
        Error,
        "preparation_busy",
      );
      assertEquals(
        (await f.db.query(
          `SELECT count(*)::int AS n FROM "${f.schema}".events WHERE deduplication_id LIKE '%:action:invoked'`,
        )).rows[0].n,
        0,
      );
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(compiled.renderer.snapshot().pending, 0);
      assertEquals((await hooks.prepare(frame(), request)).input, {
        text: "settled",
      });
      assertEquals(
        (await f.db.query(
          `SELECT count(*)::int AS n FROM "${f.schema}".owner_receipts WHERE kind='actions.prepareNamed'`,
        )).rows[0].n,
        1,
      );
    } finally {
      release();
      await f.db.close();
    }
  },
});

import {
  preparationActionDescendants,
  preparationChildrenSql,
  preparationOperationDescendants,
  preparationOperationReceiptsSql,
} from "./preparation-inventory.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
Deno.test({
  name:
    "named result inventory refuses wide trees with indexed bounded SQL probes",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      await f.hooks.prepare(frame(), request);
      await f.change(
        `INSERT INTO ${f.store.tables.event_bodies}(namespace,event_body_id,schema_version,body,digest) SELECT 'space','unrelated-'||n,1,jsonb_build_object('status','invoked','actionRunId','unrelated-'||n,'parentActionRunId','unrelated'), 'fixture' FROM generate_series(1,2000) n`,
      );
      await f.change(
        `INSERT INTO ${f.store.tables.event_bodies}(namespace,event_body_id,schema_version,body,digest) SELECT 'space','wide-'||n,1,jsonb_build_object('status','invoked','actionRunId','wide-'||n,'parentActionRunId','run'), 'fixture' FROM generate_series(1,65) n`,
      );
      await assertRejects(
        () => f.hooks.authorize(frame(), "result"),
        Error,
        "preparation_limit",
      );
      await f.change(`ANALYZE ${f.store.tables.event_bodies}`);
      const plan = JSON.stringify(
        (await f.db.query(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${
            preparationChildrenSql(f.store.tables.event_bodies)
          }`,
          [namespace, "run", 64],
        )).rows,
      );
      assert(plan.includes("event_bodies_action_parent_idx"));
      console.log("bounded Action probe EXPLAIN", plan);
      assertEquals(
        await preparationActionDescendants(
          f.db,
          f.store.tables.event_bodies,
          namespace,
          "empty",
        ),
        [],
      );
      const catalog = await provisionOperationCatalog(f.db, f.schema);
      await f.change(
        `INSERT INTO ${catalog.operations}(operation_id,namespace,root_event_id,correlation_id,state,accepted_at,updated_at,parent_operation_id,parent_action_run_id) SELECT 'operation-'||n,'space','root-'||n,'test','completed',NOW(),NOW(),CASE WHEN n=0 THEN NULL ELSE 'operation-0' END, CASE WHEN n=0 THEN NULL ELSE 'parent' END FROM generate_series(0,65) n`,
      );
      await assertRejects(
        () =>
          preparationOperationDescendants(
            f.db,
            {
              operations: catalog.operations,
              receipts: f.store.tables.owner_receipts,
            },
            namespace,
            "operation-0",
          ),
        Error,
        "preparation_limit",
      );
      await f.change(
        `INSERT INTO ${f.store.tables.owner_receipts}(owner,domain,key,principal,kind,intent,result) SELECT 'schema','logical','fixture-'||n,'test','actions.prepareNamed','{}',jsonb_build_object('binding',jsonb_build_object('namespace','space','operationId',CASE WHEN n<=65 THEN 'operation-0' ELSE 'unrelated' END,'actionRunId','receipt-'||n)) FROM generate_series(1,2000) n`,
      );
      await assertRejects(
        () =>
          preparationOperationDescendants(
            f.db,
            {
              operations: catalog.operations,
              receipts: f.store.tables.owner_receipts,
            },
            namespace,
            "operation-0",
          ),
        Error,
        "preparation_limit",
      );
      await f.change(`ANALYZE ${f.store.tables.owner_receipts}`);
      const receiptPlan = JSON.stringify(
        (await f.db.query(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${
            preparationOperationReceiptsSql(f.store.tables.owner_receipts)
          }`,
          [namespace, "operation-0", 65],
        )).rows,
      );
      assert(receiptPlan.includes("owner_receipts_preparation_operation_idx"));
      console.log("bounded receipt probe EXPLAIN", receiptPlan);
    } finally {
      await f.db.close();
    }
  },
});

import { validateCollectionPolicies } from "../collections/policy-registration.ts";
Deno.test({
  name:
    "named original capture and every replay phase enforce the actual Collection policy with fixed source",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let allowed = true;
    const seen: Array<
      { phase: string; current: unknown; result: unknown; source: string }
    > = [];
    const policies = validateCollectionPolicies({
      records: {
        async authorize(intent, context) {
          assertEquals(intent.collection, { alias: "records", name: "note" });
          assertEquals(intent.method, "get");
          assertEquals(intent.args, { id: "record" });
          assertEquals(context.invocation, {
            kind: "action",
            id: "fixture.prepared",
            runId: "run",
          });
          const source = await context.resolveSource();
          seen.push({
            phase: intent.phase,
            current: intent.current?.title,
            result: intent.result,
            source: source.event.id,
          });
          if (!allowed) {
            throw new ActionError("Collection membership revoked", {
              code: "forbidden",
              status: 403,
            });
          }
        },
      },
    }, f.registry.collections);
    try {
      const hooks = f.build({}, policies);
      const first = await hooks.prepare(frame(), request);
      await f.change(
        `UPDATE "${f.schema}".nodes SET data=jsonb_set(data,'{title}','"current changed"') WHERE id='record'`,
      );
      assertEquals((await hooks.prepare(frame(), request)).input, first.input);
      assert(seen.some((row) => row.current === "current changed"));
      assert(
        seen.every((row) =>
          row.result === undefined && row.source === f.root.event.id
        ),
      );
      allowed = false;
      await assertRejects(
        () => hooks.prepare(frame(), request),
        Error,
        "Collection access denied.",
      );
      for (const phase of ["claim", "input", "mutation", "result"] as const) {
        await assertRejects(
          () => hooks.authorize(frame(), phase),
          Error,
          "Collection access denied.",
        );
      }
      assertEquals(f.stats().renders, 1);
    } finally {
      await f.db.close();
    }
  },
});

import { isOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
Deno.test({
  name:
    "named policy cannot convert query or source infrastructure failures into permanent refusal",
  ignore: !url,
  async fn() {
    for (const failure of ["query", "source"] as const) {
      const f = await fixture();
      try {
        if (failure === "source") {
          await f.change(
            `DELETE FROM "${f.schema}".event_bodies WHERE event_body_id='request'`,
          );
        }
        const hooks = f.build({
          source: {
            ...f.config.source,
            async authorize(tx, context) {
              try {
                if (failure === "query") {
                  await tx.query("SELECT * FROM missing_policy_infrastructure");
                } else await context.resolveSource();
              } catch {
                throw new ActionError("wrapped denial", {
                  code: "forbidden",
                  status: 403,
                });
              }
              throw new Error("Expected infrastructure failure");
            },
          },
        });
        const error = await assertRejects(() =>
          hooks.prepare(frame(), request)
        );
        assertEquals(isOwnerAuthorizationRefusal(error), false);
        assertEquals(
          (await f.db.query(
            `SELECT key FROM "${f.schema}".owner_receipts WHERE kind='actions.prepareNamed'`,
          )).rows,
          [],
        );
        assertEquals(f.stats().renders, 0);
        if (failure === "query") {
          assertEquals((await f.hooks.prepare(frame(), request)).input, {
            text: "original:first",
          });
        }
      } finally {
        await f.db.close();
      }
    }
  },
});
