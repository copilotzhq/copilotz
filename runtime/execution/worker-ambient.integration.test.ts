import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { createServerFacadeFetchHandler } from "../../server/facade.ts";
import { defineServerFacade } from "../../plugins/server/resources/facade/index.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotzGateway } from "../application/gateway.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { authorityDefinitions } from "../testing/worker-authority-fixture.ts";
import { listen } from "../adapters/deno/listen.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { withRetainedAuthority } from "../authorization/binding.ts";
import { testAuthority } from "../testing/authority.ts";
import {
  type AuthorizationIntent,
  authorizationRefused,
} from "../authorization/evaluator.ts";
import { defineDatabaseDirectoryRead } from "../authorization/directory-read.ts";
import { createCopilotzApplication } from "../application/application.ts";

Deno.test("separate worker retains ambient caller authority for Actions, Processors, prepare and directory reads", async () => {
  const database = await createOwnerTestDatabase();
  const workerId = "authority-worker";
  const definitions = authorityDefinitions(() => gateway);
  const seen: Array<
    { principal: string; schema: string; intent: AuthorizationIntent }
  > = [];
  let ownerBinding: Parameters<
    NonNullable<
      NonNullable<Parameters<typeof createCopilotzGateway>[0]>["dispatcher"]
    >
  >[0];
  const hypervisor = createHypervisor({
    transports: [{ type: "websocket", config: { path: "/worker" } }],
    workerCalls: {
      admit: (binding) => ownerBinding.workerCalls.admit(binding),
      admitUnassigned: (binding) =>
        ownerBinding.workerCalls.admitUnassigned!(binding),
      maxPerConnection: 128,
      maxConcurrent: 256,
    },
    ...{
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
    },
  }, {
    onReady(context) {
      if (!context.workerCalls) throw new Error("missing reverse capability");
    },
    onDisconnect: (event) => ownerBinding?.lifecycle?.onDisconnect?.(event),
    onComplete: (event) => ownerBinding?.lifecycle?.onComplete?.(event),
  });
  const directory = await createCopilotzApplication({
    database,
    databaseSchema: "directory",
    namespace: "directory",
    collections: definitions.collections,
  });
  await directory.host.collections.notes.create({
    id: "route",
    tenant: "destination",
    secret: "never-return",
  });
  const gateway = await createCopilotzGateway({
    database,
    namespace: "space",
    ...definitions,
    adapters: { secrets: { default: await testSecretAdapter() } },
    authorization: {
      directoryReads: {
        routing: defineDatabaseDirectoryRead({
          revision: "1",
          databaseSchema: "directory",
          namespace: "directory",
          collection: definitions.collections.notes,
          actions: ["directory"],
          fields: ["tenant"],
          authorize: ({ authority, id }) =>
            authority.principal.id === "writer" && id === "route",
        }),
      },
      policies: {
        fixture: {
          revision: "1",
          sources: [],
          evaluate({ authority, intent }) {
            seen.push({
              principal: authority.principal.id,
              schema: authority.scope.databaseSchema,
              intent,
            });
            if (
              intent.kind === "collection" &&
              authority.principal.id !== "writer"
            ) authorizationRefused();
            return {
              actions: {
                credential: {},
                probe: {},
                prepare: {},
                directory: {},
                ...(authority.principal.id !== "denied" ? { child: {} } : {}),
              },
              sessions: { create: { principal: "account", maxAge: 3600 } },
              flows: {
                start: { login: { continuation: "credential", maxAge: 300 } },
              },
              operations: { metadata: {} },
              events: ["authority.requested"],
              collections: { notes: {} },
              collectionMutations: { notes: { create: {} } },
              directoryReads: authority.principal.id === "writer"
                ? ["routing"]
                : [],
            };
          },
        },
      },
      actions: Object.fromEntries(
        Object.keys(definitions.actions).map((
          key,
        ) => [key, { id: "fixture", revision: "1" }]),
      ),
      collections: { notes: { id: "fixture", revision: "1" } },
    },
    dispatcher: (binding) => {
      ownerBinding = binding;
      return hypervisor;
    },
    target: { workerId },
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  const listener = listen({ hypervisor }, { hostname: "127.0.0.1", port: 0 });
  const url = new URL("/worker", listener.url);
  url.protocol = "ws:";
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      new URL("../testing/worker-authority-process.ts", import.meta.url)
        .pathname,
      url.href,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const ready = async () => {
    let text = "";
    while (!text.includes("WORKER_READY")) {
      const next = await reader.read();
      if (next.done) throw new Error(text);
      text += next.value;
    }
  };
  const as = <T>(id: string, run: () => Promise<T>) =>
    withRetainedAuthority(
      testAuthority("public", "space", id),
      new AbortController().signal,
      run,
    );
  try {
    await ready();
    const handler = createServerFacadeFetchHandler(gateway.application, {
      facade: defineServerFacade({
        authenticate: () => ({
          authority: testAuthority("public", "space", "anonymous"),
        }),
        expose: { actions: true, collections: false, channels: false },
      }),
    });
    const request = (path: string, input?: unknown, key?: string) =>
      handler(
        new Request(`https://test/api${path}`, {
          method: input ? "POST" : "GET",
          headers: {
            "content-type": "application/json",
            "x-copilotz-credential-proof": "a".repeat(64),
            ...(key ? { "idempotency-key": key } : {}),
          },
          ...(input ? { body: JSON.stringify(input) } : {}),
        }),
      );
    const mint = async (input: unknown, key: string) => {
      const admitted = await request("/actions/credential", input, key);
      assertEquals(admitted.status, 202, await admitted.clone().text());
      const id = (await admitted.json()).data.operationId;
      for (let i = 0; i < 200; i++) {
        const response = await request(`/operations/${id}/result`);
        if (response.status !== 202) return response;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Credential result timed out");
    };
    for (
      const [key, input] of Object.entries({
        principal: { principal: "admin", maxAge: 3600 },
        lifetime: { principal: "account", maxAge: 3601 },
        continuation: { continuation: "child", maxAge: 300 },
        flowLifetime: { continuation: "credential", maxAge: 301 },
      })
    ) {
      const refused = await mint(input, `refused-${key}`);
      assertEquals(refused.status, 403, await refused.clone().text());
      assertEquals((await refused.json()).error.code, "forbidden");
      assertEquals(refused.headers.get("set-cookie"), null);
      assertEquals(refused.headers.get("x-copilotz-flow"), null);
      assertEquals(
        (await database.query("SELECT id FROM public.authorization_sessions"))
          .rows,
        [],
      );
      assertEquals(
        (await database.query(
          "SELECT effect_key FROM public.authorization_effects",
        )).rows,
        [],
      );
    }
    const login = await mint(
      { principal: "account", maxAge: 3600 },
      "legitimate-login",
    );
    assertEquals(login.status, 200, await login.clone().text());
    assert(login.headers.get("set-cookie")?.includes("HttpOnly"));
    assert((await login.json()).data.process !== Deno.pid);
    assertEquals(
      (await database.query(
        "SELECT principal FROM public.authorization_sessions",
      )).rows,
      [{ principal: "account" }],
    );
    const flow = await mint(
      { continuation: "credential", maxAge: 300 },
      "legitimate-flow",
    );
    assertEquals(flow.status, 200, await flow.clone().text());
    assert(flow.headers.get("x-copilotz-flow"));

    for (const via of ["captured", "context"]) {
      for (const target of ["child", "write"]) {
        const id = `${via}-${target}`;
        const denied = await assertRejects(() =>
          as(
            "denied",
            () => gateway.actions.probe({ id: `denied-${id}`, via, target }),
          )
        );
        assertEquals((denied as { code: string }).code, "forbidden");
        const result = await as(
          "writer",
          () => gateway.actions.probe({ id, via, target }),
        );
        if (target === "child") {
          assert((result as { process: number }).process !== Deno.pid);
        }
      }
    }
    await assertRejects(
      () =>
        as(
          "writer",
          () => gateway.actions.probe({ id: "foreign", target: "foreign" }),
        ),
      Error,
      "Forbidden",
    );
    await assertRejects(
      () =>
        as(
          "writer",
          () =>
            gateway.actions.probe({ id: "foreign", target: "foreign-schema" }),
        ),
      Error,
      "Forbidden",
    );
    await assertRejects(
      () =>
        as("reader", () => gateway.actions.prepare({ id: "denied-prepare" })),
      Error,
      "Forbidden",
    );
    // Prove refusal happened inside the factory, before the prepared child's
    // own policy could independently refuse its later write.
    assert(seen.some((entry) =>
      entry.principal === "reader" &&
      entry.intent.kind === "collection" &&
      entry.intent.invocation?.id === "authority.prepare"
    ));
    await as("writer", () => gateway.actions.prepare({ id: "prepare" }));
    for (const principal of ["denied", "writer"]) {
      for (const target of ["write", "error"]) {
        const handle = await as(
          principal,
          () =>
            gateway.send({
              type: "authority.requested",
              payload: { id: `${principal}-processor-${target}`, target },
            }),
        );
        try {
          if (principal === "writer") await handle.done;
          else await assertRejects(() => handle.done);
        } finally {
          await handle.detach();
        }
      }
    }
    assertEquals(
      await as(
        "writer",
        () => gateway.actions.directory({ alias: "routing", id: "route" }),
      ),
      { tenant: "destination" },
    );
    await assertRejects(
      () =>
        as(
          "denied",
          () => gateway.actions.directory({ alias: "routing", id: "route" }),
        ),
      Error,
      "Forbidden",
    );
    await assertRejects(
      () =>
        as(
          "writer",
          () => gateway.actions.directory({ alias: "routing", id: "other" }),
        ),
      Error,
      "Forbidden",
    );
    await gateway.collections.notes.create({ id: "host" });
    const records = (await gateway.collections.notes.list()).map((row) =>
      row.id
    ).sort();
    assertEquals(
      records,
      [
        "captured-child",
        "captured-write",
        "context-child",
        "context-write",
        "host",
        "prepare",
        "prepare-child",
        "writer-processor-write",
        "writer-processor-error",
      ].sort(),
    );
    const nested = seen.filter(({ intent }) =>
      intent.resource === "child" && intent.operation === "capture"
    );
    assert(nested.length >= 3);
    assert(
      nested.every((entry) =>
        ["writer", "denied"].includes(entry.principal) &&
        entry.schema === "public" && !!entry.intent.invocation?.parentRunId
      ),
      JSON.stringify(nested),
    );
    assert(
      seen.some((entry) =>
        entry.principal === "denied" &&
        entry.intent.invocation?.id === "authority.processor"
      ),
    );
    const audits = await database.query<
      { intent: { principal: { id: string }; operationId: string } }
    >("SELECT intent FROM public.owner_receipts WHERE kind='authorization.directory'");
    assertEquals(audits.rows.length, 1);
    assertEquals(audits.rows[0].intent.principal.id, "writer");
    assert(audits.rows[0].intent.operationId);
  } finally {
    await child.stdin.getWriter().write(new Uint8Array([1])).catch(() =>
      undefined
    );
    await child.status;
    await reader.cancel();
    reader.releaseLock();
    await gateway.shutdown();
    await hypervisor.shutdown();
    await listener.shutdown();
    await directory.close();
    await database.close();
  }
});
