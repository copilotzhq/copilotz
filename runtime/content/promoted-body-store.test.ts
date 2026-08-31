import { assertEquals, assertRejects, assertThrows } from "@std/assert";

import {
  createFixedBodyStoreAdapter,
  createMemoryBodyStore,
  readBodyBytes,
} from "./body-store.ts";
import type {
  BodyHead,
  BodyMaintenanceDeleteInput,
  BodyStore,
  BodyStoreAdapter,
  WriterCapability,
} from "./body-store.ts";
import { digestContent } from "./digest.ts";
import {
  createPromotedBodyStore,
  createPromotedBodyStoreAdapter,
} from "./promoted-body-store.ts";

const encoder = new TextEncoder();

async function appendText(
  store: BodyStore,
  bodyId: string,
  value: string,
): Promise<Readonly<{ writer: WriterCapability; bytes: Uint8Array }>> {
  const bytes = encoder.encode(value);
  const writer = await store.reserve({ bodyId, mediaType: "text/plain" });
  const appended = await store.append({
    writer,
    expectedOffset: 0,
    appendId: "append-1",
    bytes,
  });
  assertEquals(appended.endOffset, bytes.byteLength);
  return Object.freeze({ writer, bytes });
}

async function sealText(
  store: BodyStore,
  bodyId: string,
  value: string,
): Promise<Readonly<{ writer: WriterCapability; head: BodyHead }>> {
  const { writer, bytes } = await appendText(store, bodyId, value);
  const head = await store.seal({
    writer,
    expectedByteLength: bytes.byteLength,
    expectedDigest: await digestContent(bytes),
  });
  return Object.freeze({ writer, head });
}

async function bodyText(store: BodyStore, bodyId: string): Promise<string> {
  return new TextDecoder().decode(await readBodyBytes(store, { bodyId }));
}

function durableAdapter(
  store: BodyStore,
  input: Readonly<{ protectionMs?: number; readyGc?: boolean }> = {},
): BodyStoreAdapter {
  return createFixedBodyStoreAdapter(store, {
    durability: "durable",
    reach: "cluster",
    minimumProtectionMs: input.protectionMs ?? 0,
    readyGarbageCollection: input.readyGc ?? true,
  });
}

Deno.test("promoted store stages progressive bytes and returns canonical Ready", async () => {
  const staging = createMemoryBodyStore({
    backendId: "database:staging",
    protectionMs: 0,
  });
  const ready = createMemoryBodyStore({
    backendId: "gcs:ready",
    protectionMs: 0,
  });
  const store = createPromotedBodyStore({ staging, ready });
  const { writer, bytes } = await appendText(store, "body-a", "hello");

  assertEquals((await store.head({ bodyId: "body-a" }))?.state, "open");
  assertEquals(
    new TextDecoder().decode(
      await store.readRange!({
        bodyId: "body-a",
        offset: 1,
        end: 4,
      }),
    ),
    "ell",
  );
  const sealed = await store.seal({
    writer,
    expectedByteLength: bytes.byteLength,
    expectedDigest: await digestContent(bytes),
  });

  assertEquals(sealed.bodyId, "body-a");
  assertEquals(store.backendId, "gcs:ready");
  assertEquals(await staging.head({ bodyId: "body-a" }), null);
  const canonicalHead = await ready.head({ bodyId: "body-a" });
  assertEquals(canonicalHead?.state, "ready");
  if (canonicalHead?.state !== "ready") {
    throw new Error("Expected canonical Ready head.");
  }
  assertEquals(canonicalHead.digest, sealed.digest);
  assertEquals(await bodyText(store, "body-a"), "hello");
});

Deno.test("seal retry promotes durable staged Ready after pre-publish crash", async () => {
  const staging = createMemoryBodyStore({ protectionMs: 0 });
  const canonical = createMemoryBodyStore({
    backendId: "gcs:ready",
    protectionMs: 0,
  });
  let failPut = true;
  const ready: BodyStore = Object.freeze({
    ...canonical,
    put(input) {
      if (failPut) {
        failPut = false;
        return Promise.reject(new Error("simulated pre-publish crash"));
      }
      return canonical.put(input);
    },
  });
  const store = createPromotedBodyStore({ staging, ready });
  const { writer, bytes } = await appendText(store, "body-crash", "recover");
  const seal = {
    writer,
    expectedByteLength: bytes.byteLength,
    expectedDigest: await digestContent(bytes),
  } as const;

  await assertRejects(() => store.seal(seal), Error, "pre-publish crash");
  assertEquals((await staging.head({ bodyId: "body-crash" }))?.state, "ready");
  assertEquals(await canonical.head({ bodyId: "body-crash" }), null);

  const recovered = await store.seal(seal);
  assertEquals(recovered.state, "ready");
  assertEquals(await staging.head({ bodyId: "body-crash" }), null);
  assertEquals(await bodyText(canonical, "body-crash"), "recover");
});

Deno.test("Ready-before-cleanup residue is recovered without republishing bytes", async () => {
  const baseStaging = createMemoryBodyStore({ protectionMs: 0 });
  let failCleanup = true;
  const staging: BodyStore = Object.freeze({
    ...baseStaging,
    maintenance: Object.freeze({
      ...baseStaging.maintenance,
      delete(input: BodyMaintenanceDeleteInput) {
        if (input.expectedState === "ready" && failCleanup) {
          failCleanup = false;
          return Promise.reject(new Error("simulated cleanup crash"));
        }
        return baseStaging.maintenance.delete(input);
      },
    }),
  });
  const canonical = createMemoryBodyStore({
    backendId: "gcs:ready",
    protectionMs: 0,
  });
  let puts = 0;
  const ready: BodyStore = Object.freeze({
    ...canonical,
    put(input) {
      puts += 1;
      return canonical.put(input);
    },
  });
  const store = createPromotedBodyStore({ staging, ready });

  await sealText(store, "body-residue", "durable");
  assertEquals(puts, 1);
  assertEquals(
    (await baseStaging.head({ bodyId: "body-residue" }))?.state,
    "ready",
  );

  assertEquals((await store.head({ bodyId: "body-residue" }))?.state, "ready");
  assertEquals(puts, 1);
  assertEquals(await baseStaging.head({ bodyId: "body-residue" }), null);
});

Deno.test("competing promoters accept only an exact canonical winner", async () => {
  const staging = createMemoryBodyStore({ protectionMs: 0 });
  const ready = createMemoryBodyStore({
    backendId: "gcs:ready",
    protectionMs: 0,
  });
  const staged = await sealText(staging, "body-race", "same bytes");
  const left = createPromotedBodyStore({ staging, ready });
  const right = createPromotedBodyStore({ staging, ready });

  const [leftHead, rightHead] = await Promise.all([
    left.head({ bodyId: staged.head.bodyId }),
    right.head({ bodyId: staged.head.bodyId }),
  ]);
  assertEquals(leftHead?.state, "ready");
  assertEquals(rightHead?.state, "ready");
  if (leftHead?.state !== "ready" || rightHead?.state !== "ready") {
    throw new Error("Expected competing promoters to return Ready heads.");
  }
  assertEquals(leftHead.digest, staged.head.digest);
  assertEquals(rightHead.digest, staged.head.digest);
  assertEquals(await staging.head({ bodyId: staged.head.bodyId }), null);

  const conflictingStaging = createMemoryBodyStore({ protectionMs: 0 });
  const conflictingReady = createMemoryBodyStore({ protectionMs: 0 });
  const conflict = await sealText(
    conflictingStaging,
    "body-conflict",
    "staged",
  );
  const winnerBytes = encoder.encode("winner");
  await conflictingReady.put({
    bodyId: "body-conflict",
    bytes: winnerBytes,
    mediaType: "text/plain",
    digest: await digestContent(winnerBytes),
    ifAbsent: true,
  });
  const conflicted = createPromotedBodyStore({
    staging: conflictingStaging,
    ready: conflictingReady,
  });
  await assertRejects(
    () => conflicted.head({ bodyId: "body-conflict" }),
    Error,
    "conflicts with staged canonical bytes",
  );
  assertEquals(
    (await conflictingStaging.head({ bodyId: conflict.head.bodyId }))?.state,
    "ready",
  );
  assertEquals(await bodyText(conflictingReady, "body-conflict"), "winner");
});

Deno.test("active staging wins reads and follows over a raced Ready object", async () => {
  const staging = createMemoryBodyStore({ protectionMs: 0 });
  const ready = createMemoryBodyStore({ protectionMs: 0 });
  await appendText(staging, "body-active", "live");
  const stale = encoder.encode("stale");
  await ready.put({
    bodyId: "body-active",
    bytes: stale,
    mediaType: "text/plain",
    digest: await digestContent(stale),
    ifAbsent: true,
  });
  const store = createPromotedBodyStore({ staging, ready });

  assertEquals((await store.head({ bodyId: "body-active" }))?.state, "open");
  assertEquals(
    new TextDecoder().decode(
      await store.readRange!({
        bodyId: "body-active",
        offset: 0,
        end: 4,
      }),
    ),
    "live",
  );
  assertEquals(
    new TextDecoder().decode(
      await readBodyBytes(
        { read: (input) => store.follow(input) },
        { bodyId: "body-active" },
      ),
    ),
    "live",
  );
  await assertRejects(() => store.read({ bodyId: "body-active" }));
});

Deno.test("maintenance surfaces active staging and promotes but never GC-deletes residue", async () => {
  const baseStaging = createMemoryBodyStore({ protectionMs: 0 });
  let retainResidue = true;
  const staging: BodyStore = Object.freeze({
    ...baseStaging,
    maintenance: Object.freeze({
      ...baseStaging.maintenance,
      delete(input: BodyMaintenanceDeleteInput) {
        if (input.expectedState === "ready" && retainResidue) {
          return Promise.resolve(false);
        }
        return baseStaging.maintenance.delete(input);
      },
    }),
  });
  const ready = createMemoryBodyStore({ protectionMs: 0 });
  await appendText(staging, "body-open", "partial");
  await sealText(staging, "body-ready", "complete");
  const store = createPromotedBodyStore({ staging, ready });

  const page = await store.maintenance.list({
    states: ["open", "ready"],
    idleForMs: 0,
    limit: 10,
  });
  assertEquals(
    page.bodies.map((head) => [head.bodyId, head.state]),
    [["body-open", "open"], ["body-ready", "ready"]],
  );
  const canonical = await ready.head({ bodyId: "body-ready" });
  assertEquals(canonical?.state, "ready");
  assertEquals(
    (await baseStaging.head({ bodyId: "body-ready" }))?.state,
    "ready",
  );
  if (!canonical) throw new Error("Expected promoted Ready head.");
  assertEquals(
    await store.maintenance.delete({
      bodyId: canonical.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: canonical.maintenanceVersion,
      idleForMs: 0,
    }),
    false,
  );
  assertEquals((await ready.head({ bodyId: "body-ready" }))?.state, "ready");

  retainResidue = false;
  await store.head({ bodyId: "body-ready" });
  assertEquals(await baseStaging.head({ bodyId: "body-ready" }), null);
});

Deno.test("promoted adapter caches scoped stores and exposes Ready guarantees", () => {
  const staging = createMemoryBodyStore({ backendId: "database:staging" });
  const ready = createMemoryBodyStore({ backendId: "gcs:ready" });
  const adapter = createPromotedBodyStoreAdapter({
    staging: durableAdapter(staging),
    ready: durableAdapter(ready, { protectionMs: 77, readyGc: true }),
  });
  const scope = { namespace: "tenant-a", databaseSchema: "tenant_a" };

  assertEquals(adapter.forScope(scope), adapter.forScope(scope));
  assertEquals(adapter.deployment, {
    durability: "durable",
    reach: "cluster",
    minimumProtectionMs: 77,
    readyGarbageCollection: true,
  });
  assertThrows(
    () =>
      createPromotedBodyStoreAdapter({
        staging: createFixedBodyStoreAdapter(staging, {
          durability: "ephemeral",
          reach: "process",
          minimumProtectionMs: 0,
          readyGarbageCollection: true,
        }),
        ready: durableAdapter(ready),
      }),
    TypeError,
    "staging must be durable and cluster-reachable",
  );
});
