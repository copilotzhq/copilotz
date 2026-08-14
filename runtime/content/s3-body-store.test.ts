import { assertEquals, assertRejects } from "@std/assert";

import { digestContent } from "./digest.ts";
import { createS3AssetBodyStore } from "./s3-body-store.ts";
import type { ContentError } from "./types.ts";

type StoredObject = {
  bytes: Uint8Array;
  mediaType: string;
  digest: string;
  modified: string;
};

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

Deno.test("S3 asset body store conditionally writes, verifies, streams, lists, and deletes", async () => {
  const objects = new Map<string, StoredObject>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    async (request) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname).replace(/^\/bucket\/?/, "");
      if (
        request.method === "GET" && url.searchParams.get("list-type") === "2"
      ) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...objects.entries()].filter(([key]) =>
          key.startsWith(prefix)
        ).map(([key, value]) =>
          `<Contents><Key>${
            xmlEscape(key)
          }</Key><LastModified>${value.modified}</LastModified><ETag>\"etag\"</ETag><Size>${value.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`
        ).join("");
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bucket</Name><Prefix>${
            xmlEscape(prefix)
          }</Prefix><KeyCount>${objects.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      const existing = objects.get(path);
      if (request.method === "HEAD") {
        if (!existing) return new Response(null, { status: 404 });
        return new Response(null, {
          headers: {
            "content-length": String(existing.bytes.byteLength),
            "content-type": existing.mediaType,
            "etag": '"etag"',
            "last-modified": existing.modified,
            "x-amz-meta-copilotz-sha256": existing.digest.slice(
              "sha256:".length,
            ),
            "x-amz-meta-copilotz-media-type": existing.mediaType,
          },
        });
      }
      if (request.method === "PUT") {
        if (existing && request.headers.get("if-none-match") === "*") {
          return new Response(null, { status: 412 });
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        objects.set(path, {
          bytes,
          mediaType: request.headers.get("content-type") ??
            "application/octet-stream",
          digest: `sha256:${request.headers.get("x-amz-meta-copilotz-sha256")}`,
          modified: new Date().toUTCString(),
        });
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET") {
        return existing
          ? new Response(
            existing.bytes.buffer.slice(
              existing.bytes.byteOffset,
              existing.bytes.byteOffset + existing.bytes.byteLength,
            ) as ArrayBuffer,
            {
              headers: { "content-type": existing.mediaType },
            },
          )
          : new Response(null, { status: 404 });
      }
      if (request.method === "DELETE") {
        objects.delete(path);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  );
  try {
    const address = server.addr as Deno.NetAddr;
    const store = createS3AssetBodyStore({
      backendId: "s3:test",
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "us-east-1",
      bucket: "bucket",
      accessKeyId: "access",
      secretAccessKey: "secret",
      pathStyle: true,
    });
    const bytes = new TextEncoder().encode("hello s3");
    const input = {
      key: "copilotz/schemas/test/assets/a",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
      ifAbsent: true,
    } as const;
    const first = await store.put(input);
    assertEquals(first.byteLength, bytes.byteLength);
    assertEquals(await store.put(input), first);
    assertEquals(await store.read(input.key), bytes);
    assertEquals(
      await new Response(await store.open(input.key)).text(),
      "hello s3",
    );
    const listed = [];
    for await (const item of store.list({ prefix: "copilotz/" })) {
      listed.push(item.key);
    }
    assertEquals(listed, [input.key]);
    const conflict = await assertRejects(() =>
      store.put({
        ...input,
        bytes: new TextEncoder().encode("different"),
        digest:
          "sha256:9d6f965ac832e40a5df6c06afe983e3b4a6fba16c4baadd5f38b359904f9e39c",
      })
    );
    assertEquals((conflict as ContentError).code, "asset_conflict");
    await store.delete(input.key);
    assertEquals(await store.head(input.key), null);
  } finally {
    await server.shutdown();
  }
});
