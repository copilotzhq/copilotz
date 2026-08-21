import { assertEquals, assertRejects } from "@std/assert";

import { digestContent } from "./digest.ts";
import { readBodyBytes } from "./body-store.ts";
import { createS3BodyStore } from "./s3-body-store.ts";
import type { ContentError } from "./types.ts";

type StoredObject = {
  bytes: Uint8Array;
  mediaType: string;
  digest: string;
  maintenanceVersion: string;
  protectedUntil: string;
  modified: string;
};

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

Deno.test("S3 BodyStore conditionally writes, verifies, streams, lists, and deletes", async () => {
  const objects = new Map<string, StoredObject>();
  let headRequests = 0;
  let putRequests = 0;
  const putPayloadDigests: string[] = [];
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
        headRequests++;
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
            "x-amz-meta-copilotz-maintenance-version":
              existing.maintenanceVersion,
            "x-amz-meta-copilotz-protected-until": existing.protectedUntil,
          },
        });
      }
      if (request.method === "PUT") {
        putRequests++;
        putPayloadDigests.push(
          request.headers.get("x-amz-content-sha256") ?? "",
        );
        if (existing && request.headers.get("if-none-match") === "*") {
          return new Response(null, { status: 412 });
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        const stored = {
          bytes,
          mediaType: request.headers.get("content-type") ??
            "application/octet-stream",
          digest: `sha256:${request.headers.get("x-amz-meta-copilotz-sha256")}`,
          maintenanceVersion:
            request.headers.get("x-amz-meta-copilotz-maintenance-version") ??
              "1",
          protectedUntil:
            request.headers.get("x-amz-meta-copilotz-protected-until") ?? "",
          modified: new Date().toUTCString(),
        };
        objects.set(path, stored);
        return new Response(null, {
          status: 200,
          headers: {
            etag: '"etag"',
            "last-modified": stored.modified,
          },
        });
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
    const store = createS3BodyStore({
      backendId: "s3:test",
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "us-east-1",
      bucket: "bucket",
      accessKeyId: "access",
      secretAccessKey: "secret",
      pathStyle: true,
      protectionMs: 0,
    });
    const bytes = new TextEncoder().encode("hello s3");
    const input = {
      bodyId: "copilotz/schemas/test/assets/a",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
      ifAbsent: true,
    } as const;
    const first = await store.put(input);
    assertEquals(first.byteLength, bytes.byteLength);
    assertEquals({ putRequests, headRequests }, {
      putRequests: 1,
      headRequests: 0,
    });
    assertEquals(
      putPayloadDigests[0],
      input.digest.slice("sha256:".length),
    );
    assertEquals(await store.put(input), first);
    assertEquals({ putRequests, headRequests }, {
      putRequests: 2,
      headRequests: 1,
    });
    assertEquals(await readBodyBytes(store, { bodyId: input.bodyId }), bytes);
    assertEquals(
      await new Response(await store.read({ bodyId: input.bodyId })).text(),
      "hello s3",
    );
    const listed = await store.maintenance.list({
      states: ["ready"],
      idleForMs: 0,
      limit: 10,
    });
    assertEquals(listed.bodies.map((item) => item.bodyId), [input.bodyId]);
    const conflict = await assertRejects(() =>
      store.put({
        ...input,
        bytes: new TextEncoder().encode("different"),
        digest:
          "sha256:9d6f965ac832e40a5df6c06afe983e3b4a6fba16c4baadd5f38b359904f9e39c",
      })
    );
    assertEquals((conflict as ContentError).code, "asset_conflict");
    await store.maintenance.delete({
      bodyId: input.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: first.maintenanceVersion,
      idleForMs: 0,
    });
    assertEquals(await store.head({ bodyId: input.bodyId }), null);
  } finally {
    await server.shutdown();
  }
});
