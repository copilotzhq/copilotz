import { assertEquals } from "@std/assert";

import { denoAssetFilesystem } from "../adapters/deno/assets.ts";
import {
  createFilesystemBodyStore,
  createMemoryBodyStore,
} from "./body-store.ts";
import type {
  ActiveMutableBodyHead,
  BodyMaintenanceDeleteInput,
  BodyStore,
} from "./body-store.ts";
import { maintainProgressiveBodies } from "./maintenance.ts";
import { createProgressiveBodyWriter } from "./progressive.ts";

Deno.test("progressive body maintenance fences and aborts expired writers without semantic lookup", async () => {
  const store = createMemoryBodyStore({ protectionMs: 0 });
  const writer = await store.reserve({
    bodyId: "content-streams/tenant-a/stream-a",
    mediaType: "text/plain",
  });
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "first",
    bytes: new TextEncoder().encode("partial"),
  });

  const result = await maintainProgressiveBodies(store);

  assertEquals(result, {
    examined: 1,
    aborted: 1,
    sealed: 0,
    deferred: 0,
    errors: [],
  });
  assertEquals(await store.head({ bodyId: writer.bodyId }), null);
});

Deno.test("progressive maintenance continuation prevents live first-page starvation", async () => {
  const store = createMemoryBodyStore({ protectionMs: 100 });
  const expired = await store.reserve({
    bodyId: "z-expired",
    mediaType: "text/plain",
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await store.reserve({ bodyId: "a-live", mediaType: "text/plain" });
  await store.reserve({ bodyId: "b-live", mediaType: "text/plain" });

  const first = await maintainProgressiveBodies(store, { limit: 2 });
  assertEquals(first, {
    examined: 2,
    aborted: 0,
    sealed: 0,
    deferred: 2,
    errors: [],
    after: "b-live",
  });
  const second = await maintainProgressiveBodies(store, {
    limit: 2,
    after: first.after,
  });
  assertEquals(second, {
    examined: 1,
    aborted: 1,
    sealed: 0,
    deferred: 0,
    errors: [],
  });
  assertEquals(await store.head({ bodyId: expired.bodyId }), null);
});

Deno.test("progressive maintenance resumes expired sealing instead of aborting it", async () => {
  const base = createMemoryBodyStore({ protectionMs: 0 });
  const writer = await base.reserve({
    bodyId: "content-streams/tenant-a/sealing",
    mediaType: "text/plain",
  });
  const bytes = new TextEncoder().encode("frozen");
  await base.append({
    writer,
    expectedOffset: 0,
    appendId: "frozen",
    bytes,
  });
  const open = await base.head({ bodyId: writer.bodyId });
  if (!open || open.state !== "open") {
    throw new Error("Expected active progressive body.");
  }
  const sealing: ActiveMutableBodyHead = Object.freeze({
    ...open,
    state: "sealing",
    writerLeaseRemainingMs: 0,
  });
  let aborted = false;
  let sealedExpectedByteLength: number | undefined;
  const store: BodyStore = Object.freeze({
    ...base,
    abort(input) {
      aborted = true;
      return base.abort(input);
    },
    seal(input) {
      sealedExpectedByteLength = input.expectedByteLength;
      return base.seal(input);
    },
    maintenance: Object.freeze({
      ...base.maintenance,
      list: () =>
        Promise.resolve(Object.freeze({ bodies: Object.freeze([sealing]) })),
    }),
  });

  assertEquals(await maintainProgressiveBodies(store), {
    examined: 1,
    aborted: 0,
    sealed: 1,
    deferred: 0,
    errors: [],
  });
  assertEquals(aborted, false);
  assertEquals(sealedExpectedByteLength, bytes.byteLength);
  assertEquals((await base.head({ bodyId: writer.bodyId }))?.state, "ready");
});

Deno.test("progressive maintenance retries fenced abort cleanup", async () => {
  const base = createMemoryBodyStore({ protectionMs: 0 });
  let deleted = 0;
  const store: BodyStore = Object.freeze({
    ...base,
    reserve() {
      throw new Error("aborted cleanup must not reserve a writer");
    },
    maintenance: Object.freeze({
      list: () =>
        Promise.resolve(Object.freeze({
          bodies: Object.freeze([Object.freeze({
            bodyId: "content-streams/tenant-a/aborting",
            state: "aborted" as const,
            mediaType: "text/plain",
            byteLength: 7,
            discarded: 0,
            maintenanceVersion: 4,
            reservationId: "fenced-abort",
          })]),
        })),
      delete(input: BodyMaintenanceDeleteInput) {
        assertEquals(input, {
          bodyId: "content-streams/tenant-a/aborting",
          expectedState: "aborted",
          expectedMaintenanceVersion: 4,
          idleForMs: 0,
        });
        deleted++;
        return Promise.resolve(true);
      },
    }),
  });

  assertEquals(await maintainProgressiveBodies(store), {
    examined: 1,
    aborted: 1,
    sealed: 0,
    deferred: 0,
    errors: [],
  });
  assertEquals(deleted, 1);
});

Deno.test("filesystem progressive maintenance discovers crash staging after reopen", async () => {
  const root = await Deno.makeTempDir({
    prefix: "copilotz-progressive-maintenance-",
  });
  try {
    const first = createFilesystemBodyStore({
      backendId: "filesystem:maintenance-writer",
      protectionMs: 0,
      access: denoAssetFilesystem(root),
    });
    const writer = await first.reserve({
      bodyId: "content-streams/tenant-a/filesystem-crash",
      mediaType: "text/plain",
    });
    await first.append({
      writer,
      expectedOffset: 0,
      appendId: "partial",
      bytes: new TextEncoder().encode("partial"),
    });

    const recovered = createFilesystemBodyStore({
      backendId: "filesystem:maintenance-recovered",
      protectionMs: 0,
      access: denoAssetFilesystem(root),
    });
    assertEquals(await maintainProgressiveBodies(recovered), {
      examined: 1,
      aborted: 1,
      sealed: 0,
      deferred: 0,
      errors: [],
    });
    assertEquals(await recovered.head({ bodyId: writer.bodyId }), null);
    assertEquals(await maintainProgressiveBodies(recovered), {
      examined: 0,
      aborted: 0,
      sealed: 0,
      deferred: 0,
      errors: [],
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("filesystem Ready seal survives cleanup failure and leaves retryable staging", async () => {
  const root = await Deno.makeTempDir({
    prefix: "copilotz-progressive-seal-cleanup-",
  });
  try {
    const access = denoAssetFilesystem(root);
    let cleanupAttempts = 0;
    const store = createFilesystemBodyStore({
      backendId: "filesystem:cleanup-retry",
      protectionMs: 0,
      access: {
        ...access,
        async cleanupProgressive(bodyId) {
          cleanupAttempts++;
          if (cleanupAttempts === 1) {
            throw new Error("simulated cleanup interruption");
          }
          await access.cleanupProgressive!(bodyId);
        },
      },
    });
    const writer = await createProgressiveBodyWriter(store, {
      bodyId: "content-streams/tenant-a/seal-cleanup",
      mediaType: "text/plain",
    });
    await writer.write(new TextEncoder().encode("complete"));
    const ready = await writer.finalize();
    assertEquals(ready.state, "ready");
    assertEquals(cleanupAttempts, 1);

    assertEquals(await maintainProgressiveBodies(store), {
      examined: 1,
      aborted: 1,
      sealed: 0,
      deferred: 0,
      errors: [],
    });
    assertEquals(cleanupAttempts, 2);
    assertEquals((await store.head({ bodyId: writer.bodyId }))?.state, "ready");
    assertEquals(await maintainProgressiveBodies(store), {
      examined: 0,
      aborted: 0,
      sealed: 0,
      deferred: 0,
      errors: [],
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
