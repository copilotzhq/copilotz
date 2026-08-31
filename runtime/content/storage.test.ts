import { assert, assertEquals } from "@std/assert";

import { createMemoryBodyStore } from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { createBodyStorageRuntime } from "./storage.ts";

Deno.test("custom BodyStore deployment is conservative unless explicitly declared", async () => {
  const undeclaredStore = createMemoryBodyStore({ protectionMs: 0 });
  const conservative = createBodyStorageRuntime({
    storage: {
      type: "custom",
      config: { store: undeclaredStore },
    },
  });
  assert(conservative.adapter);
  assert(conservative.writer);
  assertEquals(conservative.adapter.deployment, {
    durability: "ephemeral",
    reach: "process",
    minimumProtectionMs: 0,
    readyGarbageCollection: false,
  });
  const bytes = new TextEncoder().encode("conservative");
  const head = await conservative.writer.put({
    bodyId: "bodies/conservative",
    bytes,
    mediaType: "text/plain",
    digest: await digestContent(bytes),
    protectedUntil: "2000-01-01T00:00:00.000Z",
  });
  assertEquals(
    await conservative.writer.maintenance.delete({
      bodyId: head.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: head.maintenanceVersion,
      idleForMs: 0,
    }),
    false,
  );

  const declaredStore = createMemoryBodyStore({ protectionMs: 5_000 });
  const declared = createBodyStorageRuntime({
    storage: {
      type: "custom",
      config: {
        store: declaredStore,
        deployment: {
          durability: "durable",
          reach: "cluster",
          minimumProtectionMs: 5_000,
          readyGarbageCollection: true,
        },
      },
    },
  });
  assert(declared.adapter);
  assertEquals(declared.adapter.deployment, {
    durability: "durable",
    reach: "cluster",
    minimumProtectionMs: 5_000,
    readyGarbageCollection: true,
  });
});

Deno.test("scope-aware BodyStore adapters remain available to content and stream scopes", () => {
  const content = createMemoryBodyStore({ backendId: "memory:content" });
  const stream = createMemoryBodyStore({ backendId: "memory:stream" });
  const adapter = {
    deployment: {
      durability: "durable" as const,
      reach: "cluster" as const,
      minimumProtectionMs: 0,
      readyGarbageCollection: true,
    },
    forScope(scope: { namespace: string }) {
      return scope.namespace === "@copilotz/stream" ? stream : content;
    },
    maintenanceForScope(scope: { namespace: string }) {
      return (scope.namespace === "@copilotz/stream" ? stream : content)
        .maintenance;
    },
  };
  const runtime = createBodyStorageRuntime({
    storage: { type: "adapter", config: { adapter, prefix: "root" } },
  });

  assertEquals(runtime.adapter, adapter);
  assertEquals(runtime.writer, undefined);
  assertEquals(runtime.prefix, "root");
  assertEquals(
    runtime.adapter?.forScope({
      namespace: "@copilotz/content",
      databaseSchema: "tenant_a",
    }).backendId,
    "memory:content",
  );
  assertEquals(
    runtime.adapter?.forScope({
      namespace: "@copilotz/stream",
      databaseSchema: "tenant_a",
    }).backendId,
    "memory:stream",
  );
});

Deno.test("built-in BodyStore deployments expose their actual Ready GC capability", () => {
  const memory = createBodyStorageRuntime({
    storage: { type: "memory", config: { protectionMs: 321 } },
  });
  assertEquals(memory.adapter?.deployment, {
    durability: "ephemeral",
    reach: "process",
    minimumProtectionMs: 321,
    readyGarbageCollection: true,
  });

  const object = createBodyStorageRuntime({
    storage: {
      type: "s3",
      config: {
        backendId: "s3:test",
        endpoint: "https://storage.example.test",
        region: "us-east-1",
        bucket: "bodies",
        accessKeyId: "unused",
        secretAccessKey: "unused",
        protectionMs: 60_000,
      },
    },
  });
  assertEquals(object.adapter?.deployment, {
    durability: "durable",
    reach: "cluster",
    minimumProtectionMs: 0,
    readyGarbageCollection: false,
  });

  const gcs = createBodyStorageRuntime({
    storage: {
      type: "s3",
      config: {
        backendId: "gcs:test",
        endpoint: "https://storage.googleapis.com",
        region: "auto",
        bucket: "bodies",
        accessKeyId: "unused",
        secretAccessKey: "unused",
        protectionMs: 60_000,
        provider: "gcs",
      },
    },
  });
  assertEquals(gcs.adapter?.deployment, {
    durability: "durable",
    reach: "cluster",
    minimumProtectionMs: 60_000,
    readyGarbageCollection: true,
  });
});
