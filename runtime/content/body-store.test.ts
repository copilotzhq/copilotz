import { assertEquals, assertThrows } from "@std/assert";

import { createMemoryBodyStore, readBodyRange } from "./body-store.ts";
import { digestContent } from "./digest.ts";

const encoder = new TextEncoder();
const expired = "2000-01-01T00:00:00.000Z";

Deno.test("memory BodyStore acquire-or-create renews protection and fences maintenance", async () => {
  const store = createMemoryBodyStore({ protectionMs: 60_000 });
  const bytes = encoder.encode("immutable");
  const input = {
    bodyId: "bodies/memory-renewal",
    bytes,
    mediaType: "text/plain",
    digest: await digestContent(bytes),
  } as const;

  const expiredHead = await store.put({ ...input, protectedUntil: expired });
  const renewed = await store.put(input);
  assertEquals(renewed.maintenanceVersion, expiredHead.maintenanceVersion + 1);
  assertEquals(Date.parse(renewed.protectedUntil!) > Date.now(), true);
  const kept = await store.put({ ...input, protectedUntil: expired });
  assertEquals(kept.maintenanceVersion, renewed.maintenanceVersion + 1);
  assertEquals(kept.protectedUntil, renewed.protectedUntil);
  assertEquals(
    await store.maintenance.delete({
      bodyId: renewed.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: expiredHead.maintenanceVersion,
      idleForMs: 0,
    }),
    false,
  );
  assertEquals(
    await store.maintenance.delete({
      bodyId: renewed.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: kept.maintenanceVersion,
      idleForMs: 0,
    }),
    false,
  );

  assertThrows(() =>
    store.put({
      ...input,
      bytes: encoder.encode("different"),
      digest:
        "sha256:9d6f965ac832e40a5df6c06afe983e3b4a6fba16c4baadd5f38b359904f9e39c",
    })
  );
});

Deno.test("memory BodyStore maintenance enforces version, idle, and protection in one delete", async () => {
  const store = createMemoryBodyStore({ protectionMs: 0 });
  const bytes = encoder.encode("collectable");
  const input = {
    bodyId: "bodies/memory-collectable",
    bytes,
    mediaType: "text/plain",
    digest: await digestContent(bytes),
    protectedUntil: expired,
  } as const;
  const first = await store.put(input);
  const current = await store.put(input);

  assertEquals(
    await store.maintenance.delete({
      bodyId: current.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: first.maintenanceVersion,
      idleForMs: 0,
    }),
    false,
  );
  assertEquals(
    await store.maintenance.delete({
      bodyId: current.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: current.maintenanceVersion,
      idleForMs: 60_000,
    }),
    false,
  );
  assertEquals(
    await store.maintenance.delete({
      bodyId: current.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: current.maintenanceVersion,
      idleForMs: 0,
    }),
    true,
  );
  assertEquals(await store.head({ bodyId: current.bodyId }), null);
});

Deno.test("finite range reads remain compatible with stores lacking native range support", async () => {
  const store = createMemoryBodyStore({ protectionMs: 0 });
  const bytes = encoder.encode("legacy range");
  await store.put({
    bodyId: "bodies/legacy-range",
    bytes,
    mediaType: "text/plain",
    digest: await digestContent(bytes),
  });
  const { readRange: _nativeRange, ...legacyStore } = store;
  assertEquals(
    new TextDecoder().decode(
      await readBodyRange(legacyStore, {
        bodyId: "bodies/legacy-range",
        offset: 2,
        end: 8,
      }),
    ),
    "gacy r",
  );
});
