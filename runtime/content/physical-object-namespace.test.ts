import { createGcsBodyStore } from "./gcs-body-store.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  isOwnerPhysicalObjectKey,
  OWNER_PHYSICAL_OBJECT_ROOT,
  refuseOwnerPhysicalObjectKey,
} from "./physical-object-namespace.ts";

Deno.test("legacy object namespace refuses private roots before path normalization", () => {
  for (
    const key of [
      OWNER_PHYSICAL_OBJECT_ROOT,
      `${OWNER_PHYSICAL_OBJECT_ROOT}scope/body/meta.json`,
      `ordinary/../${OWNER_PHYSICAL_OBJECT_ROOT}scope/body`,
      `../bucket/${OWNER_PHYSICAL_OBJECT_ROOT}scope/body`,
      `ordinary\\${OWNER_PHYSICAL_OBJECT_ROOT}body`,
      `nested/${OWNER_PHYSICAL_OBJECT_ROOT}body`,
    ]
  ) {
    assertEquals(isOwnerPhysicalObjectKey(key), true);
    assertThrows(() => refuseOwnerPhysicalObjectKey(key));
  }
  for (
    const key of [
      "",
      "normal/body",
      "normal/body.progressive/meta.json",
      "__copilotz_owner_physical_v1__suffix/body",
    ]
  ) {
    assertEquals(isOwnerPhysicalObjectKey(key), false);
    refuseOwnerPhysicalObjectKey(key);
  }
});

Deno.test("native GCS rejects owner physical keys before token lookup or network", async () => {
  const bytes = new TextEncoder().encode("hello");
  const digest =
    "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" as const;
  let calls = 0, tokens = 0;
  for (const prefix of [undefined, `${OWNER_PHYSICAL_OBJECT_ROOT}scope`]) {
    const store = createGcsBodyStore({
      bucket: "bucket",
      backendId: "gcs:test",
      prefix,
      getAccessToken: () => {
        tokens++;
        return Promise.resolve("token");
      },
      fetch: () => {
        calls++;
        return Promise.resolve(new Response("unexpected"));
      },
    });
    const bodyId = prefix ? "body" : `${OWNER_PHYSICAL_OBJECT_ROOT}scope/body`;
    await assertRejects(() =>
      store.put({ bodyId, mediaType: "text/plain", bytes, digest })
    );
    await assertRejects(() => store.head({ bodyId }));
    await assertRejects(() => store.read({ bodyId }));
    await assertRejects(() => store.readRange({ bodyId, offset: 0, end: 1 }));
    assertEquals(
      await store.maintenance.delete({
        bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: 1,
        idleForMs: 0,
      }),
      false,
    );
  }
  assertEquals(tokens, 0);
  assertEquals(calls, 0);
});
