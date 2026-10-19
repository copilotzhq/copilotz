import { admitActionRequest } from "../application/ingress/admit.ts";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_ACTION_REQUEST_SCHEMA,
} from "../application/ingress/contracts.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCopilotzApplication } from "../application/application.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { defineAction } from "./define.ts";
import type { ActionContext } from "./types.ts";
import { secret } from "./secret.ts";
import { definePlugin } from "../plugins/index.ts";
import {
  createHttpAdapter,
  defineServerFacade,
  serverPlugin,
} from "../../plugins/server/index.ts";
import { createServerFacadeFetchHandler } from "../../server/facade.ts";
import { createCopilotzClient } from "../../client/index.ts";
import type { ProtectedActionSource } from "./protected-action-types.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { createCoreTableNames } from "../events/schema.ts";
import {
  assertProtectedActionSourceReplay,
  resolveProtectedActionSource,
} from "./protected-action-source.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const action = defineAction({
  id: "fixture.owner-ingress",
  ownerHooks: { prepareInput: true, acceptOutput: true },
  inputSchema: {
    type: "object",
    properties: {
      label: { type: "string" },
      credential: secret({ type: "string" }),
      actor: { type: "string" },
      hostIngress: { type: "boolean" },
    },
    required: ["label"],
    additionalProperties: false,
  } as const,
  outputSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  } as const,
  execute: () => ({ ok: true }),
});
async function fixture(
  authenticated: boolean,
  acceptedKind: "host" | "authenticated-server" | "server-route" =
    "authenticated-server",
  bootstrap = false,
  continuation = false,
  failure?: () => never,
) {
  const database = await createTestDatabase({
    url: url ?? ":memory:",
    pgPoolMax: 1,
  });
  const schema = `ingress_${crypto.randomUUID().replaceAll("-", "")}`;
  let allowed = true, adopted = 0;
  const sources: ProtectedActionSource[] = [];
  const app = await createCopilotzApplication({
    database,
    databaseSchema: schema,
    namespace: "space",
    plugins: [
      definePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: defineServerFacade({
              expose: { actions: true, collections: false, channels: false },
              ...(bootstrap
                ? {
                  protectedBootstrapRoutes: ["fixture.invoke"],
                  authenticate() {
                    return {};
                  },
                  authorize() {
                    return {};
                  },
                }
                : {}),
              ...(authenticated
                ? {
                  authenticate() {
                    return {
                      actor: { id: "member" },
                      actionMetadata: { authority: "server" },
                    };
                  },
                  authorize() {
                    return { operations: { metadata: { actorId: "member" } } };
                  },
                }
                : {}),
            }),
          },
        },
      }),
    ],
    actions: {
      protected: continuation
        ? defineAction({
          ...action,
          execute(_input: unknown, context: ActionContext) {
            return context.awaitOperation({
              start: { action: "child", input: {} },
              handoff: null,
            });
          },
          resume() {
            return { ok: true };
          },
        })
        : action,
      child: defineAction({
        id: "fixture.child",
        execute() {
          return true;
        },
      }),
      forge: defineAction({
        id: "fixture.forge-provenance",
        async execute(_input: unknown, context: ActionContext) {
          return await context.actions.protected({ label: "forged-child" }, {
            metadata: {
              hostIngress: true,
              actionAlias: "protected",
              serverScope: { actor: { id: "member" } },
              sourceEventId: "forged",
            },
          });
        },
      }),
    },
    adapters: {
      secrets: { default: await testSecretAdapter() },
      http: {
        fixture: createHttpAdapter({
          routes: [{
            id: "fixture.invoke",
            method: "POST",
            path: "/protected",
            async handler(context) {
              return await context.invoke(action.id, context.input, {
                actionMetadata: { handlerAuthority: "owner-handler" },
              });
            },
          }, {
            id: "fixture.unlisted",
            method: "POST",
            path: "/unlisted",
            handler: (context) => context.invoke(action.id, context.input),
          }],
        }),
      },
    },
    protectedActions: {
      [action.id]: {
        async authorize(_input, context) {
          const source = await context.resolveSource();
          sources.push(source);
          failure?.();
          if (
            source.ingress?.kind !== acceptedKind || !allowed
          ) throw new Error("permission");
          if (
            source.ingress.kind === "server-route" &&
            source.ingress.routeId !== "fixture.invoke"
          ) throw new Error("route");
          if (
            source.ingress.kind === "authenticated-server" &&
            source.ingress.actor.id !== "member"
          ) throw new Error("actor");
          if (
            (source.data as { actionAlias?: string }).actionAlias !==
              "protected"
          ) throw new Error("unsupported root");
          const accepted = await context.readAcceptedOutput();
          if (accepted !== undefined) assertEquals(accepted, { ok: true });
        },
        prepareInput(input) {
          return { ...input as object, credential: "bound-owner-secret" };
        },
        acceptOutput() {
          adopted++;
        },
      },
    },
  });
  const handler = createServerFacadeFetchHandler(app);
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
  });
  return {
    app,
    database,
    schema,
    sources,
    client,
    handler,
    adopted: () => adopted,
    revoke() {
      allowed = false;
    },
  };
}
Deno.test("authenticated facade and custom invoke retain bound server identity; completed result replay reauthorizes", async () => {
  const f = await fixture(true);
  try {
    const receipt = await f.client.actions.submit(action.id, {
      label: "one",
      actor: "forged",
      hostIngress: true,
      credential: "original-request-secret",
    }, { idempotencyKey: "one" });
    assertEquals(await f.client.operations.result(receipt.operationId), {
      ok: true,
    });
    assertEquals(f.adopted(), 1);
    const source = f.sources[0];
    assertEquals(source.ingress, {
      kind: "authenticated-server",
      actor: { id: "member" },
    });
    assertEquals((source.data as { actionMetadata: unknown }).actionMetadata, {
      authority: "server",
      httpActor: { id: "member" },
    });
    assertEquals(source.ancestors[0].event.id, source.event.id);
    assertEquals(
      (source.data as { input: { credential: string } }).input.credential,
      "original-request-secret",
    );
    const response = await f.handler(
      new Request("https://test/api/protected", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "custom",
        },
        body: JSON.stringify({ label: "custom" }),
      }),
    );
    assertEquals(response.status, 200);
    assert(
      f.sources.some((source) =>
        (source.data as { actionMetadata?: { handlerAuthority?: string } })
          .actionMetadata?.handlerAuthority === "owner-handler"
      ),
    );
    f.revoke();
    await assertRejects(() => f.client.operations.result(receipt.operationId));
    assertEquals(f.adopted(), 2);
    const bodies = await f.database.query(
      `SELECT body FROM "${f.schema}".event_bodies`,
    );
    const receipts = await f.database.query(
      `SELECT intent,result FROM "${f.schema}".owner_receipts`,
    );
    const persisted = JSON.stringify([bodies.rows, receipts.rows]);
    assert(!persisted.includes("original-request-secret"));
    assert(!persisted.includes("bound-owner-secret"));
  } finally {
    await f.app.close();
    await f.database.close();
  }
});
Deno.test("ordinary unauthenticated HTTP and spoofed ingress fields never acquire server proof", async () => {
  const f = await fixture(false);
  try {
    const receipt = await f.client.actions.submit(action.id, {
      label: "forged",
      actor: "member",
      hostIngress: true,
    }, { idempotencyKey: "forged" });
    await assertRejects(() => f.client.operations.result(receipt.operationId));
    assert(f.sources.length > 0);
    assert(f.sources.every((source) => source.ingress === undefined));
    assertEquals(f.adopted(), 0);
  } finally {
    await f.app.close();
    await f.database.close();
  }
});
Deno.test("host admission is distinct; accepted events reject substituted roots and metadata", async () => {
  const f = await fixture(false, "host");
  try {
    assertEquals(
      await f.app.host.actions.protected({ label: "host" }, {
        idempotencyKey: "host",
      }),
      { ok: true },
    );
    const source = f.sources[0];
    assertEquals(source.ingress, { kind: "host" });
    const tables = createCoreTableNames(f.schema);
    const resolve = (eventId: string, namespace = "space") =>
      createSchemaCommandRunner(f.database, f.schema)(
        "fixture.source",
        {},
        (_, command) =>
          resolveProtectedActionSource({
            transaction: command.transaction,
            databaseSchema: f.schema,
            namespace,
            source: { eventId },
          }),
      );
    await assertRejects(() => resolve(source.event.id, "other"));
    await assertRejects(() => resolve("substituted-root"));
    await assertRejects(
      () =>
        f.database.query(
          `UPDATE ${tables.events} SET metadata=jsonb_set(metadata,'{actor}','"substituted"') WHERE id=$1`,
          [source.event.id],
        ),
      Error,
      "immutable",
    );
    const receipts = await f.database.query<{ text: string }>(
      `SELECT string_agg(result::text || intent::text,'') AS text FROM ${tables.owner_receipts}`,
    );
    assert(!receipts.rows[0].text?.includes("bound-owner-secret"));
  } finally {
    await f.app.close();
    await f.database.close();
  }
});
Deno.test("bootstrap proof is an exact opted-in custom server route with explicit policy hooks", async () => {
  assertThrows(
    () => defineServerFacade({ protectedBootstrapRoutes: ["fixture.invoke"] }),
    TypeError,
    "policy hooks",
  );
  const f = await fixture(false, "server-route", true);
  const policy = {
    authenticate() {
      return {};
    },
    authorize() {
      return {};
    },
  };
  const post = (path: string, id: string) =>
    new Request(`https://test/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": id },
      body: JSON.stringify({ label: id }),
    });
  try {
    for (const id of ["missing.route", action.id]) {
      assertThrows(
        () =>
          createServerFacadeFetchHandler(f.app, {
            facade: defineServerFacade({
              ...policy,
              protectedBootstrapRoutes: [id],
            }),
          }),
        TypeError,
        "custom HTTP",
      );
    }
    assertEquals((await f.handler(post("protected", "allowed"))).status, 200);
    assertEquals(f.sources[0].ingress, {
      kind: "server-route",
      routeId: "fixture.invoke",
    });
    assertEquals((await f.handler(post("unlisted", "unlisted"))).status, 422);
    assertEquals(f.sources.at(-1)?.ingress, undefined);
    const wrong = createServerFacadeFetchHandler(f.app, {
      facade: defineServerFacade({
        ...policy,
        protectedBootstrapRoutes: ["fixture.unlisted"],
      }),
    });
    assertEquals((await wrong(post("unlisted", "wrong-purpose"))).status, 422);
    assertEquals(f.sources.at(-1)?.ingress, {
      kind: "server-route",
      routeId: "fixture.unlisted",
    });
    const receipt = await f.client.actions.submit(action.id, {
      label: "generic",
    }, { idempotencyKey: "generic" });
    await assertRejects(() => f.client.operations.result(receipt.operationId));
    assertEquals(f.sources.at(-1)?.ingress, undefined);
    assertEquals(f.adopted(), 1);
  } finally {
    await f.app.close();
    await f.database.close();
  }
});
Deno.test("worker-authored child metadata and collection events cannot mint or substitute original ingress", async () => {
  const f = await fixture(true);
  try {
    const receipt = await f.client.actions.submit(
      "fixture.forge-provenance",
      {},
      { idempotencyKey: "child" },
    );
    await assertRejects(() => f.client.operations.result(receipt.operationId));
    assertEquals(
      (f.sources[0].data as { actionAlias: string }).actionAlias,
      "forge",
    );
    assertEquals(f.sources[0].ingress?.kind, "authenticated-server");
    assertEquals(f.adopted(), 0);
    const handle = await f.app.sendProtected(
      {
        namespace: "space",
        type: "fixture.collection.created",
        payload: {
          actionAlias: "protected",
          actor: "member",
          hostIngress: true,
        },
        metadata: {
          hostIngress: true,
          sourceAdapter: "server",
          serverScope: { actor: { id: "member" } },
        },
        deduplicationId: "collection-forgery",
      },
      { type: "object" },
      "collection-forgery",
    );
    await handle.done;
    await handle.detach("test");
    const source = await createSchemaCommandRunner(f.database, f.schema)(
      "fixture.collectionSource",
      {},
      (_, command) =>
        resolveProtectedActionSource({
          transaction: command.transaction,
          databaseSchema: f.schema,
          namespace: "space",
          source: {
            eventId: handle.operationId,
            operationId: handle.operationId,
          },
        }),
    );
    assertEquals(source.event.type, "fixture.collection.created");
    assertEquals(source.ingress, undefined);
    assertEquals(source.ancestors.length, 1);
  } finally {
    await f.app.close();
    await f.database.close();
  }
});

Deno.test("protected resumption keeps original authenticated ingress and adopts once", async () => {
  const f = await fixture(true, "authenticated-server", false, true);
  try {
    const receipt = await f.client.actions.submit(action.id, {
      label: "continuation",
    }, { idempotencyKey: "continuation" });
    assertEquals(
      await f.client.operations.result(
        receipt.operationId,
        AbortSignal.timeout(10000),
      ),
      { ok: true },
    );
    assertEquals(f.adopted(), 1);
    const sourceIds = new Set(f.sources.map((source) => source.event.id));
    assertEquals(sourceIds.size, 1);
    assert(
      f.sources.every((source) =>
        source.ingress?.kind === "authenticated-server"
      ),
    );
    const resumes = await f.database.query(
      `SELECT id FROM "${f.schema}".events WHERE type='copilotz.action.resume'`,
    );
    assertEquals(resumes.rows.length, 1);
    assert(!sourceIds.has(String(resumes.rows[0].id)));
    assertEquals(await f.client.operations.result(receipt.operationId), {
      ok: true,
    });
    assertEquals(f.adopted(), 1);
    const other = await f.client.actions.submit(action.id, {
      label: "unrelated",
    }, { idempotencyKey: "unrelated" });
    assertEquals(
      await f.client.operations.result(
        other.operationId,
        AbortSignal.timeout(10000),
      ),
      {
        ok: true,
      },
    );
    const unrelated = f.sources.find((source) =>
      !sourceIds.has(source.event.id)
    )!;
    for (const operationId of [other.operationId, receipt.operationId]) {
      await assertRejects(() =>
        createSchemaCommandRunner(f.database, f.schema)(
          "fixture.substitution",
          {},
          async (_, command) => {
            await assertProtectedActionSourceReplay({
              transaction: command.transaction,
              databaseSchema: f.schema,
              namespace: "space",
              original: {
                eventId: [...sourceIds][0],
                operationId: receipt.operationId,
              },
              current: { eventId: unrelated.event.id, operationId },
            });
          },
        )
      );
    }
  } finally {
    await f.app.close();
    await f.database.close();
  }
});

Deno.test("standard owner refusals retain only fixed safe auth codes through HTTP and replay", async () => {
  for (
    const [code, status, message] of [
      ["forbidden", 403, "Forbidden"],
      ["credential_unavailable", 401, "Credential unavailable"],
      ["auth_unavailable", 503, "Authentication is unavailable"],
      ["private-secret-code", 403, "Action execution failed."],
    ] as const
  ) {
    const f = await fixture(true, "authenticated-server", false, false, () => {
      throw Object.assign(new Error("private-provider-secret"), {
        code,
        status,
        cause: "private-provider-secret",
        data: "private-provider-secret",
      });
    });
    try {
      const receipt = await f.client.actions.submit(action.id, {
        label: "failure",
      }, { idempotencyKey: "failure" });
      for (let i = 0; i < 2; i++) {
        const error = await assertRejects(() =>
          f.client.operations.result(receipt.operationId)
        );
        assertEquals(
          (error as { code?: string }).code,
          code === "private-secret-code" ? "action_failed" : code,
        );
        assertEquals(
          (error as { status?: number }).status,
          code === "private-secret-code" ? 422 : status,
        );
        assertEquals((error as Error).message, message);
      }
      const rows = await f.database.query(
        `SELECT body FROM "${f.schema}".event_bodies`,
      );
      assert(!JSON.stringify(rows.rows).includes("private-provider-secret"));
      assert(!JSON.stringify(rows.rows).includes("private-secret-code"));
    } finally {
      await f.app.close();
      await f.database.close();
    }
  }
});

Deno.test("first unclassified admission stays unclassified on a trusted retry; exact body and metadata remain required", async () => {
  const f = await fixture(false, "host");
  try {
    const request = {
      namespace: "space",
      type: SERVER_ACTION_REQUEST_EVENT_TYPE,
      correlationId: "host:unclassified",
      deduplicationId: "host:unclassified",
      payload: {
        schema: SERVER_ACTION_REQUEST_SCHEMA,
        requestId: "host:unclassified",
        actionAlias: "protected",
        input: { label: "unclassified" },
        actionMetadata: {},
      },
    } as const;
    const handle = await admitActionRequest(f.app, request, action.inputSchema);
    const drain = (async () => {
      for await (const _output of handle.outputs) { /* no output */ }
    })();
    await Promise.allSettled([handle.done, drain]);
    await assertRejects(() =>
      f.app.host.actions.protected(request.payload.input, {
        idempotencyKey: "unclassified",
      })
    );
    assert(f.sources.length > 0);
    assert(f.sources.every((source) => source.ingress === undefined));
    assertEquals(f.adopted(), 0);
    const proofs = await f.database.query(
      `SELECT key FROM "${f.schema}".owner_receipts WHERE kind='owner.ingress'`,
    );
    assertEquals(proofs.rows.length, 0);
    await assertRejects(() =>
      f.app.host.actions.protected({ label: "changed" }, {
        idempotencyKey: "unclassified",
      })
    );
    await assertRejects(() =>
      f.app.host.actions.protected(request.payload.input, {
        idempotencyKey: "unclassified",
        metadata: { changed: true },
      })
    );
    await assertRejects(() =>
      f.app.host.actions.protected(request.payload.input, {
        idempotencyKey: "unclassified",
        actionMetadata: { changed: true },
      })
    );
    // A classified first admission cannot be downgraded by an unclassified retry.
    await f.app.host.actions.protected({ label: "classified" }, {
      idempotencyKey: "classified",
    });
    await assertRejects(
      () =>
        admitActionRequest(f.app, {
          ...request,
          correlationId: "host:classified",
          deduplicationId: "host:classified",
          payload: {
            ...request.payload,
            requestId: "host:classified",
            input: { label: "classified" },
          },
        }, action.inputSchema),
      Error,
      "first capture",
    );
  } finally {
    await f.app.close();
    await f.database.close();
  }
});
