import { assertEquals } from "@std/assert";
import {
  createFilesystemBodyStore,
  digestContent,
  readBodyBytes,
} from "../../content/index.ts";
import { denoAssetFilesystem } from "./assets.ts";

Deno.test("Deno filesystem asset capability stores immutable bodies and sidecar metadata", async () => {
  const root = await Deno.makeTempDir({ prefix: "copilotz-assets-" });
  try {
    const store = createFilesystemBodyStore({
      backendId: "filesystem:test",
      protectionMs: 0,
      access: denoAssetFilesystem(root),
    });
    const bytes = new TextEncoder().encode("hello");
    const digest = await digestContent(bytes);
    const head = await store.put({
      bodyId: "schemas/test/assets/asset-a",
      bytes,
      mediaType: "text/plain",
      digest,
      ifAbsent: true,
    });
    assertEquals(head.byteLength, 5);
    assertEquals(await readBodyBytes(store, { bodyId: head.bodyId }), bytes);
    const listed = await store.maintenance.list({
      states: ["ready"],
      idleForMs: 0,
      limit: 10,
    });
    assertEquals(listed.bodies.map((item) => item.bodyId), [
      "schemas/test/assets/asset-a",
    ]);
    await store.maintenance.delete({
      bodyId: head.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: head.maintenanceVersion,
      idleForMs: 0,
    });
    assertEquals(await store.head({ bodyId: head.bodyId }), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
