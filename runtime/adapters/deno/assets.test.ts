import { assertEquals } from "@std/assert";
import {
  createFilesystemAssetBodyStore,
  digestContent,
} from "../../content/index.ts";
import { denoAssetFilesystem } from "./assets.ts";

Deno.test("Deno filesystem asset capability stores immutable bodies and sidecar metadata", async () => {
  const root = await Deno.makeTempDir({ prefix: "copilotz-assets-" });
  try {
    const store = createFilesystemAssetBodyStore({
      backendId: "filesystem:test",
      access: denoAssetFilesystem(root),
    });
    const bytes = new TextEncoder().encode("hello");
    const digest = await digestContent(bytes);
    const head = await store.put({
      key: "schemas/test/assets/asset-a",
      bytes,
      mediaType: "text/plain",
      digest,
      ifAbsent: true,
    });
    assertEquals(head.byteLength, 5);
    assertEquals(await store.read(head.key), bytes);
    assertEquals(
      (await Array.fromAsync(store.list())).map((item) => item.key),
      [
        "schemas/test/assets/asset-a",
      ],
    );
    await store.delete(head.key);
    assertEquals(await store.head(head.key), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
