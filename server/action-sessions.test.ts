import { captureCollectionInvocation } from "../runtime/authorization/invocation.ts";
import type { RuntimeActionCallers } from "../runtime/actions/types.ts";
import { wakeOwnerAlarms } from "../runtime/testing/owner-alarms.ts";
import {
  type AuthorizationIntent,
  authorizationRefused,
} from "../runtime/authorization/evaluator.ts";
import { Buffer } from "node:buffer";
import { decodeObservation } from "../client/protocol.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotzApplication } from "../runtime/application/application.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { testSecretAdapter } from "../runtime/testing/secret-adapter.ts";
import { testAuthority } from "../runtime/testing/authority.ts";
import { defineAction } from "../runtime/actions/index.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../runtime/plugins/index.ts";
import { defineCollection } from "../runtime/collections/index.ts";
import { serverPlugin } from "../plugins/server/plugin.ts";
import { defineServerFacade } from "../plugins/server/resources/facade/index.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import { createCopilotzClient } from "../client/index.ts";
import {
  type AuthenticatedAuthority,
  credentialValidity,
} from "../runtime/authorization/authority.ts";
import { credentialHeaders } from "./session-cookie.ts";

async function fixture(
  now = () => new Date(),
  strict = false,
  capacity?: number,
  pooledKey = false,
  logoutGate?: {
    before: Promise<void>;
    committed(): void;
    after: Promise<void>;
  },
  anonymousHost = false,
) {
  const detached = Promise.withResolvers<{ code: string; flow?: string }>();
  const seen: {
    authority: AuthenticatedAuthority;
    intent: AuthorizationIntent;
  }[] = [];
  let allowAlarm = false;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const executions = {
    callback: 0,
    logout: 0,
    child: 0,
    grandchild: 0,
    denied: 0,
  };
  const adapter = await testSecretAdapter();
  const secrets = pooledKey
    ? {
      ...adapter,
      async open(input: Parameters<typeof adapter.open>[0]) {
        const material = await adapter.open(input);
        const backing = crypto.getRandomValues(new Uint8Array(128));
        backing.set(material, 32);
        material.fill(0);
        return Buffer.from(backing.buffer, 32, 64);
      },
    }
    : adapter;
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `sessions_${crypto.randomUUID().replaceAll("-", "")}`;
  let allow = true;
  let allowOperationReads = true;
  let requestMetadata: Record<string, unknown> = {};
  const entries = defineCollection({
    name: "entries",
    alarm: {
      deadline: (record) => record.dueAt as string ?? null,
      command: (record) => ({
        name: "touch",
        key: `wake:${record.id}`,
        input: {},
      }),
    },
    commands: {
      touch: { mutate: () => ({ set: { value: "alarm", dueAt: null } }) },
    },
    schema: {
      type: "object",
      properties: { id: { type: "string" }, value: { type: "string" } },
      required: ["id", "value"],
    },
  });
  const login = defineAction({
    id: "auth.login",
    async execute(_input, ctx) {
      await ctx.transaction(async (tx) => {
        await tx.collections.entries.create({
          id: "login",
          value: "committed",
        });
        await tx.sessions.create({ principal: "account", maxAge: 3600 });
      });
      return { ok: true };
    },
  });
  const logout = defineAction({
    id: "auth.logout",
    async execute(_input, ctx) {
      executions.logout++;
      if (logoutGate) await logoutGate.before;
      await ctx.transaction(async (tx) => {
        await tx.collections.entries.create({
          id: "logout",
          value: "committed",
        });
        await tx.sessions.revoke();
      });
      if (logoutGate) {
        logoutGate.committed();
        await logoutGate.after;
      }
      return { ok: true };
    },
  });
  const start = defineAction({
    id: "auth.start",
    async execute(input, ctx) {
      await ctx.transaction(async (tx) => {
        await tx.flows.start({
          kind: "oauth",
          continuation: "callback",
          maxAge: (input as { maxAge?: number }).maxAge ?? 300,
        });
      });
      return { started: true };
    },
  });
  const callback = defineAction({
    id: "auth.callback",
    resume: () => ({}),
    async execute(input, ctx) {
      executions.callback++;
      const mode = (input as { descendants?: string }).descendants;
      if (mode === "detached" || mode?.startsWith("alarm-")) {
        await ctx.collections.entries.create({
          id: mode,
          value: "pending",
          ...(mode === "detached"
            ? {}
            : { dueAt: new Date(now().getTime() + 1000).toISOString() }),
        });
      }
      if (mode === "allowed") {
        await ctx.actions.child({}, { operationKey: "child" });
      }
      if (mode === "denied") await ctx.actions.denied({});
      if (mode === "linked") {
        return ctx.awaitOperation({
          start: { action: "child", input: {} },
          handoff: {},
        });
      }
      if (mode === "outside") {
        return {
          outside: await ctx.operations.start({
            action: "child",
            input: {},
            operationKey: "outside",
          }),
        };
      }
      if ((input as { login?: boolean }).login) {
        await ctx.transaction(async (tx) => {
          await tx.sessions.create({ principal: "flow-account", maxAge: 3600 });
        });
      }
      return { continued: true };
    },
  });
  const transfer = defineAction({
    id: "auth.transfer",
    async execute(_input, ctx) {
      await ctx.transaction(async (tx) => {
        await tx.sessions.create({ principal: "transferred", maxAge: 3600 });
        await tx.sessions.revoke();
      });
      return { transferred: true };
    },
  });
  const rollback = defineAction({
    id: "auth.rollback",
    async execute(_input, ctx) {
      await ctx.transaction(async (tx) => {
        await tx.sessions.create({ principal: "rolled-back", maxAge: 3600 });
        // The second effect is refused after the first has executed in SQL.
        await tx.flows.start({ kind: "denied", continuation: "callback" });
      });
    },
  });
  const replay = defineAction({
    id: "auth.replay",
    async execute(_input, ctx) {
      for (let i = 0; i < 2; i++) {
        await ctx.transaction(async (tx) => {
          assertEquals(
            await tx.sessions.create({ principal: "replayed", maxAge: 3600 }),
            undefined,
          );
        }, { operationKey: "session" });
      }
      return { ok: true };
    },
  });
  const revokeOther = defineAction({
    id: "auth.revokeOther",
    async execute(input, ctx) {
      await ctx.transaction(async (tx) => {
        await tx.sessions.revoke((input as { id: string }).id);
      });
      return { ok: true };
    },
  });
  const nestedLogin = defineAction({
    id: "auth.nestedLogin",
    execute: (_input, ctx) => ctx.actions.login({}),
  });
  const nestedLogout = defineAction({
    id: "auth.nestedLogout",
    async execute(input, ctx) {
      const result = await ctx.actions.logout({});
      if ((input as { attemptWrite?: boolean }).attemptWrite) {
        await assertRejects(() =>
          ctx.transaction(async (tx) => {
            await tx.collections.entries.create({
              id: "after-logout",
              value: "denied",
            });
          })
        );
      }
      return result;
    },
  });
  const hold = defineAction({
    id: "auth.hold",
    async execute() {
      held.resolve();
      await release.promise;
      return {};
    },
  });
  const actions = {
    child: defineAction({
      id: "auth.child",
      async execute(_input, ctx) {
        executions.child++;
        await ctx.actions.grandchild({}, { operationKey: "grandchild" });
        return {};
      },
    }),
    grandchild: defineAction({
      id: "auth.grandchild",
      async execute(_input, ctx) {
        executions.grandchild++;
        await ctx.collections.entries.create({
          id: "descendant",
          value: "committed",
        });
        return {};
      },
    }),
    denied: defineAction({
      id: "auth.denied",
      execute() {
        executions.denied++;
        return {};
      },
    }),
    hold,
    login,
    logout,
    start,
    callback,
    transfer,
    rollback,
    replay,
    revokeOther,
    nestedLogin,
    nestedLogout,
  };
  const selected = (tenant = "fixture"): AuthenticatedAuthority => ({
    ...testAuthority(schema, "main", "anonymous"),
    principal: { kind: "grant", id: "anonymous" },
    validity: credentialValidity(now()),
    authorityBasis: { kind: "grant", id: "anonymous" },
    scope: { ...testAuthority(schema, "main").scope, tenant },
    requestFacts: {
      endpoint: "http",
      transport: "http",
      operation: "invoke",
      params: {},
      input: null,
    },
    provenance: { ingress: "http", source: "browser" },
  });
  const app = await createCopilotzApplication({
    database: db,
    databaseSchema: schema,
    namespace: "main",
    engine: {
      now,
      ...(capacity ? { execution: { capacity } } : {}),
      alarmScheduler: { schedule() {}, cancel() {} },
    },
    adapters: { secrets: { default: secrets } },
    authorization: {
      systemScopes: { main: selected().scope },
      policies: {
        fixture: {
          revision: "1",
          sources: [],
          evaluate({ intent, authority }) {
            seen.push({ intent, authority });
            if (authority.validity.kind === "occurrence" && !allowAlarm) {
              authorizationRefused();
            }
            if (!allowOperationReads) return {};
            const proof = authority.scope.bindings["@credential-proof"];
            const isSession = authority.authorityBasis.kind === "session";
            const permitted = Object.keys(actions).filter((key) =>
              key !== "denied" && (!strict ||
                (key === "callback"
                  ? !!authority.flow
                  : key === "logout"
                  ? isSession
                  : true))
            );
            return {
              actions: Object.fromEntries(
                permitted.map((k) => [k, {}]),
              ),
              collections: { entries: {} },
              collectionMutations: {
                entries: { create: {}, commands: { touch: {} } },
              },
              operations: allowOperationReads
                ? {
                  metadata: strict
                    ? intent.kind === "action" && intent.operation === "admit"
                      ? {
                        recoveryProof: proof,
                        recovery: intent.resource !== "transfer",
                        ...(isSession
                          ? { sessionCredential: authority.principal.id }
                          : { anonymousCredential: authority.principal.id }),
                      }
                      : isSession
                      ? {}
                      : { recoveryProof: proof, recovery: true }
                    : {},
                }
                : undefined,
              sessions: allow
                ? {
                  create: {
                    principal: ({
                      "auth.login": "account",
                      "auth.callback": "flow-account",
                      "auth.transfer": "transferred",
                      "auth.rollback": "rolled-back",
                      "auth.replay": "replayed",
                    } as Record<string, string>)[intent.invocation?.id ?? ""] ??
                      "account",
                    maxAge: 3600,
                  },
                  revoke: intent.invocation?.id === "auth.revokeOther"
                    ? "tenant" as const
                    : "self" as const,
                }
                : {},
              flows: {
                start: { oauth: { continuation: "callback", maxAge: 300 } },
              },
            };
          },
        },
      },
      actions: Object.fromEntries(
        Object.keys(actions).map((k) => [k, { id: "fixture", revision: "1" }]),
      ),
      collections: { entries: { id: "fixture", revision: "1" } },
    },
    plugins: [
      definePlugin({
        id: "test.sessions",
        version: "1",
        actions,
        processors: {
          detached: defineProcessor<ProcessorContext>({
            id: "auth.detached",
            settlement: "detached",
            on: [{ eventType: "entries.created", subject: { id: "detached" } }],
            async handle(event, ctx) {
              if (!event.durable || event.subject?.id !== "detached") return;
              try {
                await (ctx.actions as RuntimeActionCallers).child({});
                detached.resolve({ code: "executed" });
              } catch (error) {
                detached.resolve({
                  code: (error as { code: string }).code,
                  flow: captureCollectionInvocation()?.authority?.flow?.kind,
                });
              }
            },
          }),
        },
        collections: { entries },
      }),
      definePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: defineServerFacade({
              authenticate(request) {
                return {
                  authority: selected(
                    request.headers.get("x-tenant") ?? "fixture",
                  ),
                  operationMetadata: requestMetadata,
                  ...(anonymousHost
                    ? {}
                    : { actor: { id: "person", name: "Authenticated actor" } }),
                };
              },
              expose: { actions: true, collections: true, channels: false },
            }),
          },
        },
      }),
    ],
  });
  const handler = createServerFacadeFetchHandler(app);
  const proof = "a".repeat(64);
  const request = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    handler(
      new Request(`https://test/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-copilotz-credential-proof": proof,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const submit = async (
    action: string,
    key: string,
    headers: Record<string, string> = {},
  ) => {
    const response = await request(`/actions/${action}`, {}, {
      "idempotency-key": key,
      ...headers,
    });
    assertEquals(response.status, 202, await response.clone().text());
    return (await response.json()).data.operationId as string;
  };
  const result = async (id: string, headers: Record<string, string> = {}) => {
    for (let i = 0; i < 100; i++) {
      const response = await request(
        `/operations/${id}/result`,
        undefined,
        headers,
      );
      if (response.status !== 202) return response;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Result timed out");
  };
  return {
    db,
    secrets,
    schema,
    app,
    handler,
    request,
    submit,
    result,
    selected,
    held: held.promise,
    release: () => release.resolve(),
    executions,
    seen,
    detached: detached.promise,
    allowAlarm: () => allowAlarm = true,
    allowOperationReads: () => allowOperationReads = true,
    metadata: (value: Record<string, unknown>) => requestMetadata = value,
    deny: () => allow = false,
    denyOperationReads: () => allowOperationReads = false,
    async close() {
      release.resolve();
      await app.close();
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.close();
    },
  };
}
Deno.test("Action login replay projects only cookies; logout revokes an open channel", async () => {
  const f = await fixture();
  try {
    const id = await f.submit("login", "login");
    const response = await f.result(id);
    assertEquals(response.status, 200, await response.clone().text());
    const cookie = response.headers.get("set-cookie")!;
    assert(cookie);
    for (
      const attribute of [
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Path=/",
        "Max-Age=",
      ]
    ) assert(cookie.includes(attribute));
    const pair = cookie.split(";")[0],
      token = pair.slice(pair.indexOf("=") + 1);
    assertEquals((await response.json()).data, { ok: true });
    const again = await f.result(await f.submit("login", "login"));
    assertEquals(again.headers.get("set-cookie")?.split(";")[0], pair);
    const replay = await f.request("/actions/login", {}, {
      "idempotency-key": "login",
    });
    assertEquals(replay.headers.get("set-cookie")?.split(";")[0], pair);
    const cookieReplay = await f.request("/actions/login", {}, {
      "idempotency-key": "login",
      cookie: pair,
    });
    assertEquals(cookieReplay.status, 202, await cookieReplay.clone().text());
    assertEquals(cookieReplay.headers.get("set-cookie")?.split(";")[0], pair);
    const observed = await f.request("/operations/observe", {
      operationIds: [id],
    });
    assertEquals(observed.status, 200);
    for await (const frame of decodeObservation(observed)) {
      assert(!JSON.stringify(frame).includes(token));
      if (
        frame.kind === "output" && frame.output.type === "operation.completed"
      ) break;
    }
    await assertRejects(() =>
      f.app.collections.transaction({
        operationKey: "outside",
        namespace: "main",
        execute: async (tx) => {
          await tx.sessions.create({ principal: "outside", maxAge: 3600 });
        },
      })
    );
    const foreign = await f.result(id, {
      "x-copilotz-credential-proof": "b".repeat(64),
    });
    assertEquals(foreign.headers.get("set-cookie"), null);
    const rows = await f.db.query(
      `SELECT count(*)::int AS n FROM "${f.schema}".authorization_sessions`,
    );
    assertEquals(rows.rows[0].n, 1);
    for (
      const table of [
        "events",
        "event_bodies",
        "copilotz_operations",
        "authorization_effects",
        "owner_receipts",
      ]
    ) {
      const rows = await f.db.query(
        `SELECT row_to_json(t)::text AS data FROM "${f.schema}".${table} t`,
      );
      assert(!JSON.stringify(rows.rows).includes(token), table);
    }
    const { authority } = await f.app.authorization.credentials.authenticate(
      f.selected(),
      token,
      "session",
    );
    let revoked = false;
    const channel = await f.app.authorization.observe(authority, {
      operationIds: [id],
    }, () => revoked = true);
    const logout = await f.submit("logout", "logout", { cookie: pair });
    const cleared = await f.result(logout, { cookie: pair });
    assertEquals(cleared.status, 200, await cleared.clone().text());
    assert(cleared.headers.get("set-cookie")?.includes("Max-Age=0"));
    assert(revoked);
    const replayLogout = await f.request("/actions/logout", {}, {
      "idempotency-key": "logout",
    });
    assertEquals(replayLogout.status, 202, await replayLogout.clone().text());
    assert(replayLogout.headers.get("set-cookie")?.includes("Max-Age=0"));
    await assertRejects(() => f.app.authorization.operation(authority, id));
    await assertRejects(() =>
      f.app.authorization.credentials.project(authority, id)
    );
    channel.close();
  } finally {
    await f.close();
  }
});

Deno.test("Credential projection reauthorizes operation access in the credential release command", async () => {
  const f = await fixture();
  try {
    const operation = await f.submit("login", "projection");
    const cookie = (await f.result(operation)).headers.get("set-cookie")!;
    const pair = cookie.split(";")[0];
    const token = pair.slice(pair.indexOf("=") + 1);
    const { authority } = await f.app.authorization.credentials.authenticate(
      f.selected(),
      token,
      "session",
    );
    await f.app.authorization.operation(authority, operation);
    assertEquals(
      (await f.app.authorization.credentials.project(authority, operation))[0]
        .token,
      token,
    );
    // A previously successful read must not authorize later credential release.
    f.denyOperationReads();
    await assertRejects(() =>
      f.app.authorization.credentials.project(authority, operation)
    );
  } finally {
    await f.close();
  }
});

Deno.test("Logout completion cannot revive writes even when the Action catches refusal", async () => {
  const f = await fixture();
  try {
    const login = await f.result(await f.submit("login", "login"));
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const receipt = await f.request("/actions/nestedLogout", {
      attemptWrite: true,
    }, {
      cookie,
      "idempotency-key": "logout-write",
    });
    assertEquals(receipt.status, 202);
    const result = await f.result((await receipt.json()).data.operationId, {
      cookie,
    });
    assertEquals(result.status, 403);
    assertEquals(
      (await f.db.query(
        `SELECT count(*)::int AS n FROM "${f.schema}".nodes WHERE id='after-logout'`,
      )).rows[0].n,
      0,
    );
  } finally {
    await f.close();
  }
});
Deno.test("Session policy refusal rolls back the Action transaction and mints no credential", async () => {
  const f = await fixture();
  try {
    f.deny();
    const response = await f.result(await f.submit("login", "denied"));
    assertEquals(response.status, 403, await response.clone().text());
    for (
      const table of [
        "authorization_sessions",
        "authorization_effects",
        "nodes",
      ]
    ) {
      assertEquals(
        (await f.db.query(
          `SELECT count(*)::int AS n FROM "${f.schema}".${table}`,
        )).rows[0].n,
        0,
        table,
      );
    }
  } finally {
    await f.close();
  }
});
Deno.test("Flow credential is signed, tenant-bound, operation-bound and single-use with replay", async () => {
  const f = await fixture();
  const forbidden = async (response: Response) => {
    assertEquals(response.status, 403);
    assertEquals((await response.json()).error.code, "forbidden");
  };
  try {
    const start = await f.submit("start", "flow");
    const response = await f.result(start);
    assertEquals(response.status, 200, await response.clone().text());
    const token = response.headers.get("x-copilotz-flow")!;
    assert(token);
    const flow = { "x-copilotz-flow": token };
    assertEquals((await f.result(start, flow)).status, 200);
    await forbidden(
      await f.request("/actions/login", {}, {
        ...flow,
        "idempotency-key": "direct-login",
      }),
    );
    const observed = await f.request("/operations/observe", {
      operationIds: [start],
    }, flow);
    assertEquals(observed.status, 200);
    for await (const frame of decodeObservation(observed)) {
      if (
        frame.kind === "output" && frame.output.type === "operation.completed"
      ) break;
    }
    await forbidden(await f.request("/collections/entries", undefined, flow));
    await forbidden(await f.result(start, { ...flow, "x-tenant": "other" }));
    await forbidden(await f.result(start, { "x-copilotz-flow": token + "x" }));
    const other = await f.submit("start", "other");
    await f.result(other);
    await forbidden(await f.result(other, flow));
    await forbidden(
      await f.request("/operations/observe", { operationIds: [other] }, flow),
    );
    const callback = await f.submit("callback", "continue", flow);
    assertEquals((await f.result(callback, flow)).status, 200);
    assertEquals(await f.submit("callback", "continue", flow), callback);
    const reused = await f.request("/actions/callback", {}, {
      ...flow,
      "idempotency-key": "reuse",
    });
    if (reused.status === 202) {
      await forbidden(
        await f.result((await reused.json()).data.operationId, flow),
      );
    } else await forbidden(reused);
    const { authority } = await f.app.authorization.credentials.authenticate(
      f.selected(),
      token,
      "flow",
    );
    await f.db.query(
      `UPDATE "${f.schema}".authorization_effects SET claims=jsonb_set(claims,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE effect_key=$1`,
      [authority.flow!.id],
    );
    const expired = await assertRejects(() =>
      f.app.authorization.operation(authority, start)
    );
    assertEquals((expired as { code: string }).code, "forbidden");
  } finally {
    await f.close();
  }
});
Deno.test("SDK retains flow headers and lets the browser manage session cookies", async () => {
  const f = await fixture();
  try {
    const seen: Request[] = [];
    const client = createCopilotzClient({
      baseUrl: "https://test/api",
      fetch: async (input, init) => {
        assertEquals(init?.credentials, "include");
        const request = new Request(input, init);
        seen.push(request);
        return await f.handler(request);
      },
    });
    assertEquals(
      await client.actions.invoke("start", {}, {
        idempotencyKey: "sdk-flow",
        signal: AbortSignal.timeout(15000),
      }),
      { started: true },
    );
    assertEquals(
      await client.actions.invoke("callback", { login: true }, {
        idempotencyKey: "sdk-callback",
        signal: AbortSignal.timeout(15000),
      }),
      { continued: true },
    );
    assert(
      seen.some((request) =>
        request.url.endsWith("/actions/callback") &&
        request.headers.has("x-copilotz-flow")
      ),
    );
  } finally {
    await f.close();
  }
});
Deno.test("Cookie settings reject unsafe syntax and honor configured attributes", () => {
  for (
    const sessionCookie of [{ name: "bad;name" }, { path: "/;bad" }, {
      domain: "bad\r\n",
    }, { sameSite: "None" as const, secure: false }]
  ) {
    let refused = false;
    try {
      // Cookie validation runs before authentication is ever used.
      defineServerFacade({
        sessionCookie,
        authenticate: () => new Response(null, { status: 401 }),
      });
    } catch {
      refused = true;
    }
    assert(refused);
  }
  const headers = credentialHeaders([{
    claims: {
      type: "clear",
      id: "x",
      schema: "x",
      namespace: "x",
      tenant: "x",
      principal: "x",
      expiresAt: new Date().toISOString(),
    },
  }], { name: "app_session", path: "/app", secure: false, sameSite: "Strict" });
  assertEquals(
    headers["set-cookie"],
    "app_session=; Path=/app; HttpOnly; SameSite=Strict; Max-Age=0",
  );
});

Deno.test("Flow credential expires at its signed deadline", async () => {
  let now = Date.now();
  const f = await fixture(() => new Date(now));
  try {
    const receipt = await f.request("/actions/start", { maxAge: 1 }, {
      "idempotency-key": "short",
    });
    assertEquals(receipt.status, 202);
    const operation = (await receipt.json()).data.operationId;
    const response = await f.result(operation);
    const token = response.headers.get("x-copilotz-flow")!;
    assert(token);
    assertEquals(
      (await f.result(operation, { "x-copilotz-flow": token })).status,
      200,
    );
    now += 1000;
    assertEquals(
      (await f.result(operation, { "x-copilotz-flow": token })).status,
      403,
    );
  } finally {
    await f.close();
  }
});

Deno.test("Action session transfer commits replacement and revocation together", async () => {
  const f = await fixture();
  try {
    const login = await f.result(await f.submit("login", "transfer-login"));
    const oldCookie = login.headers.get("set-cookie")!.split(";")[0];
    const result = await f.result(
      await f.submit("transfer", "transfer", { cookie: oldCookie }),
      { cookie: oldCookie },
    );
    assertEquals(result.status, 200, await result.clone().text());
    const nextCookie = result.headers.get("set-cookie")!.split(";")[0];
    assert(nextCookie !== oldCookie && !nextCookie.endsWith("="));
    const rows = (await f.db.query<{ principal: string; revoked: boolean }>(
      `SELECT principal,revoked_at IS NOT NULL AS revoked FROM "${f.schema}".authorization_sessions ORDER BY principal`,
    )).rows;
    assertEquals(rows, [{ principal: "account", revoked: true }, {
      principal: "transferred",
      revoked: false,
    }]);
  } finally {
    await f.close();
  }
});

Deno.test("Credential effects roll back together and repeated Action transactions mint once", async () => {
  const f = await fixture();
  try {
    const refused = await f.result(await f.submit("rollback", "rollback"));
    assertEquals(refused.status, 403, await refused.clone().text());
    assertEquals(refused.headers.get("set-cookie"), null);
    for (
      const table of [
        "authorization_sessions",
        "authorization_effects",
        "owner_data_keys",
      ]
    ) {
      assertEquals(
        (await f.db.query(
          `SELECT count(*)::int AS n FROM "${f.schema}".${table}`,
        )).rows[0].n,
        0,
        table,
      );
    }
    const result = await f.result(await f.submit("replay", "replay"));
    assertEquals(result.status, 200, await result.clone().text());
    assert(result.headers.get("set-cookie"));
    for (const table of ["authorization_sessions", "authorization_effects"]) {
      assertEquals(
        (await f.db.query(
          `SELECT count(*)::int AS n FROM "${f.schema}".${table}`,
        )).rows[0].n,
        1,
        table,
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test("SDK login and logout recover cookies with browser-style credential transitions", async () => {
  const f = await fixture(undefined, true);
  try {
    let cookie = "";
    const client = createCopilotzClient({
      baseUrl: "https://test/api",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        if (cookie) headers.set("cookie", cookie);
        const response = await f.handler(
          new Request(input, { ...init, headers }),
        );
        const next = response.headers.get("set-cookie");
        if (next) cookie = next.includes("Max-Age=0") ? "" : next.split(";")[0];
        return response;
      },
    });
    const invoke = (action: string, key: string) =>
      client.actions.invoke(action, {}, {
        idempotencyKey: key,
        signal: AbortSignal.timeout(15000),
      });
    assertEquals(await invoke("login", "sdk-login"), { ok: true });
    assert(cookie);
    const original = cookie;
    assertEquals(await invoke("login", "sdk-login"), { ok: true });
    assertEquals(cookie, original);
    assertEquals(await invoke("logout", "sdk-logout"), { ok: true });
    assertEquals(cookie, "");
    assertEquals(await invoke("logout", "sdk-logout"), { ok: true });
    assertEquals(cookie, "");
  } finally {
    await f.close();
  }
});

Deno.test("Revoking another session leaves the caller's cookie and authority intact", async () => {
  const f = await fixture();
  try {
    const loginId = await f.submit("login", "caller");
    const cookie =
      (await f.result(loginId)).headers.get("set-cookie")!.split(";")[0];
    await f.result(await f.submit("replay", "target"));
    const target = (await f.db.query<{ id: string }>(
      `SELECT id FROM "${f.schema}".authorization_sessions WHERE principal='replayed'`,
    )).rows[0].id;
    const receipt = await f.request(
      "/actions/revokeOther",
      { id: target },
      {
        cookie,
        "idempotency-key": "revoke-other",
      },
    );
    assertEquals(receipt.status, 202, await receipt.clone().text());
    const result = await f.result((await receipt.json()).data.operationId, {
      cookie,
    });
    assertEquals(result.status, 200, await result.clone().text());
    assertEquals(result.headers.get("set-cookie"), null);
    assertEquals((await f.result(loginId, { cookie })).status, 200);
    assertEquals(
      (await f.db.query<{ revoked: boolean }>(
        `SELECT revoked_at IS NOT NULL AS revoked FROM "${f.schema}".authorization_sessions WHERE id=$1`,
        [target],
      )).rows[0].revoked,
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test("HTTP Actions project session effects committed by their nested Actions", async () => {
  const f = await fixture();
  try {
    const login = await f.result(await f.submit("nestedLogin", "nested-login"));
    assertEquals(login.status, 200, await login.clone().text());
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert(cookie, "Nested login must install its committed session");
    const logout = await f.result(
      await f.submit("nestedLogout", "nested-logout", { cookie }),
      { cookie },
    );
    assertEquals(logout.status, 200, await logout.clone().text());
    assert(logout.headers.get("set-cookie")?.includes("Max-Age=0"));
    assertEquals(
      (await f.request("/actions/replay", {}, {
        cookie,
        "idempotency-key": "after-logout",
      })).status,
      202,
    );
  } finally {
    await f.close();
  }
});

Deno.test("SDK pending continuation is readable before capture and exact replay survives cookie installation", async () => {
  let now = Date.now();
  const f = await fixture(() => new Date(now), true, 1);
  let cookie = "";
  const requests: Request[] = [];
  const responses: Response[] = [];
  const pendingRead = Promise.withResolvers<Response>();
  let heldOperation: string | undefined;
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("cookie", cookie);
      const request = new Request(input, { ...init, headers });
      requests.push(request.clone());
      const response = await f.handler(request);
      responses.push(response.clone());
      if (
        heldOperation &&
        request.url.endsWith(`/operations/${heldOperation}/result`)
      ) pendingRead.resolve(response.clone());
      const next = response.headers.get("set-cookie");
      if (next) cookie = next.split(";")[0];
      return response;
    },
  });
  try {
    const options = {
      idempotencyKey: "start",
      signal: AbortSignal.timeout(15000),
    };
    await client.actions.invoke("start", {}, options);
    const otherStart = await f.result(await f.submit("start", "other-flow"));
    const otherFlow = otherStart.headers.get("x-copilotz-flow")!;
    await f.submit("hold", "hold");
    await f.held;
    const receipt = await client.actions.submit("callback", {
      login: true,
    }, { idempotencyKey: "callback" });
    const callbackRequest = requests.find((request) =>
      request.url.endsWith("/actions/callback")
    )!;
    const flow = callbackRequest.headers.get("x-copilotz-flow")!;
    const proof = callbackRequest.headers.get("x-copilotz-credential-proof")!;
    const originalHeaders = {
      "x-copilotz-flow": flow,
      "x-copilotz-credential-proof": proof,
    };
    assertEquals(
      (await f.db.query(
        `SELECT count(*)::int AS n FROM "${f.schema}".authorization_invocations WHERE source_event_id=$1`,
        [receipt.operationId],
      )).rows[0].n,
      0,
    );
    heldOperation = receipt.operationId;
    const result = client.operations.result(
      receipt.operationId,
      AbortSignal.timeout(15000),
    );
    void result.catch(() => undefined);
    const pending = await pendingRead.promise;
    assertEquals(pending.status, 202, await pending.clone().text());
    for (
      const headers of [
        { ...originalHeaders, "x-copilotz-flow": otherFlow },
        { ...originalHeaders, "x-copilotz-credential-proof": "z".repeat(64) },
        { ...originalHeaders, "x-tenant": "other" },
      ]
    ) {
      assertEquals(
        (await f.request(
          `/operations/${receipt.operationId}/result`,
          undefined,
          headers,
        )).status,
        403,
      );
    }
    assertEquals(
      (await f.request("/actions/callback", { login: true }, {
        ...originalHeaders,
        "idempotency-key": "competitor",
      })).status,
      403,
    );
    assertEquals(
      await client.actions.submit("callback", { login: true }, {
        idempotencyKey: "callback",
      }).then((value) => value.operationId),
      receipt.operationId,
    );
    f.release();
    assertEquals((await result).value, { continued: true });
    assertEquals(
      await client.actions.invoke("callback", { login: true }, {
        idempotencyKey: "callback",
        signal: AbortSignal.timeout(15000),
      }),
      { continued: true },
    );
    assert(cookie);
    const originalCookie = cookie;
    assertEquals(
      await client.actions.invoke("callback", { login: true }, {
        idempotencyKey: "callback",
        signal: AbortSignal.timeout(15000),
      }),
      { continued: true },
    );
    assertEquals(cookie, originalCookie);
    assertEquals(f.executions.callback, 1);
    const replay = responses.findLast((response) =>
      response.status === 202 && response.headers.has("set-cookie")
    );
    assertEquals(
      replay?.headers.get("set-cookie")?.split(";")[0],
      originalCookie,
    );
    await assertRejects(() =>
      client.actions.submit("callback", { login: false }, {
        idempotencyKey: "callback",
      })
    );
    // New identities cannot use the retired flow or session to execute a callback.
    await assertRejects(() =>
      client.actions.submit("callback", { login: true }, {
        idempotencyKey: "fresh",
      })
    );
    assertEquals(f.executions.callback, 1);
    now += 301_000;
    await assertRejects(() =>
      client.actions.submit("callback", { login: true }, {
        idempotencyKey: "callback",
      })
    );
    assertEquals(f.executions.callback, 1);
  } finally {
    await f.close();
  }
});

Deno.test("Completed logout submission replays under proof-only recovery without an anonymous execution grant", async () => {
  let now = Date.now();
  const f = await fixture(() => new Date(now), true);
  try {
    const login = await f.result(await f.submit("login", "strict-login"));
    let cookie = login.headers.get("set-cookie")!.split(";")[0];
    const ordinary = await f.submit("transfer", "ordinary", { cookie });
    cookie =
      (await f.result(ordinary, { cookie })).headers.get("set-cookie")!.split(
        ";",
      )[0];
    const logout = await f.submit("logout", "strict-logout", { cookie });
    assertEquals((await f.result(logout, { cookie })).status, 200);
    const replay = await f.request("/actions/logout", {}, {
      "idempotency-key": "strict-logout",
    });
    assertEquals(replay.status, 202, await replay.clone().text());
    assertEquals((await replay.json()).data.operationId, logout);
    assert(replay.headers.get("set-cookie")?.includes("Max-Age=0"));
    assertEquals((await f.result(logout)).status, 200);
    assertEquals(f.executions.logout, 1);
    assertEquals(
      (await f.request(`/operations/${ordinary}/result`)).status,
      404,
    );
    f.metadata({ callerTag: "changed" });
    assertEquals(
      (await f.request("/actions/logout", {}, {
        "idempotency-key": "strict-logout",
      })).status,
      409,
    );
    f.metadata({});
    for (
      const headers of [
        { "idempotency-key": "fresh-logout" },
        {
          "idempotency-key": "strict-logout",
          "x-copilotz-credential-proof": "z".repeat(64),
        },
        { "idempotency-key": "strict-logout", "x-tenant": "other" },
      ]
    ) {
      assertEquals(
        (await f.request(
          "/actions/logout",
          {},
          Object.fromEntries(
            Object.entries(headers).filter((entry): entry is [string, string] =>
              typeof entry[1] === "string"
            ),
          ),
        )).status,
        403,
      );
    }
    assertEquals(
      (await f.request("/actions/logout", { changed: true }, {
        "idempotency-key": "strict-logout",
      })).status,
      409,
    );
    f.denyOperationReads();
    assertEquals(
      (await f.request("/actions/logout", {}, {
        "idempotency-key": "strict-logout",
      })).status,
      202,
    );
    f.allowOperationReads();
    now += 16 * 60 * 1000;
    assertEquals(
      (await f.request("/actions/logout", {}, {
        "idempotency-key": "strict-logout",
      })).status,
      403,
    );
    assertEquals(f.executions.logout, 1);
  } finally {
    await f.close();
  }
});

Deno.test("SEC3 Action cookie rejects cross-site device upgrades and duplicate cookies", async () => {
  const { WebSocket: Socket } = await import("ws");
  const f = await fixture(undefined, false, undefined, true);
  const handler = createServerFacadeFetchHandler(f.app, {
    upgradeDevice: (request) => Deno.upgradeWebSocket(request),
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    handler,
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const sockets: InstanceType<typeof Socket>[] = [];
  try {
    const login = await f.result(await f.submit("login", "security-login"));
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert(cookie.startsWith("__Host-copilotz_session="));
    const { readOwnerDataKey, unwrapOwnerDataKey } = await import(
      "../runtime/actions/owner-data-key.ts"
    );
    const wrapped = await readOwnerDataKey(f.db, f.schema);
    const material = await unwrapOwnerDataKey(f.schema, wrapped!, f.secrets);
    const oldKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(material.subarray(32)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    material.fill(0);
    const [payload, signature] = cookie.slice(cookie.indexOf("=") + 1).split(
      ".",
    );
    const decoded = Uint8Array.from(
      atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    );
    assertEquals(
      await crypto.subtle.verify(
        "HMAC",
        oldKey,
        decoded,
        new TextEncoder().encode(`copilotz.credential.v1.${payload}`),
      ),
      false,
      "credential HMAC must not reuse the shipped commitment key",
    );
    const duplicate = await f.request("/collections/entries", undefined, {
      cookie: `${cookie}; ${cookie}`,
    });
    assertEquals(duplicate.status, 403);
    for (const allowed of [false, true]) {
      const socket = new Socket(origin.replace("http", "ws") + "/api/device", {
        headers: { origin: allowed ? origin : "https://evil.example", cookie },
      });
      sockets.push(socket);
      const admitted = await new Promise<number>((resolve) => {
        socket.on("open", () => resolve(101));
        socket.on("unexpected-response", (_req, response) => {
          response.resume();
          socket.terminate();
          resolve(response.statusCode!);
        });
        socket.on("error", () => {});
      });
      assertEquals(admitted, allowed ? 101 : 403);
      if (allowed) {
        const welcome = new Promise<Record<string, unknown>>((resolve) =>
          socket.once("message", (data) => resolve(JSON.parse(String(data))))
        );
        socket.send(
          JSON.stringify({
            t: "hello",
            version: "1.0",
            capabilities: ["subscriptions"],
            credentials: { cookie: true },
          }),
        );
        assertEquals((await welcome).t, "welcome");
      }
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.shutdown();
    await f.close();
  }
});

Deno.test("session ingress records its actor separately from principal and session basis", async () => {
  const f = await fixture();
  try {
    const login = await f.result(await f.submit("login", "actor-login"));
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const id = await f.submit("logout", "actor-logout", { cookie });
    assertEquals((await f.result(id, { cookie })).status, 200);
    const ingress = (await f.db.query<
      {
        owner_ingress: {
          actor: { id: string; name: string };
          authority: AuthenticatedAuthority;
        };
      }
    >(
      `SELECT owner_ingress FROM "${f.schema}".events WHERE id=$1`,
      [id],
    )).rows[0].owner_ingress;
    assertEquals(ingress.actor, { id: "person", name: "Authenticated actor" });
    assertEquals(ingress.authority.principal.id, "account");
    assertEquals(ingress.authority.authorityBasis.kind, "session");
    assert(
      ingress.authority.authorityBasis.id !== ingress.authority.principal.id,
    );
  } finally {
    await f.close();
  }
});

Deno.test("SEC3 two tabs: logout receipt is proof-bound and session revocation terminates both devices", async () => {
  const { WebSocket: Socket } = await import("ws");
  const { createDeviceTransport } = await import("../client/device.ts");
  const f = await fixture(() => new Date(), true);
  const handler = createServerFacadeFetchHandler(f.app, {
    upgradeDevice: (request) => Deno.upgradeWebSocket(request),
  });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    handler,
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const devices: ReturnType<typeof createDeviceTransport>[] = [];
  const peers: InstanceType<typeof Socket>[] = [];
  try {
    const loginId = await f.submit("login", "two-tabs-login");
    const login = await f.result(loginId);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const tabs = [];
    for (let i = 0; i < 2; i++) {
      const frames: Record<string, unknown>[] = [];
      const auth = Promise.withResolvers<unknown>();
      const closed = Promise.withResolvers<number>();
      const device = createDeviceTransport({
        url: origin.replace("http", "ws") + "/api/device",
        credentials: () => ({ cookie: true }),
        socket(url) {
          const peer = new Socket(url, { headers: { origin, cookie } });
          peers.push(peer);
          peer.on("message", (data) => frames.push(JSON.parse(String(data))));
          peer.on("close", (code) => closed.resolve(code));
          return peer as unknown as WebSocket;
        },
      });
      devices.push(device);
      device.onAuthState(auth.resolve);
      const subscription = await device.observe("entries", {}, {});
      const reader = subscription.frames[Symbol.asyncIterator]();
      assertEquals((await reader.next()).value?.t, "snapshot");
      tabs.push({
        device,
        frames,
        auth: auth.promise,
        closed: closed.promise,
        subscription,
      });
    }
    // Session liveness is independent of collection channel attachment.
    tabs[1].subscription.detach();
    const logoutId = await f.submit("logout", "two-tabs-logout", { cookie });
    const client = createCopilotzClient({
      baseUrl: "https://test/api",
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.set("cookie", cookie);
        request.headers.set("x-copilotz-credential-proof", "a".repeat(64));
        return f.handler(request);
      },
    });
    const clientOutputs: string[] = [];
    await client.operations.observe({
      operationIds: [logoutId],
      onFrame(frame) {
        if (frame.kind === "output") clientOutputs.push(frame.output.type);
      },
    });
    assertEquals(clientOutputs.at(-1), "operation.completed");
    const observed = await f.request("/operations/observe", {
      operationIds: [logoutId],
    }, { cookie });
    assertEquals(observed.status, 200, await observed.clone().text());
    const outputs = [];
    for await (const frame of decodeObservation(observed)) {
      if (frame.kind === "output") outputs.push(frame.output.type);
    }
    assertEquals(outputs, ["operation.completed"]);
    const result = await f.result(logoutId, { cookie });
    assertEquals(result.status, 200, await result.clone().text());
    assertEquals((await result.json()).data, { ok: true });
    for (const tab of tabs) {
      assertEquals(await tab.auth, {
        state: "revoked",
        code: "session_revoked",
      });
      assertEquals(await tab.closed, 4401);
      assert(
        tab.frames.some((frame) =>
          frame.t === "session" && frame.code === "session_revoked"
        ),
      );
      await assertRejects(
        () => tab.device.observe("entries", {}, {}),
        Error,
        "Session revoked",
      );
    }
    // Invalid cookies now fall back to the host's anonymous policy. Deny that
    // ordinary read policy here to isolate the receipt-only recovery exception.
    f.denyOperationReads();
    for (
      const [ids, headers] of [
        [[logoutId], { cookie, "x-copilotz-credential-proof": "b".repeat(64) }],
        [[loginId], { cookie }],
        [[logoutId, loginId], { cookie }],
        [[logoutId], { cookie, "x-tenant": "other" }],
      ] as const
    ) {
      const refused = await f.request("/operations/observe", {
        operationIds: ids,
      }, headers);
      assertEquals(
        refused.status,
        404,
        await refused.text(),
      );
    }
  } finally {
    for (const device of devices) device.close();
    for (const peer of peers) peer.terminate();
    await server.shutdown();
    await f.close();
  }
});

Deno.test("Flow delegates transitive child effects only inside its consumed operation and exact product grants", async () => {
  const f = await fixture();
  try {
    for (const mode of ["allowed", "denied", "outside", "linked"]) {
      const start = await f.result(await f.submit("start", `flow-${mode}`));
      const headers = {
        "x-copilotz-flow": start.headers.get("x-copilotz-flow")!,
      };
      const direct = await f.request("/actions/child", {}, {
        ...headers,
        "idempotency-key": `direct-${mode}`,
      });
      assertEquals(direct.status, 403);
      assertEquals((await direct.json()).error.code, "forbidden");
      const input = { descendants: mode };
      const submit = () =>
        f.request("/actions/callback", input, {
          ...headers,
          "idempotency-key": `callback-${mode}`,
        });
      const before = (await f.db.query(
        `SELECT operation_id FROM "${f.schema}".copilotz_operations`,
      ))
        .rows.length;
      const accepted = await submit();
      assertEquals(accepted.status, 202, await accepted.clone().text());
      const id = (await accepted.json()).data.operationId;
      const response = await f.result(id, headers);
      assertEquals(
        response.status,
        mode === "allowed" ? 200 : 403,
        await response.clone().text(),
      );
      if (mode !== "allowed") {
        assertEquals((await response.json()).error.code, "forbidden");
      }
      if (mode === "outside") {
        assertEquals(
          (await f.db.query(
            `SELECT operation_id FROM "${f.schema}".copilotz_operations WHERE parent_operation_id=$1`,
            [id],
          )).rows,
          [],
        );
      }
      assertEquals(
        (await f.db.query(
          `SELECT operation_id FROM "${f.schema}".copilotz_operations`,
        ))
          .rows.length,
        before + 1,
      );
      if (mode === "allowed") {
        assertEquals((await submit()).status, 202);
        assertEquals((await f.result(id, headers)).status, 200);
        assertEquals(f.executions.child, 1);
        assertEquals(f.executions.grandchild, 1);
        assertEquals(
          (await f.app.host.collections.entries.get({ id: "descendant" }))
            ?.value,
          "committed",
        );
      }
      const after = await f.request("/actions/child", {}, {
        ...headers,
        "idempotency-key": `after-${mode}`,
      });
      assertEquals(after.status, 403);
      assertEquals((await after.json()).error.code, "forbidden");
    }
    assertEquals(f.executions.child, 1);
    assertEquals(f.executions.grandchild, 1);
    assertEquals(f.executions.denied, 0);
    assert(
      f.seen.some(({ intent }) =>
        intent.resource === "denied" && intent.operation === "capture" &&
        intent.invocation?.id === "auth.denied"
      ),
    );
    const receipts = await f.db.query<{ intent: { action: string } }>(
      `SELECT intent FROM "${f.schema}".owner_receipts WHERE kind='flow.descendant'`,
    );
    assertEquals(receipts.rows.map((row) => row.intent.action).sort(), [
      "auth.child",
      "auth.grandchild",
    ]);
  } finally {
    await f.close();
  }
});

for (const path of ["result", "observe"] as const) {
  Deno.test(`SEC3 logout ${path} recovers revocation committed after the initial receipt lookup`, async () => {
    const before = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const f = await fixture(() => new Date(), true, undefined, false, {
      before: before.promise,
      committed: committed.resolve,
      after: finish.promise,
    });
    try {
      const login = await f.result(
        await f.submit("login", `race-${path}-login`),
      );
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const id = await f.submit("logout", `race-${path}-logout`, { cookie });
      let first = true;
      const handler = createServerFacadeFetchHandler({
        ...f.app,
        authorization: {
          ...f.app.authorization,
          async logoutReceipt(authority, operationId) {
            const receipt = await f.app.authorization.logoutReceipt(
              authority,
              operationId,
            );
            if (operationId === id && first) {
              first = false;
              assertEquals(receipt, undefined);
              // Commit the actual revocation between lookup and ordinary admission.
              before.resolve();
              await committed.promise;
            } else if (operationId === id && path === "observe") {
              finish.resolve();
            }
            return receipt;
          },
        },
      });
      const response = await handler(
        new Request(
          `https://test/api/operations/${
            path === "result" ? `${id}/result` : "observe"
          }`,
          {
            method: path === "result" ? "GET" : "POST",
            headers: {
              cookie,
              "x-copilotz-credential-proof": "a".repeat(64),
              "content-type": "application/json",
            },
            ...(path === "observe"
              ? { body: JSON.stringify({ operationIds: [id] }) }
              : {}),
          },
        ),
      );
      assertEquals(
        response.status,
        path === "result" ? 202 : 200,
        response.status >= 400 ? await response.text() : undefined,
      );
      if (path === "observe") {
        const outputs = [];
        for await (const frame of decodeObservation(response)) {
          if (frame.kind === "output") outputs.push(frame.output.type);
        }
        assertEquals(outputs, ["operation.completed"]);
      }
      finish.resolve();
      assertEquals((await f.result(id, { cookie })).status, 200);
    } finally {
      before.resolve();
      finish.resolve();
      await f.close();
    }
  });
}

Deno.test("Flow detached Processors retain the flow; alarms require independent owner authority", async () => {
  let now = Date.now();
  const f = await fixture(() => new Date(now));
  try {
    for (const mode of ["detached", "alarm-denied", "alarm-allowed"]) {
      const start = await f.result(await f.submit("start", `start-${mode}`));
      const headers = {
        "x-copilotz-flow": start.headers.get("x-copilotz-flow")!,
        "idempotency-key": `callback-${mode}`,
      };
      const accepted = await f.request("/actions/callback", {
        descendants: mode,
      }, headers);
      assertEquals(accepted.status, 202);
      const id = (await accepted.json()).data.operationId;
      assertEquals((await f.result(id, headers)).status, 200);
      if (mode === "detached") {
        assertEquals(await f.detached, {
          code: "action_authorization_refused",
          flow: "oauth",
        });
        assertEquals(f.executions.child, 0);
      } else {
        if (mode === "alarm-allowed") f.allowAlarm();
        now += 2000;
        await wakeOwnerAlarms(f.db.session, f.app.engine, ["main"]);
        assertEquals(
          (await f.app.host.collections.entries.get({ id: mode }))?.value,
          mode === "alarm-allowed" ? "alarm" : "pending",
        );
      }
    }
    const alarms = f.seen.filter(({ authority }) =>
      authority.validity.kind === "occurrence"
    );
    assert(alarms.length > 1);
    assert(
      alarms.every(({ authority }) =>
        authority.principal.kind === "host-task" && !authority.flow &&
        authority.provenance.ingress === "alarm"
      ),
    );
    assertEquals(f.executions.child, 0);
  } finally {
    await f.close();
  }
});

Deno.test("SEC3 stale session cookies clear and permit anonymous sign-in, but require 401 for private Actions", async () => {
  let now = Date.now();
  const f = await fixture(
    () => new Date(now),
    true,
    undefined,
    false,
    undefined,
    true,
  );
  try {
    const login = await f.result(await f.submit("login", "stale-login"));
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const logout = await f.submit("logout", "stale-logout", { cookie });
    assertEquals((await f.result(logout, { cookie })).status, 200);
    for (
      const invalid of [
        cookie,
        "__Host-copilotz_session=bad.signature",
        // Keep valid claims but change the first signature byte.
        cookie.replace(
          /\.([A-Za-z0-9_-])/,
          (_, first: string) => `.${first === "A" ? "B" : "A"}`,
        ),
        "__Host-copilotz_session=",
      ]
    ) {
      const denied = await f.request("/actions/logout", {}, {
        cookie: invalid,
        "idempotency-key": crypto.randomUUID(),
      });
      assertEquals(denied.status, 401, await denied.clone().text());
      assertEquals(
        denied.headers.get("set-cookie"),
        "__Host-copilotz_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      );
      const signIn = await f.request("/actions/replay", {}, {
        cookie: invalid,
        "idempotency-key": crypto.randomUUID(),
      });
      assertEquals(signIn.status, 202, await signIn.clone().text());
      assert(
        signIn.headers.get("set-cookie"),
        "Discarded cookie is cleared or replaced on the sign-in response",
      );
      const accepted = (await signIn.json()).data.operationId;
      const fresh = await f.result(accepted, { cookie: invalid });
      assertEquals(fresh.status, 200, await fresh.clone().text());
      assert(/Max-Age=[1-9][0-9]*/.test(fresh.headers.get("set-cookie") ?? ""));
      assert(!fresh.headers.get("set-cookie")?.includes("Max-Age=0"));
      assertEquals(
        f.seen.findLast((entry) =>
          entry.intent.kind === "action" &&
          entry.intent.operation === "admit" &&
          entry.intent.resource === "replay"
        )?.authority.authorityBasis.kind,
        "grant",
      );
    }
    const unknownResult = await f.result(
      await f.submit("replay", "unknown-session"),
    );
    const unknownCookie =
      unknownResult.headers.get("set-cookie")!.split(";")[0];
    await f.db.query(
      `DELETE FROM "${f.schema}".authorization_sessions WHERE principal='replayed'`,
    );
    const unknown = await f.request("/actions/logout", {}, {
      cookie: unknownCookie,
      "idempotency-key": "unknown",
    });
    assertEquals(unknown.status, 401, await unknown.clone().text());
    assert(unknown.headers.get("set-cookie")?.includes("Max-Age=0"));
    now += 3600_001;
    const expired = await f.request("/actions/logout", {}, {
      cookie,
      "idempotency-key": "expired",
    });
    assertEquals(expired.status, 401, await expired.clone().text());
    assert(expired.headers.get("set-cookie")?.includes("Max-Age=0"));
    const duplicate = await f.request("/actions/replay", {}, {
      cookie: `${cookie}; ${cookie}`,
      "idempotency-key": "duplicate-stale",
    });
    assertEquals(duplicate.status, 403);
    assertEquals(
      (await duplicate.json()).error.code,
      "duplicate_session_cookie",
    );
  } finally {
    await f.close();
  }
});
