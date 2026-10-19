import {
  bounded,
  commitProxy,
  localPostgresUrl,
} from "../testing/effect-commit-proxy.ts";
import { createOwnerEffectClient } from "./effect-commands.ts";
import { createProtectedValueRuntime } from "./protected-value.ts";
import { createBodyStorageRuntime } from "../content/storage.ts";
import { defineCollection } from "../collections/definition.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCopilotzApplication } from "../application/application.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import type { ContentInput, ContentSequence } from "../content/types.ts";
import { defineAction } from "./define.ts";
import { secret } from "./secret.ts";
import type { ActionContext, ActionSchema } from "./types.ts";
import type { ProtectedActionOwnerContext } from "./protected-action-types.ts";
import {
  assertProtectedParentCapture,
  captureParentCapture,
} from "./protected-action-content.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "parent capture proof binds retained public input, exact ordered C adoption, parent/key/scope and revocable handles",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url: url!, pgPoolMax: 1 });
    const schema = `parent_content_${crypto.randomUUID().replaceAll("-", "")}`;
    const namespace = "space";
    let uses = 0;
    let saved: ContentSequence = [];
    let savedContext: ProtectedActionOwnerContext | undefined;
    let snapshotChecked = false;
    let proofs = 0;
    let microtaskClosed = false;
    let pointer = "/message/content";
    let stage = "valid";
    const origin = { type: "fixture_document", id: "document" };
    const child = defineAction({
      id: "fixture.capture-adopt",
      ownerHooks: { prepareInput: true, acceptOutput: true },
      inputSchema: {
        type: "object",
        properties: {
          refs: { type: "array" },
          credential: secret({ type: "string" }),
        },
        required: ["refs"],
      } as const,
      outputSchema: { type: "boolean" } as const,
      execute() {
        uses++;
        return true;
      },
    });
    const parent = defineAction({
      id: "fixture.capture-parent",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string" },
          operation: { type: "string", enum: ["create", "inspect"] },
          message: {
            type: "object",
            properties: { content: {} },
            required: ["content"],
          },
        },
        required: ["message"],
        oneOf: [
          {
            properties: { operation: { const: "create" } },
            required: ["message"],
          },
          {
            properties: { operation: { const: "inspect" } },
            required: ["operation"],
          },
        ],
      } as const,
      async execute(
        input: {
          mode?: string;
          message: { content: ContentInput | readonly ContentInput[] };
        },
        ctx: ActionContext,
      ) {
        let refs: ContentSequence;
        if (input.mode === "another-parent") refs = saved;
        else {
          const pending = await ctx.content.capture(
            input.mode === "altered-bytes"
              ? ["changed"]
              : input.message.content,
            {
              operationKey: input.mode === "another-key"
                ? "other"
                : "create:content",
            },
          );
          refs = await ctx.content.materialize(pending, { origin });
        }
        if (input.mode === "missing") refs = refs.slice(0, 1);
        if (input.mode === "extra") refs = [...refs, refs[0]];
        if (input.mode === "reordered") refs = [...refs].reverse();
        if (input.mode === "descriptor") {
          refs = refs.map((ref, index) =>
            index ? ref : { ...ref, name: "substituted" }
          );
        }
        saved = refs;
        return ctx.actions.child({ refs }, { operationKey: "adopt" });
      },
    });
    const wrapper = defineAction({
      id: "fixture.capture-wrapper",
      inputSchema: {
        type: "object",
        properties: { pair: { type: "boolean" } },
      } as const,
      async execute(input: { pair?: boolean }, ctx: ActionContext) {
        const message = {
          content: {
            type: "json" as const,
            value: { z: [{ z: "é", a: null }, false, 1.5], a: 1 },
          },
        };
        await ctx.actions.parent({ message }, { operationKey: "first-parent" });
        if (input.pair) {
          return ctx.actions.parent({ message, mode: "another-parent" }, {
            operationKey: "other-parent",
          });
        }
        return true;
      },
    });
    const actions = { parent, child, wrapper };
    const app = await createCopilotzApplication({
      database: db,
      databaseSchema: schema,
      namespace,
      actions,
      collections: {
        document: defineCollection({
          name: origin.type,
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              namespace: { type: "string" },
              name: { type: "string" },
              content: { type: "array" },
            },
          },
          content: { fields: ["content"] },
        }),
      },
      adapters: { secrets: { default: await testSecretAdapter() } },
      protectedActions: {
        [child.id]: {
          authorize(_input, ctx) {
            assertEquals(ctx.action.parentId, parent.id);
            queueMicrotask(() => {
              try {
                ctx.assertParentCapture({
                  captureKey: "create:content",
                  parentInputPath: pointer,
                  content: [],
                  origin,
                });
              } catch {
                microtaskClosed = true;
              }
            });
          },
          async acceptOutput(_output, ctx) {
            const input = ctx.input;
            assertEquals(ctx.action.parentId, parent.id);
            const assertion = {
              captureKey: "create:content",
              parentInputPath: pointer,
              content: (input as { refs: ContentSequence }).refs,
              origin,
            };
            const checking = ctx.assertParentCapture(assertion);
            // Caller mutation after admission cannot change the captured proof request.
            assertion.content = [];
            await checking;
            snapshotChecked = true;
            proofs++;
            savedContext = ctx;
            await ctx.query(
              `INSERT INTO "${schema}".nodes(id,namespace,type,name) VALUES($1,$2,'hidden_adoption','accepted')`,
              [`hidden:${origin.id}`, namespace],
            );
            await ctx.collections.document.create({
              id: stage === "wrong-destination"
                ? `${origin.id}:other`
                : origin.id,
              name: "document",
              content: stage === "missing-edge"
                ? []
                : (input as { refs: ContentSequence }).refs,
            });
          },
          prepareInput(input) {
            return { ...input as object, credential: "synthetic" };
          },
        },
      },
    });
    const raw = [{ type: "text" as const, text: "first", name: "first" }, {
      type: "text" as const,
      text: "second",
      name: "second",
    }];
    const call = (mode = "valid", key = mode) =>
      app.host.actions.parent({ mode, message: { content: raw } }, {
        idempotencyKey: key,
      });
    try {
      assertEquals(await call(), true);
      assertEquals(uses, 1);
      assert(snapshotChecked);
      assert(microtaskClosed);
      const validRefs = saved;
      const observed = savedContext!;
      assertThrows(() =>
        observed.assertParentCapture({
          captureKey: "create:content",
          parentInputPath: pointer,
          content: validRefs,
          origin,
        })
      );
      assertEquals(await call(), true);
      assertEquals(uses, 1);
      for (
        const mode of [
          "another-parent",
          "another-key",
          "altered-bytes",
          "missing",
          "extra",
          "reordered",
          "descriptor",
        ]
      ) {
        saved = validRefs;
        await assertRejects(() => call(mode));
      }
      pointer = "/message/missing";
      await assertRejects(() => call("valid", "missing-path"));
      pointer = "/message/content";
      const row = (await db.query<
        { event_id: string; operation_id: string; source_event: string }
      >(
        `SELECT e.id AS event_id,i.operation_id,e.metadata->>'sourceEventId' AS source_event FROM "${schema}".events e JOIN "${schema}".copilotz_operation_events i ON i.event_id=e.id WHERE e.deduplication_id=$1`,
        [`${observed.action.runId}:action:invoked`],
      )).rows[0];
      const assertion = captureParentCapture({
        captureKey: "create:content",
        parentInputPath: pointer,
        content: validRefs,
        origin,
      });
      const run = createSchemaCommandRunner(db, schema);
      const verify = (
        tx: Parameters<typeof assertProtectedParentCapture>[0]["transaction"],
        changes: Partial<Parameters<typeof assertProtectedParentCapture>[0]> =
          {},
      ) =>
        assertProtectedParentCapture({
          transaction: tx,
          databaseSchema: schema,
          namespace,
          source: { eventId: row.source_event, operationId: row.operation_id },
          frame: {
            actionId: child.id,
            actionRunId: observed.action.runId,
            parentActionRunId: observed.action.parentRunId,
          },
          parentId: parent.id,
          actions,
          assertion,
          registeredOrigins: [origin.type],
          streamBodyPrefix: `schemas/${schema}`,
          ...changes,
        }).then((check) => check(tx));
      await run("fixture.verify", {}, (_, ctx) => verify(ctx.transaction));
      for (
        const inputSchema of [
          {
            type: "object",
            properties: {
              message: {
                type: "object",
                properties: { content: secret({ type: "array" }) },
              },
            },
          },
          {
            type: "object",
            oneOf: [{ properties: { message: { type: "object" } } }],
            properties: {
              message: { type: "object", properties: { content: {} } },
            },
          },
          {
            type: "object",
            properties: {
              message: { type: "object", properties: { missing: {} } },
            },
          },
        ]
      ) {
        await assertRejects(() =>
          run(
            "fixture.declaration",
            {},
            (_, ctx) =>
              verify(ctx.transaction, {
                actions: {
                  ...actions,
                  parent: {
                    ...parent,
                    inputSchema: inputSchema as unknown as ActionSchema,
                  },
                },
              }),
          )
        );
      }
      for (
        const branch of [
          { "x-copilotz-secret": true },
          { properties: { message: { type: "object" } } },
          { properties: { mode: { $ref: "#/properties/mode" } } },
          { patternProperties: { ".*": { type: "string" } } },
          { if: { properties: { mode: { const: "valid" } } }, then: {} },
          { properties: { mode: { oneOf: [{ const: "valid" }] } } },
        ]
      ) {
        await assertRejects(() =>
          run(
            "fixture.ambiguous-branch",
            {},
            (_, ctx) =>
              verify(ctx.transaction, {
                actions: {
                  ...actions,
                  parent: {
                    ...parent,
                    inputSchema: {
                      ...parent.inputSchema,
                      oneOf: [branch],
                    } as unknown as ActionSchema,
                  },
                },
              }),
          )
        );
      }
      await assertRejects(() =>
        run(
          "fixture.unregistered-owner",
          {},
          (_, ctx) => verify(ctx.transaction, { registeredOrigins: [] }),
        )
      );
      await assertRejects(() =>
        run(
          "fixture.parent-substitution",
          {},
          (_, ctx) => verify(ctx.transaction, { parentId: child.id }),
        )
      );
      await assertRejects(() =>
        run(
          "fixture.source-substitution",
          {},
          (_, ctx) =>
            verify(ctx.transaction, {
              source: { eventId: row.event_id, operationId: row.operation_id },
            }),
        )
      );
      await assertRejects(() =>
        run(
          "fixture.other-scope",
          {},
          (_, ctx) => verify(ctx.transaction, { namespace: "other" }),
        )
      );
      await assertRejects(() =>
        run("fixture.other-owner", {}, (_, ctx) =>
          verify(ctx.transaction, {
            assertion: { ...assertion, origin: { ...origin, id: "other" } },
          }))
      );
      const assetId = validRefs[0].assetId;
      const tamper = async (sql: string, params: unknown[]) => {
        const rollback = new Error("fixture rollback");
        try {
          await run("fixture.tamper", {}, async (_, ctx) => {
            await ctx.transaction.query(sql, params);
            await assertRejects(() => verify(ctx.transaction));
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
        await run("fixture.retry", {}, (_, ctx) => verify(ctx.transaction));
      };
      await tamper(
        `DELETE FROM "${schema}".content_adoptions WHERE asset_id=$1`,
        [assetId],
      );
      await tamper(
        `UPDATE "${schema}".pending_content SET descriptor=jsonb_set(descriptor,'{reference,name}','"substituted"') WHERE pending_ref IN (SELECT pending_ref FROM "${schema}".content_adoptions WHERE asset_id=$1)`,
        [assetId],
      );
      await tamper(
        `UPDATE "${schema}".pending_content SET producer='different-operation' WHERE pending_ref IN (SELECT pending_ref FROM "${schema}".content_adoptions WHERE asset_id=$1)`,
        [assetId],
      );
      await tamper(
        `UPDATE "${schema}".nodes SET data=jsonb_set(data,'{digest}','"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"') WHERE id=$1`,
        [assetId],
      );
      await tamper(
        `UPDATE "${schema}".nodes SET data=jsonb_set(data,'{byteLength}','999') WHERE id=$1`,
        [assetId],
      );
      await tamper(
        `UPDATE "${schema}".nodes SET namespace='other' WHERE id=$1`,
        [assetId],
      );
      assertEquals(uses, 9); // Failed acceptance never implies the Action body did not execute.
      const counts = async () =>
        (await db.query<
          { captures: string; adoptions: string; assets: string }
        >(`SELECT (SELECT count(*) FROM "${schema}".pending_content)::text AS captures,(SELECT count(*) FROM "${schema}".content_adoptions)::text AS adoptions,(SELECT count(*) FROM "${schema}".nodes WHERE type='asset')::text AS assets`))
          .rows[0];
      const beforeShared = await counts();
      origin.id = "shared";
      assertEquals(
        await app.host.actions.parent({ message: { content: validRefs } }, {
          idempotencyKey: "shared",
        }),
        true,
      );
      assertEquals(await counts(), beforeShared); // Canonical sharing creates no capture or retention owner.
      assertEquals(
        (await db.query(
          `SELECT source_node_id FROM "${schema}".edges WHERE type='has_asset' AND target_node_id=$1 ORDER BY source_node_id`,
          [assetId],
        )).rows,
        [{ source_node_id: "document" }, { source_node_id: "shared" }],
      );
      assertEquals(
        await app.host.actions.parent({ message: { content: validRefs } }, {
          idempotencyKey: "shared",
        }),
        true,
      );
      assertEquals(await counts(), beforeShared);
      for (const failure of ["missing-edge", "wrong-destination"]) {
        origin.id = failure;
        stage = failure;
        await assertRejects(() =>
          app.host.actions.parent({ message: { content: validRefs } }, {
            idempotencyKey: failure,
          })
        );
        assertEquals(
          (await db.query(
            `SELECT id FROM "${schema}".nodes WHERE id IN ($1,$2,$3)`,
            [failure, `${failure}:other`, `hidden:${failure}`],
          )).rows,
          [],
        );
        assertEquals(await counts(), beforeShared);
      }
      stage = "valid";
      origin.id = "nested-json";
      assertEquals(
        await app.host.actions.wrapper({}, { idempotencyKey: "nested-json" }),
        true,
      );
      const proved = proofs;
      origin.id = "sibling-parent";
      await assertRejects(() =>
        app.host.actions.wrapper({ pair: true }, {
          idempotencyKey: "sibling-parent",
        })
      );
      assertEquals(proofs, proved + 1); // The second parent cannot adopt its sibling's capture in the same operation.
      origin.id = "document";
      await tamper(
        `DELETE FROM "${schema}".edges WHERE namespace=$1 AND source_node_id=$2 AND type='has_asset'`,
        [namespace, origin.id],
      );
    } finally {
      await app.close();
      await db.close();
    }
  },
});

Deno.test({
  name:
    "lost parent-content acceptance COMMIT reuses exact capture and destination edges without another adoption",
  ignore: !url,
  async fn() {
    const proxy = await commitProxy(localPostgresUrl(url!));
    const db = await createTestDatabase({ url: proxy.url, pgPoolMax: 1 });
    const schema = `parent_content_lost_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
    const namespace = "space";
    const origin = { type: "fixture_document", id: "document" };
    const adapter = await testSecretAdapter();
    let accepted = 0;
    let observed: ProtectedActionOwnerContext | undefined;
    let refs: ContentSequence = [];
    const child = defineAction({
      id: "fixture.capture-adopt",
      ownerHooks: { prepareInput: true, acceptOutput: true },
      inputSchema: {
        type: "object",
        properties: {
          refs: { type: "array" },
          credential: secret({ type: "string" }),
        },
        required: ["refs"],
      } as const,
      outputSchema: { type: "boolean" } as const,
      async execute(_input: unknown, ctx: ActionContext) {
        await ctx.effect.begin("accept");
        await ctx.effect.confirmOutput("accept", true);
        return true;
      },
    });
    const parent = defineAction({
      id: "fixture.capture-parent",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "object",
            properties: { content: {} },
            required: ["content"],
          },
        },
        required: ["message"],
      } as const,
      async execute(
        input: { message: { content: ContentInput } },
        ctx: ActionContext,
      ) {
        refs = await ctx.content.materialize(
          await ctx.content.capture(input.message.content, {
            operationKey: "create:content",
          }),
          { origin },
        );
        return ctx.actions.child({ refs }, { operationKey: "adopt" });
      },
    });
    const actions = { parent, child };
    const app = await createCopilotzApplication({
      database: db,
      databaseSchema: schema,
      namespace,
      actions,
      collections: {
        document: defineCollection({
          name: origin.type,
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              namespace: { type: "string" },
              name: { type: "string" },
              content: { type: "array" },
            },
          },
          content: { fields: ["content"] },
        }),
      },
      adapters: { secrets: { default: adapter } },
      protectedActions: {
        [child.id]: {
          authorize(_input, ctx) {
            assertEquals(ctx.action.parentId, parent.id);
          },
          prepareInput(input) {
            return { ...input as object, credential: "synthetic" };
          },
          async acceptOutput(_output, ctx) {
            accepted++;
            observed = ctx;
            await ctx.assertParentCapture({
              captureKey: "create:content",
              parentInputPath: "/message/content",
              content: refs,
              origin,
            });
            await ctx.collections.document.create({
              id: origin.id,
              name: "document",
              content: refs,
            });
            proxy.arm();
          },
        },
      },
    });
    let next: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
    try {
      const result = app.host.actions.parent({
        message: { content: { type: "text", text: "captured" } },
      }, { idempotencyKey: "lost" }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await bounded(proxy.forwarded, "content acceptance COMMIT forwarded");
      assertEquals(
        await bounded(proxy.resolved, "content acceptance COMMIT resolved"),
        "COMMIT",
      );
      proxy.cutClient();
      await bounded(result, "owner lost-COMMIT outcome");
      next = await createTestDatabase({
        url: localPostgresUrl(url!),
        pgPoolMax: 1,
      });
      const counts = async () =>
        (await next!.query<
          {
            captures: string;
            adoptions: string;
            edges: string;
            receipts: string;
          }
        >(`SELECT (SELECT count(*) FROM "${schema}".pending_content)::text AS captures,(SELECT count(*) FROM "${schema}".content_adoptions)::text AS adoptions,(SELECT count(*) FROM "${schema}".edges WHERE type='has_asset' AND source_node_id='document')::text AS edges,(SELECT count(*) FROM "${schema}".owner_receipts WHERE kind='action.output.capture')::text AS receipts`))
          .rows[0];
      assertEquals(await counts(), {
        captures: "1",
        adoptions: "1",
        edges: "1",
        receipts: "1",
      });
      const row =
        (await next.query<{ operation_id: string; source_event: string }>(
          `SELECT i.operation_id,e.metadata->>'sourceEventId' AS source_event FROM "${schema}".events e JOIN "${schema}".copilotz_operation_events i ON i.event_id=e.id WHERE e.deduplication_id=$1`,
          [`${observed!.action.runId}:action:invoked`],
        )).rows[0];
      const recovery = createOwnerEffectClient({
        session: next,
        schema,
        namespace,
        actionRunId: observed!.action.runId,
        signal: new AbortController().signal,
        output: {
          action: child,
          protectedValues: createProtectedValueRuntime({
            session: next,
            databaseSchema: schema,
            storage: createBodyStorageRuntime({}),
            adapter,
          }),
          async authorize(transaction) {
            const check = await assertProtectedParentCapture({
              transaction,
              databaseSchema: schema,
              namespace,
              source: {
                eventId: row.source_event,
                operationId: row.operation_id,
              },
              frame: {
                actionId: child.id,
                actionRunId: observed!.action.runId,
                parentActionRunId: observed!.action.parentRunId,
              },
              parentId: parent.id,
              actions,
              assertion: captureParentCapture({
                captureKey: "create:content",
                parentInputPath: "/message/content",
                content: refs,
                origin,
              }),
              registeredOrigins: [origin.type],
              streamBodyPrefix: `schemas/${schema}`,
            });
            await check(transaction);
          },
          accept() {
            throw new Error("Accepted content must not be adopted twice.");
          },
        },
      });
      assertEquals(await recovery.inspect("accept"), {
        status: "replay",
        outcome: true,
      });
      await recovery.confirmOutput("accept", true);
      assertEquals(accepted, 1);
      assertEquals(await counts(), {
        captures: "1",
        adoptions: "1",
        edges: "1",
        receipts: "1",
      });
      await next.query(
        `DELETE FROM "${schema}".edges WHERE source_node_id='document' AND type='has_asset'`,
      );
      await assertRejects(() => recovery.inspect("accept"));
      assertEquals(accepted, 1);
      assertEquals(proxy.errors, []);
    } finally {
      await proxy.close();
      await app.close();
      await next?.close();
      await db.close();
    }
  },
});

Deno.test("parent capture assertions synchronously bound paths, descriptors, and destination without invoking accessors", () => {
  const input = {
    captureKey: "create:content",
    parentInputPath: "/message~1body/content~0refs",
    content: [],
    origin: { type: "document", id: "record" },
  };
  const fixed = captureParentCapture(input);
  input.origin.id = "changed";
  assertEquals(fixed.origin.id, "record");
  assert(Object.isFrozen(fixed));
  for (
    const path of [
      "",
      "relative",
      "/message/~2",
      "/__proto__/content",
      "/message//content",
    ]
  ) {
    assertThrows(() =>
      captureParentCapture({ ...input, parentInputPath: path })
    );
  }
  assertThrows(() =>
    captureParentCapture({
      ...input,
      origin: { type: "document", id: " record" },
    })
  );
  assertThrows(() =>
    captureParentCapture({ ...input, captureKey: "x".repeat(513) })
  );
  assertThrows(() =>
    captureParentCapture(
      {
        ...input,
        content: [{
          type: "content.pending",
          pendingRef: "unadopted",
          mediaType: "text/plain",
          digest: "sha256:x",
          byteLength: 1,
        }],
      } as never,
    )
  );
  assertThrows(() =>
    captureParentCapture({ ...input, content: [], extra: true } as never)
  );
  let getter = false;
  assertThrows(() =>
    captureParentCapture({
      ...input,
      get content() {
        getter = true;
        return [];
      },
    })
  );
  assertEquals(getter, false);
});
