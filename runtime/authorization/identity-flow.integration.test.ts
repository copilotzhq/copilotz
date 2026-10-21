import { assert, assertEquals, assertRejects } from "@std/assert";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { testAuthority } from "../testing/authority.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import {
  identityFlowDefinitions,
  type LoginInput,
} from "../testing/identity-flow-definitions.ts";
import { createCopilotzApplication } from "../application/application.ts";
import { createCopilotzGateway } from "../application/gateway.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";
import { listen } from "../adapters/deno/listen.ts";
import { createServerFacadeFetchHandler } from "../../server/facade.ts";
import { defineServerFacade } from "../../plugins/server/resources/facade/index.ts";
import {
  defineIdentityVerifier,
  readIdentityEvidence,
} from "./identity-evidence.ts";
import { defineDatabaseDirectoryCommand } from "./directory-command.ts";
import { authorizationRefused, type OwnerAuthorization } from "./evaluator.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import type { AuthenticatedAuthority } from "./authority.ts";

async function fixture(remote: boolean) {
  const db = await createOwnerTestDatabase();
  const directory = await createCopilotzApplication({
    database: db,
    databaseSchema: "directory",
    namespace: "directory",
  });
  await db.query(
    'CREATE TABLE "directory".identities(id text PRIMARY KEY, namespace text NOT NULL, member boolean NOT NULL DEFAULT false)',
  );
  let exchanges = 0, prepares = 0, memberships = 0;
  let sourceAllowed = true, destinationAllowed = true, processorAllowed = true;
  let verifierFail = false;
  const policyProcessors: string[] = [];
  const policyInputs: string[] = [];
  const definition = (command: string) =>
    defineDatabaseDirectoryCommand({
      databaseSchema: "directory",
      namespace: "directory",
      command,
      revision: "1",
      actions: ["login"],
      evidence: ["provider"],
      async authorize({ authority, input, evidence }) {
        return destinationAllowed && authority.scope.tenant === "fixture" &&
          (await evidence.get("provider"))?.principal ===
            (input as { account: string }).account;
      },
      async execute({ transaction, input, databaseSchema, namespace }) {
        const value = input as { account: string; fail?: boolean };
        assertEquals(databaseSchema, "directory");
        if (command === "prepareLogin") {
          prepares++;
          await transaction.query(
            'INSERT INTO "directory".identities(id,namespace) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [value.account, namespace],
          );
        } else {
          memberships++;
          const account = await transaction.query(
            "SELECT id FROM public.nodes WHERE namespace=$1 AND type=$2 AND id=$3",
            ["space", "identity_account", value.account],
          );
          assertEquals(account.rows.length, 1);
          await transaction.query(
            'UPDATE "directory".identities SET member=true WHERE id=$1 AND namespace=$2',
            [value.account, namespace],
          );
        }
        if (value.fail) {
          throw new Error("Injected directory failure after write");
        }
        return { account: value.account };
      },
    });
  const authorization: OwnerAuthorization = {
    identityVerifiers: {
      provider: defineIdentityVerifier({
        revision: "1",
        actions: ["login"],
        verify(input, { binding, exchangeKey }) {
          exchanges++;
          assertEquals(binding.tenant, "fixture");
          assertEquals(binding.namespace, "space");
          assertEquals(binding.databaseSchema, "public");
          assert(
            binding.flow && binding.operationId && binding.proof && exchangeKey,
          );
          if (verifierFail) throw new Error("Provider outcome unknown");
          if ((input as { code: string }).code !== "valid") {
            authorizationRefused();
          }
          return Promise.resolve({
            issuer: "https://issuer.example",
            subject: "subject",
            principal: "account",
            claims: { email_verified: true },
          });
        },
      }),
    },
    directoryCommands: {
      prepare: definition("prepareLogin"),
      membership: definition("publishMembership"),
    },
    policies: {
      fixture: {
        revision: "1",
        sources: ["accounts"],
        evidence: ["provider"],
        async evaluate({ authority, intent, evidence, read }) {
          const verified =
            authority.flow && ["session", "directory"].includes(intent.kind)
              ? await evidence.get("provider")
              : null;
          if (intent.invocation?.kind === "processor") {
            policyProcessors.push(intent.invocation.id);
            policyInputs.push(
              (intent.input as { args: { input: { id: string } } }).args.input
                .id,
            );
            const current = await read.get(
              "accounts",
              (intent.input as { args: { input: { id: string } } }).args.input
                .id.replace(/^mirror:/, ""),
            );
            if (
              !current || current.issuer !== "https://issuer.example" ||
              current.subject !== "subject"
            ) authorizationRefused();
          }
          return {
            actions: { login: {}, child: {} },
            operations: { metadata: {} },
            identityVerifiers: ["provider"],
            directoryCommands: sourceAllowed && verified
              ? ["prepare", "membership"]
              : [],
            sessions: verified
              ? { create: { principal: verified.principal, maxAge: 3600 } }
              : {},
            flows: { start: { oidc: { continuation: "login", maxAge: 300 } } },
            flowProcessors: processorAllowed ? ["identity.projection"] : [],
            collections: { accounts: {}, mirrors: {} },
            collectionMutations: {
              accounts: { create: {} },
              mirrors: { create: { fields: ["blocked"] } },
            },
          };
        },
      },
    },
    actions: {
      login: { id: "fixture", revision: "1" },
      child: { id: "fixture", revision: "1" },
    },
    collections: {
      accounts: { id: "fixture", revision: "1" },
      mirrors: { id: "fixture", revision: "1" },
    },
  };
  const common = {
    database: db,
    namespace: "space",
    ...identityFlowDefinitions,
    authorization,
    adapters: { secrets: { default: await testSecretAdapter() } },
    engine: { retryBaseMs: 0, random: () => 0 },
  };
  let ownerBinding: Parameters<
    NonNullable<
      NonNullable<Parameters<typeof createCopilotzGateway>[0]>["dispatcher"]
    >
  >[0];
  const hypervisor = remote
    ? createHypervisor({
      transports: [{ type: "websocket", config: { path: "/worker" } }],
      workerCalls: {
        admit: (b) => ownerBinding.workerCalls.admit(b),
        admitUnassigned: (b) => ownerBinding.workerCalls.admitUnassigned!(b),
        maxPerConnection: 128,
        maxConcurrent: 256,
      },
      ...{
        admit(context) {
          return {
            definition: {
              workerId: "identity-worker",
              providerId: "test",
              workloads: [...context.workloads],
              capacity: context.capacity,
              providerConfig: {},
              labels: {},
            },
            sessionGeneration: 1,
            authenticatedWith: context.credential.kind,
            resume: {
              credential: { kind: "resume", capability: "resume" },
              expiresAtMs: Date.now() + 60000,
            },
          };
        },
      },
    }, {
      onReady() {},
      onDisconnect: (event) => ownerBinding?.lifecycle?.onDisconnect?.(event),
      onComplete: (event) => ownerBinding?.lifecycle?.onComplete?.(event),
    })
    : undefined;
  const gateway = hypervisor
    ? await createCopilotzGateway({
      ...common,
      dispatcher: (binding) => {
        ownerBinding = binding;
        return hypervisor;
      },
      target: { workerId: "identity-worker" },
    })
    : undefined;
  const app = gateway?.application ?? await createCopilotzApplication(common);
  const listener = hypervisor
    ? listen({ hypervisor }, { hostname: "127.0.0.1", port: 0 })
    : undefined;
  const url = listener && new URL("/worker", listener.url);
  if (url) url.protocol = "ws:";
  const child = url
    ? new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        new URL("../testing/identity-flow-worker.ts", import.meta.url).pathname,
        url.href,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn()
    : undefined;
  const reader = child?.stdout.pipeThrough(new TextDecoderStream()).getReader();
  if (reader) {
    let output = "";
    while (!output.includes("WORKER_READY")) {
      const next = await reader.read();
      if (next.done) throw new Error(output);
      output += next.value;
    }
  }
  const handler = createServerFacadeFetchHandler(app, {
    facade: defineServerFacade({
      authenticate: (request) => ({
        authority: {
          ...testAuthority("public", "space", "anonymous"),
          scope: {
            ...testAuthority("public", "space").scope,
            tenant: request.headers.get("x-tenant") ?? "fixture",
          },
        },
      }),
      expose: { actions: true, collections: false, channels: false },
    }),
  });
  let serial = 0;
  const request = (
    path: string,
    input?: unknown,
    headers: Record<string, string> = {},
  ) =>
    handler(
      new Request(`https://test/api${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-copilotz-credential-proof": "a".repeat(64),
          ...headers,
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
    );
  const result = async (id: string, headers: Record<string, string> = {}) => {
    for (let i = 0; i < 300; i++) {
      const r = await request(`/operations/${id}/result`, undefined, headers);
      if (r.status !== 202) return r;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Result timed out");
  };
  const start = async () => {
    const r = await request("/actions/login", { start: true }, {
      "idempotency-key": `start-${++serial}`,
    });
    assertEquals(r.status, 202, await r.clone().text());
    const id = (await r.json()).data.operationId;
    const terminal = await result(id);
    assertEquals(terminal.status, 200, await terminal.clone().text());
    return { "x-copilotz-flow": terminal.headers.get("x-copilotz-flow")! };
  };
  const submit = async (
    input: LoginInput,
    headers: Record<string, string>,
    key = `login-${++serial}`,
  ) => {
    const accepted = await request("/actions/login", input, {
      ...headers,
      "idempotency-key": key,
    });
    assertEquals(accepted.status, 202, await accepted.clone().text());
    return { id: (await accepted.json()).data.operationId as string, key };
  };
  const retained = async (id: string): Promise<AuthenticatedAuthority> => {
    const row =
      (await db.query<{ owner_ingress: { authority: AuthenticatedAuthority } }>(
        `SELECT event.owner_ingress FROM public.events AS event
       JOIN public.copilotz_operations AS operation ON operation.root_event_id=event.id
       WHERE operation.operation_id=$1`,
        [id],
      )).rows[0];
    return row.owner_ingress.authority;
  };
  const readEvidence = (authority: AuthenticatedAuthority) =>
    createSchemaCommandRunner(db, "public")(
      "test.evidence",
      {},
      (_, command) =>
        readIdentityEvidence(authorization, authority, "provider", command),
    );
  const delivery = async (type: string) => {
    for (let i = 0; i < 300; i++) {
      const row =
        (await db.query<{ status: string; last_error: { code?: string } }>(
          `SELECT delivery.status,delivery.last_error FROM public.event_deliveries AS delivery
         JOIN public.events AS event ON event.id=delivery.event_id
         WHERE event.type=$1 AND delivery.consumer_id='processor:identity.projection'`,
          [type],
        )).rows[0];
      if (row && ["succeeded", "dead_letter"].includes(row.status)) return row;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Processor did not settle");
  };
  return {
    retained,
    readEvidence,
    delivery,
    app,
    db,
    authorization,
    request,
    result,
    start,
    submit,
    counts: () => ({ exchanges, prepares, memberships }),
    policyProcessors,
    policyInputs,
    source: (allow: boolean) => sourceAllowed = allow,
    destination: (allow: boolean) => destinationAllowed = allow,
    processor: (allow: boolean) => processorAllowed = allow,
    verifierFail: () => verifierFail = true,
    async close() {
      if (child) {
        await child.stdin.getWriter().write(new Uint8Array([1]));
        await child.status;
        await reader!.cancel();
        reader!.releaseLock();
      }
      if (gateway) await gateway.shutdown();
      else await app.close();
      await hypervisor?.shutdown();
      await listener?.shutdown();
      await directory.close();
      await db.close();
    },
  };
}
for (const remote of [false, true]) {
  Deno.test(`${remote ? "remote worker" : "owner local"}: verified login, atomic directory provisioning and bounded Processor projection`, async () => {
    const f = await fixture(remote);
    try {
      const flow = await f.start();
      const submitted = await f.submit({}, flow);
      const response = await f.result(submitted.id, flow);
      assertEquals(response.status, 200, await response.clone().text());
      assert(response.headers.get("set-cookie"));
      const data = (await response.json()).data;
      assertEquals(data.account, "account");
      assertEquals(data.process === Deno.pid, !remote);
      assertEquals(f.counts(), { exchanges: 1, prepares: 1, memberships: 1 });
      assertEquals(
        (await f.db.query('SELECT id,member FROM "directory".identities')).rows,
        [{ id: "account", member: true }],
      );
      const replay = await f.submit({}, flow, submitted.key);
      assertEquals(replay.id, submitted.id);
      assertEquals((await f.result(replay.id, flow)).status, 200);
      assertEquals(f.counts(), { exchanges: 1, prepares: 1, memberships: 1 });
      let mirror;
      for (let i = 0; i < 200; i++) {
        mirror = await f.app.host.collections.mirrors.get({
          id: "mirror:account",
        });
        if (mirror) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(mirror?.blocked, [
        "operation",
        "session",
        "identity",
        "directory",
        "action",
      ]);
      assert(f.policyProcessors.includes("identity.projection"));
      const outside = await f.delivery("identity_mirror.created");
      assertEquals(outside.status, "dead_letter");
      assertEquals(outside.last_error.code, "forbidden");
      assert(!f.policyInputs.includes("outside"));
      assertEquals(
        await f.app.host.collections.mirrors.get({ id: "outside" }),
        null,
      );
      const authority = await f.retained(submitted.id);
      assertEquals((await f.readEvidence(authority))?.principal, "account");
      for (
        const scope of [
          { ...authority.scope, tenant: "other" },
          { ...authority.scope, namespace: "other" },
          { ...authority.scope, databaseSchema: "directory" },
          {
            ...authority.scope,
            bindings: {
              ...authority.scope.bindings,
              "@credential-proof": "b".repeat(64),
            },
          },
        ]
      ) {
        const error = await assertRejects(() =>
          f.readEvidence({ ...authority, scope })
        );
        assertEquals((error as { code: string }).code, "forbidden");
      }
      const otherFlow = await f.start();
      const other = await f.submit(
        { forged: true, principal: "account" },
        otherFlow,
      );
      assertEquals((await f.result(other.id, otherFlow)).status, 403);
      assertEquals(await f.readEvidence(await f.retained(other.id)), null);
      const audits = (await f.db.query<{ intent: unknown; result: unknown }>(
        "SELECT intent,result FROM public.owner_receipts WHERE kind IN ('identity.audit','directory.audit')",
      )).rows;
      assertEquals(audits.length, 3);
      assert(!JSON.stringify(audits).includes("email_verified"));
      assert(!JSON.stringify(audits).includes('"code"'));
    } finally {
      await f.close();
    }
  });
  Deno.test(`${remote ? "remote worker" : "owner local"}: forged evidence, source/destination refusal and partial directory failures leave no login`, async () => {
    for (
      const mode of ["forged", "source", "destination", "rollback", "caught"]
    ) {
      const f = await fixture(remote);
      try {
        if (mode === "source") f.source(false);
        if (mode === "destination") f.destination(false);
        const flow = await f.start();
        const submitted = await f.submit({
          forged: mode === "forged",
          rollback: mode === "rollback",
          caught: mode === "caught",
        }, flow);
        const response = await f.result(submitted.id, flow);
        assertEquals(
          response.status,
          ["rollback", "caught"].includes(mode) ? 422 : 403,
          await response.clone().text(),
        );
        if (response.status === 403) {
          assertEquals((await response.json()).error.code, "forbidden");
        }
        assertEquals(response.headers.get("set-cookie"), null);
        assertEquals(
          (await f.db.query('SELECT id FROM "directory".identities')).rows,
          [],
        );
        assertEquals(
          (await f.db.query(
            "SELECT id FROM public.nodes WHERE type='identity_account'",
          )).rows,
          [],
        );
        assertEquals(
          (await f.db.query("SELECT id FROM public.authorization_sessions"))
            .rows,
          [],
        );
        assertEquals(
          (await f.db.query(
            "SELECT key FROM public.owner_receipts WHERE kind='directory.audit'",
          )).rows,
          [],
        );
        assertEquals(
          (await f.db.query(
            "SELECT effect_key FROM public.authorization_effects WHERE method='session.create'",
          )).rows,
          [],
        );
        if (mode === "forged") {
          assertEquals(
            (await f.db.query(
              "SELECT key FROM public.owner_receipts WHERE kind='identity.evidence'",
            )).rows,
            [],
          );
        }
        assertEquals(f.counts().exchanges, mode === "forged" ? 0 : 1);
      } finally {
        await f.close();
      }
    }
  });
  Deno.test(`${remote ? "remote worker" : "owner local"}: directory command replay, changed exchange input, pending exchanges and Processor policy denial`, async () => {
    for (
      const mode of [
        "commandReplay",
        "changed",
        "retryUnknown",
        "processorDenied",
      ]
    ) {
      const f = await fixture(remote);
      try {
        if (mode === "retryUnknown") f.verifierFail();
        if (mode === "processorDenied") f.processor(false);
        const flow = await f.start();
        const input = { [mode]: true };
        const submitted = await f.submit(input, flow);
        const response = await f.result(submitted.id, flow);
        assertEquals(
          response.status,
          mode === "changed" ? 403 : 200,
          await response.clone().text(),
        );
        const body = await response.json();
        if (mode === "changed") assertEquals(body.error.code, "forbidden");
        if (mode === "commandReplay") {
          assertEquals(body.data.first, body.data.second);
          assertEquals(f.counts().prepares, 1);
        }
        if (mode === "retryUnknown") {
          assertEquals(body.data.code, "identity_evidence_pending");
          assertEquals(
            await f.readEvidence(await f.retained(submitted.id)),
            null,
          );
          assertEquals(
            (await f.db.query(
              "SELECT result->>'state' AS state FROM public.owner_receipts WHERE kind='identity.evidence'",
            )).rows,
            [{ state: "pending" }],
          );
        }
        if (mode === "processorDenied") {
          const delivery = await f.delivery("identity_account.created");
          assertEquals(delivery.status, "dead_letter");
          assertEquals(delivery.last_error.code, "forbidden");
          assert(f.policyProcessors.length > 0);
          assertEquals(
            await f.app.host.collections.mirrors.get({ id: "mirror:account" }),
            null,
          );
        } else assertEquals(response.headers.get("set-cookie"), null);
        assertEquals(f.counts().exchanges, 1);
        const replay = await f.submit(input, flow, submitted.key);
        assertEquals(replay.id, submitted.id);
        assertEquals((await f.result(replay.id, flow)).status, response.status);
        assertEquals(f.counts().exchanges, 1);
      } finally {
        await f.close();
      }
    }
  });
}
