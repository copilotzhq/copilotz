import { assertEquals, assertThrows } from "@std/assert";
import {
  createFixedBodyStoreAdapter,
  createMemoryBodyStore,
} from "./body-store.ts";
import {
  createPromotedBodyStore,
  createPromotedBodyStoreAdapter,
  promotedReadyStore,
  promoteLogicalBody,
} from "./promoted-body-store.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createContentCatalog, openLogicalBody } from "./catalog.ts";
import { digestContent } from "./digest.ts";
async function fixture() {
  const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    }),
    schema = "content_promotion_test";
  if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await provisionCopilotzSchema(db, schema);
  const catalog = createContentCatalog(db, schema),
    staging = createMemoryBodyStore({ backendId: "memory:staging" }),
    ready = createMemoryBodyStore({ backendId: "memory:ready" });
  const data = new Uint8Array(1024 * 1024 + 20).fill(7),
    digest = await digestContent(data),
    identity = { bodyId: "logical-a", writerId: "writer-a", generation: 1 };
  await catalog.reserve({
    ...identity,
    namespace: "namespace-a",
    copy: {
      key: "staging-key",
      backendKind: staging.kind,
      backendId: staging.backendId,
    },
  });
  const head = await staging.put({
    bodyId: "staging-key",
    bytes: data,
    mediaType: "application/octet-stream",
    digest,
  });
  await catalog.checkpoint({
    ...identity,
    expectedOffset: 0,
    offset: data.length,
  });
  await catalog.sealIntent({ ...identity, length: data.length, digest });
  await catalog.sealAccepted({ ...identity, head });
  return {
    db,
    catalog,
    staging,
    ready,
    data,
    head,
    storeFor: (copy: { backendId: string }) =>
      copy.backendId === ready.backendId ? ready : staging,
  };
}
Deno.test("promoted physical adapter reads and maintenance have no promotion or cleanup effects", async () => {
  const f = await fixture();
  try {
    const store = createPromotedBodyStore({
      staging: f.staging,
      ready: f.ready,
    });
    assertEquals(store.backendId, f.staging.backendId);
    await store.head({ bodyId: "staging-key" });
    await new Response(await store.read({ bodyId: "staging-key" }))
      .arrayBuffer();
    await store.maintenance.list({
      states: ["ready"],
      idleForMs: 0,
      limit: 10,
    });
    assertEquals(await f.ready.head({ bodyId: "staging-key" }), null);
    assertEquals(
      (await f.staging.head({ bodyId: "staging-key" }))?.state,
      "ready",
    );
    assertEquals(promotedReadyStore(store), f.ready);
  } finally {
    await f.db.close();
  }
});
Deno.test("owner promotion switches only verified targets and leaves old-copy retirement separate", async () => {
  const f = await fixture();
  try {
    assertEquals(
      await promoteLogicalBody({
        ...f,
        bodyId: "logical-a",
        target: f.ready,
        targetKey: "target-a",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      true,
    );
    assertEquals((await f.catalog.read("logical-a"))?.copy.key, "target-a");
    assertEquals(
      (await f.staging.head({ bodyId: "staging-key" }))?.state,
      "ready",
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("active immutable read survives copy switch and immediate old-copy deletion without replay", async () => {
  const f = await fixture();
  try {
    const reader = (await openLogicalBody(f.catalog, "logical-a", f.storeFor))
      .getReader();
    const first = await reader.read();
    assertEquals(first.value?.length, 1024 * 1024);
    await promoteLogicalBody({
      ...f,
      bodyId: "logical-a",
      target: f.ready,
      targetKey: "target-a",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await f.staging.maintenance.delete({
      bodyId: "staging-key",
      expectedState: "ready",
      expectedVersionToken: f.head.versionToken,
      idleForMs: 0,
    });
    const second = await reader.read();
    assertEquals(second.value?.length, 20);
    assertEquals((await reader.read()).done, true);
  } finally {
    await f.db.close();
  }
});
Deno.test("expired promotion target is orphaned and never selected", async () => {
  const f = await fixture();
  try {
    assertEquals(
      await promoteLogicalBody({
        ...f,
        bodyId: "logical-a",
        target: f.ready,
        targetKey: "late",
        expiresAt: new Date(0).toISOString(),
      }),
      false,
    );
    assertEquals((await f.catalog.read("logical-a"))?.copy.key, "staging-key");
    assertEquals(
      (await f.catalog.read("logical-a"))?.promotionTarget,
      undefined,
    );
    assertEquals((await f.ready.head({ bodyId: "late" }))?.state, "ready");
  } finally {
    await f.db.close();
  }
});
Deno.test("promotion reconciles an acknowledged-lost upload and verifies its exact winner", async () => {
  const f = await fixture();
  try {
    const target = {
      ...f.ready,
      async put(input: Parameters<typeof f.ready.put>[0]) {
        await f.ready.put(input);
        throw new Error("lost response");
      },
    };
    assertEquals(
      await promoteLogicalBody({
        ...f,
        bodyId: "logical-a",
        target,
        targetKey: "unknown",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      true,
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("missing promotion source does not switch the catalog", async () => {
  const f = await fixture();
  try {
    await f.staging.maintenance.delete({
      bodyId: "staging-key",
      expectedState: "ready",
      expectedVersionToken: f.head.versionToken,
      idleForMs: 0,
    });
    assertEquals(
      await promoteLogicalBody({
        ...f,
        bodyId: "logical-a",
        target: f.ready,
        targetKey: "missing",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      false,
    );
    assertEquals((await f.catalog.read("logical-a"))?.copy.key, "staging-key");
    assertEquals(
      (await f.catalog.read("logical-a"))?.promotionTarget,
      undefined,
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("promoted adapter requires durable cluster stores and caches trusted scopes", () => {
  const staging = createMemoryBodyStore(), ready = createMemoryBodyStore();
  assertThrows(() => createPromotedBodyStore({ staging, ready: staging }));
  const adapter = (store: typeof staging, readyGarbageCollection = true) =>
    createFixedBodyStoreAdapter(store, {
      durability: "durable",
      reach: "cluster",
      readyGarbageCollection,
    });
  const composed = createPromotedBodyStoreAdapter({
      staging: adapter(staging),
      ready: adapter(ready, false),
    }),
    scope = { namespace: "namespace-a", databaseSchema: "schema_a" };
  assertEquals(composed.forScope(scope), composed.forScope(scope));
  assertEquals(composed.deployment, adapter(ready, false).deployment);
  assertEquals(composed.forScope(scope).conditionalDelete, true);
});

Deno.test("active stream follower survives a disappearing copy with no duplicate delivery", async () => {
  const f = await fixture();
  try {
    const { createContentStreamRuntime } = await import("../streams/stream.ts");
    const runtime = createContentStreamRuntime({
      namespace: "namespace-a",
      store: f.staging,
      catalog: f.catalog,
      storeForCopy: f.storeFor,
      onOpen(_s, p) {
        p.established();
      },
    });
    const writer = await runtime.open({
      id: "switching",
      mediaType: "application/octet-stream",
      role: "attachment",
    });
    await writer.append({
      appendId: "first",
      bytes: f.data.slice(0, 1024 * 1024),
    });
    await writer.append({ appendId: "last", bytes: f.data.slice(1024 * 1024) });
    await writer.close({ assetId: "unused" });
    const bodyId = "content-streams/namespace-a/switching",
      old = (await f.staging.head({ bodyId }))!,
      reader = (await runtime.follow({ id: writer.id })).body.getReader();
    assertEquals((await reader.read()).value?.length, 1024 * 1024);
    await promoteLogicalBody({
      ...f,
      bodyId,
      target: f.ready,
      targetKey: "follow-target",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await f.staging.maintenance.delete({
      bodyId,
      expectedState: "ready",
      expectedVersionToken: old.versionToken,
      idleForMs: 0,
    });
    assertEquals((await reader.read()).value?.length, 20);
    assertEquals((await reader.read()).done, true);
  } finally {
    await f.db.close();
  }
});

Deno.test("configured staging-ready stream completion promotes through the owner catalog", async () => {
  const f = await fixture();
  try {
    const { createContentStreamRuntime } = await import("../streams/stream.ts");
    const store = createPromotedBodyStore({
        staging: f.staging,
        ready: f.ready,
      }),
      runtime = createContentStreamRuntime({
        namespace: "namespace-a",
        store,
        catalog: f.catalog,
        onOpen(_s, p) {
          p.established();
        },
      });
    const writer = await runtime.open({
      id: "configured",
      mediaType: "text/plain",
      role: "body",
    });
    await writer.append({
      appendId: "one",
      bytes: new TextEncoder().encode("promoted"),
    });
    const pending = await writer.close({ assetId: "unused" }),
      logical =
        (await f.catalog.read("content-streams/namespace-a/configured"))!;
    assertEquals(logical.copy.backendId, f.ready.backendId);
    assertEquals(
      (await f.ready.head({ bodyId: logical.copy.key }))?.state,
      "ready",
    );
    assertEquals(
      (await f.staging.head({
        bodyId: "content-streams/namespace-a/configured",
      }))?.state,
      "ready",
    );
    assertEquals(
      (await f.catalog.resolvePending("namespace-a", pending)).body.bodyId,
      logical.bodyId,
    );
    assertEquals(
      await new Response((await runtime.follow({ id: writer.id })).body).text(),
      "promoted",
    );
  } finally {
    await f.db.close();
  }
});
