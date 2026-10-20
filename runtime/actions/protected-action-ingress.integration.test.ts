import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCopilotzApplication } from "../application/application.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testAuthority } from "../testing/authority.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { defineAction } from "./define.ts";
import { secret } from "./secret.ts";
import { defineCollection } from "../collections/definition.ts";
import { definePlugin } from "../plugins/index.ts";
import {
  defineServerFacade,
  serverPlugin,
} from "../../plugins/server/index.ts";
import { createCopilotzClient } from "../../client/index.ts";
import { createServerFacadeFetchHandler } from "../../server/facade.ts";
import { authorizationRefused } from "../authorization/evaluator.ts";
import {
  assertOwnerIngressReplay,
  authorityIngressProof,
  hostIngressProof,
  ownerIngressEvidence,
  withIngressRequestMetadata,
} from "../application/ingress/authority.ts";
import { credentialValidity } from "../authorization/authority.ts";
import type { EventMutationContext } from "../events/store.ts";

Deno.test("owner Action admission inserts trusted fields, retains first capture and independently reauthorizes result access", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `ingress_${crypto.randomUUID().replaceAll("-", "")}`;
  let uses = 0;
  const member = defineCollection({
    name: "credential",
    schema: { type: "object" },
  });
  const action = defineAction({
    id: "fixture.authorized",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        credential: secret({ type: "string" }),
      },
      required: ["label", "credential"],
      additionalProperties: false,
    } as const,
    execute(input: { label: string; credential: string }, context) {
      assertEquals(input.credential, "first-secret");
      assertEquals(context.action.metadata.ownerSelected, true);
      uses++;
      return { ok: true };
    },
  });
  const facade = defineServerFacade({
    expose: { actions: true, collections: false, channels: false },
    authenticate(_request, context) {
      return {
        namespace: "space",
        databaseSchema: schema,
        authority: {
          ...testAuthority(schema),
          requestFacts: {
            ...testAuthority(schema).requestFacts,
            transport: "http",
            endpoint: context.endpoint.key,
          },
          provenance: { ingress: "http", source: context.endpoint.key },
        },
      };
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    databaseSchema: schema,
    namespace: "space",
    adapters: { secrets: { default: await testSecretAdapter() } },
    collections: { member },
    actions: { use: action },
    plugins: [
      definePlugin({
        ...serverPlugin,
        resources: { server: { default: facade } },
      }),
    ],
    authorization: {
      policies: {
        fixture: {
          revision: "1",
          sources: ["member"],
          async evaluate({ read }) {
            const key = await read.get("member", "member");
            if (!key?.active) authorizationRefused();
            return {
              actions: { use: { input: { credential: key.credential } } },
              actionMetadata: { ownerSelected: true },
              operations: { metadata: { principal: "member" } },
            };
          },
        },
      },
      collections: {},
      actions: { use: { id: "fixture", revision: "1" } },
    },
  });
  const handler = createServerFacadeFetchHandler(app);
  const client = createCopilotzClient({
    baseUrl: "https://fixture.invalid/api",
    fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
  });
  const members = app.collections.withScope({ namespace: "space" }).credential;
  try {
    await members.create({
      id: "member",
      active: true,
      credential: "first-secret",
    });
    const receipt = await client.actions.submit(action.id, { label: "one" }, {
      idempotencyKey: "one",
    });
    assertEquals((await client.operations.result(receipt.operationId)).value, {
      ok: true,
    });
    assertEquals(uses, 1);
    const duplicate = await client.actions.submit(action.id, { label: "one" }, {
      idempotencyKey: "one",
    });
    assertEquals(duplicate.operationId, receipt.operationId);
    assertEquals(uses, 1);
    await assertRejects(() =>
      client.actions.submit(action.id, {
        label: "forged",
        credential: "client-secret",
      }, { idempotencyKey: "forged" })
    );
    await members.update({ id: "member", set: { active: false } });
    await assertRejects(() => client.operations.result(receipt.operationId));
    await assertRejects(() =>
      client.actions.submit(action.id, { label: "one" }, {
        idempotencyKey: "one",
      })
    );
    const rows = await db.query<{ authority: unknown }>(
      `SELECT authority FROM "${schema}".authorization_invocations`,
    );
    assertEquals(rows.rows.length, 1);
    assert(!JSON.stringify(rows.rows).includes("first-secret"));
  } finally {
    await app.close();
    await db.close();
  }
});

Deno.test("renewed admission cannot replace first ingress, scope, principal or attempt identity", async () => {
  const authority = testAuthority("proof");
  const proof = authorityIngressProof(authority);
  const event = {
    id: "root",
    namespace: "space",
    type: "requested",
    payload: {},
    ownerIngress: ownerIngressEvidence(proof),
  };
  const context = {} as EventMutationContext;
  const renewed = {
    ...authority,
    validity: credentialValidity(new Date(Date.now() + 1000)),
  };
  await assertOwnerIngressReplay(
    context,
    "proof",
    event,
    {},
    authorityIngressProof(renewed),
  );
  await assertRejects(() =>
    assertOwnerIngressReplay(
      context,
      "proof",
      event,
      {},
      authorityIngressProof(testAuthority("proof", "space", "another-key")),
    )
  );
  await assertRejects(() =>
    assertOwnerIngressReplay(
      context,
      "proof",
      event,
      {},
      authorityIngressProof({
        ...authority,
        scope: { ...authority.scope, tenant: "other" },
      }),
    )
  );
  await assertOwnerIngressReplay(
    context,
    "proof",
    { ...event, ownerIngress: undefined },
    {},
    proof,
  );
  assertEquals(event.ownerIngress, ownerIngressEvidence(proof));
  assertThrows(() =>
    defineServerFacade({
      authorize() {
        return {};
      },
    } as never)
  );
  assertThrows(() =>
    defineServerFacade({ protectedBootstrapRoutes: ["route"] } as never)
  );
});

Deno.test("raw credential metadata does not change trusted host ingress replay", async () => {
  const original = hostIngressProof();
  const admitted = withIngressRequestMetadata(original, {
    operationMetadata: { label: "host" },
  });
  assertEquals(ownerIngressEvidence(admitted), { kind: "host" });
  await assertOwnerIngressReplay(
    {} as EventMutationContext,
    "host",
    {
      id: "host-operation",
      namespace: "main",
      type: "requested",
      payload: {},
      ownerIngress: ownerIngressEvidence(admitted),
    },
    {},
    original,
  );
});
