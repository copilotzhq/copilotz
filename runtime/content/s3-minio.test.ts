import { assertEquals } from "@std/assert";

import { digestContent } from "./digest.ts";
import { createS3AssetBodyStore } from "./s3-body-store.ts";

const endpoint = Deno.env.get("COPILOTZ_TEST_MINIO_ENDPOINT")?.trim();

Deno.test({
  name: "S3 asset body store interoperates with MinIO",
  ignore: !endpoint,
  async fn() {
    const key = `copilotz-tests/${crypto.randomUUID()}`;
    const store = createS3AssetBodyStore({
      backendId: "minio:test",
      endpoint: endpoint!,
      region: Deno.env.get("COPILOTZ_TEST_MINIO_REGION") ?? "us-east-1",
      bucket: Deno.env.get("COPILOTZ_TEST_MINIO_BUCKET") ?? "copilotz-tests",
      accessKeyId: Deno.env.get("COPILOTZ_TEST_MINIO_ACCESS_KEY") ??
        "minioadmin",
      secretAccessKey: Deno.env.get("COPILOTZ_TEST_MINIO_SECRET_KEY") ??
        "minioadmin",
      pathStyle: true,
    });
    const bytes = new TextEncoder().encode("copilotz-minio-contract");
    try {
      await store.put({
        key,
        bytes,
        mediaType: "text/plain",
        digest: await digestContent(bytes),
        ifAbsent: true,
      });
      assertEquals(await store.read(key), bytes);
    } finally {
      await store.delete(key).catch(() => undefined);
    }
  },
});
