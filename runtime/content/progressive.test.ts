import { assertEquals, assertRejects } from "@std/assert";

import { denoAssetFilesystem } from "../adapters/deno/assets.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  type BodyStore,
  createDatabaseBodyStore,
  createFilesystemBodyStore,
  createMemoryBodyStore,
  createS3BodyStore,
  digestContent,
  isContentError,
  readBodyBytes,
} from "./index.ts";
import {
  createProgressiveBodyWriter,
  openProgressiveBodyFollower,
} from "./progressive.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    byteLength += value.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function withStore(
  create: () => Promise<
    Readonly<{ store: BodyStore; close?: () => Promise<void> }>
  >,
  run: (store: BodyStore) => Promise<void>,
): Promise<void> {
  const handle = await create();
  try {
    await run(handle.store);
  } finally {
    await handle.close?.();
  }
}

async function createFilesystemHandle() {
  const root = await Deno.makeTempDir({ prefix: "copilotz-progressive-" });
  return {
    store: createFilesystemBodyStore({
      backendId: "filesystem:progressive",
      protectionMs: 0,
      access: denoAssetFilesystem(root),
    }),
    close: () => Deno.remove(root, { recursive: true }),
  };
}

async function createDatabaseHandle() {
  const db = await createTestDatabase({ url: ":memory:" });
  return {
    store: createDatabaseBodyStore({
      session: db,
      schema: "copilotz_progressive_bodies",
      backendId: "database:progressive",
      protectionMs: 0,
    }),
    close: () => db.close(),
  };
}

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

async function createS3Handle() {
  const objects = new Map<string, StoredObject>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    async (request) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname).replace(/^\/bucket\/?/, "");
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
        const bytes = new Uint8Array(await request.arrayBuffer());
        objects.set(path, {
          bytes,
          mediaType: request.headers.get("content-type") ??
            "application/octet-stream",
          digest: `sha256:${
            request.headers.get("x-amz-meta-copilotz-sha256") ?? ""
          }`,
          modified: new Date().toUTCString(),
        });
        return new Response(null, {
          status: 200,
          headers: {
            etag: '"etag"',
            "last-modified": new Date().toUTCString(),
          },
        });
      }
      if (request.method === "GET") {
        if (
          url.searchParams.get("list-type") === "2"
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
        return existing
          ? new Response(
            existing.bytes.buffer.slice(
              existing.bytes.byteOffset,
              existing.bytes.byteOffset + existing.bytes.byteLength,
            ) as ArrayBuffer,
            { headers: { "content-type": existing.mediaType } },
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
  const address = server.addr as Deno.NetAddr;
  const config = {
    backendId: "s3:progressive",
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "us-east-1",
    bucket: "bucket",
    accessKeyId: "access",
    secretAccessKey: "secret",
    pathStyle: true,
    protectionMs: 0,
  } as const;
  return {
    store: createS3BodyStore(config),
    reopen: () => createS3BodyStore(config),
    close: () => server.shutdown(),
  };
}

async function assertContract(store: BodyStore, bodyId: string) {
  const writer = await createProgressiveBodyWriter(store, {
    bodyId,
    mediaType: "text/plain",
  });
  const follower = await openProgressiveBodyFollower(store, { bodyId });
  const pending = readAll(follower.body);
  await writer.write(encoder.encode("hel"));
  await writer.write(encoder.encode("lo"));
  const head = await writer.finalize();
  assertEquals(decoder.decode(await pending), "hello");
  assertEquals(head.byteLength, 5);
  assertEquals(head.digest, await digestContent(encoder.encode("hello")));
  assertEquals(await readBodyBytes(store, { bodyId }), encoder.encode("hello"));
}

Deno.test("progressive writer finalizes a checksummed body for followers", async () => {
  await assertContract(createMemoryBodyStore(), "stream/a");
});

Deno.test("progressive followers start from a committed offset", async () => {
  const store = createMemoryBodyStore();
  const writer = await createProgressiveBodyWriter(store, {
    bodyId: "stream/b",
    mediaType: "text/plain",
  });
  await writer.write(encoder.encode("abcd"));
  const follower = await openProgressiveBodyFollower(store, {
    bodyId: "stream/b",
    offset: 2,
  });
  const pending = readAll(follower.body);
  await writer.finalize();
  assertEquals(decoder.decode(await pending), "cd");
});

Deno.test("only one progressive writer may own a body", async () => {
  const store = createMemoryBodyStore();
  await createProgressiveBodyWriter(store, {
    bodyId: "stream/c",
    mediaType: "text/plain",
  });
  const error = await assertRejects(() =>
    createProgressiveBodyWriter(store, {
      bodyId: "stream/c",
      mediaType: "text/plain",
    })
  );
  assertEquals(isContentError(error) && error.code, "asset_conflict");
});

Deno.test("abandon discards staging and errors followers", async () => {
  const store = createMemoryBodyStore();
  const writer = await createProgressiveBodyWriter(store, {
    bodyId: "stream/d",
    mediaType: "text/plain",
  });
  const follower = await openProgressiveBodyFollower(store, {
    bodyId: "stream/d",
  });
  const pending = assertRejects(() => readAll(follower.body));
  await writer.write(encoder.encode("partial"));
  await writer.abandon();
  const error = await pending;
  assertEquals(isContentError(error) && error.code, "asset_deleted");
  assertEquals(await store.head({ bodyId: "stream/d" }), null);
});

Deno.test("writer backpressures when a live memory follower lags the bound", async () => {
  const store = createMemoryBodyStore();
  const writer = await createProgressiveBodyWriter(store, {
    bodyId: "stream/e",
    mediaType: "text/plain",
    maxBufferedBytes: 4,
  });
  const follower = await openProgressiveBodyFollower(store, {
    bodyId: "stream/e",
  });
  await writer.write(encoder.encode("abcd"));
  let resumed = false;
  const blocked = writer.write(encoder.encode("e")).then(() => {
    resumed = true;
  });
  await Promise.resolve();
  assertEquals(resumed, false);
  const reader = follower.body.getReader();
  const first = await reader.read();
  assertEquals(decoder.decode(first.value), "abcd");
  await blocked;
  assertEquals(resumed, true);
  await writer.finalize();
  await reader.cancel();
});

Deno.test("filesystem, database, and S3 progressive writers finalize a checksummed body", async () => {
  await withStore(
    createFilesystemHandle,
    (store) => assertContract(store, "stream/fs"),
  );
  await withStore(
    createDatabaseHandle,
    (store) => assertContract(store, "stream/db"),
  );
  await withStore(
    createS3Handle,
    (store) => assertContract(store, "stream/s3"),
  );
});

Deno.test("a slow follower does not block other followers on durable stores", async () => {
  await withStore(createFilesystemHandle, async (store) => {
    const writer = await createProgressiveBodyWriter(store, {
      bodyId: "stream/slow",
      mediaType: "text/plain",
      maxBufferedBytes: 2,
    });
    const slow = await openProgressiveBodyFollower(store, {
      bodyId: "stream/slow",
    });
    const slowReader = slow.body.getReader();
    await writer.write(encoder.encode("abcd"));
    await writer.write(encoder.encode("efgh"));
    const fast = await openProgressiveBodyFollower(store, {
      bodyId: "stream/slow",
    });
    const pending = readAll(fast.body);
    await writer.finalize();
    assertEquals(decoder.decode(await pending), "abcdefgh");
    const first = await slowReader.read();
    assertEquals(decoder.decode(first.value), "abcdefgh");
    await slowReader.cancel();
  });
});

Deno.test("durable stores recover a prefix after the writer process is gone", async () => {
  const root = await Deno.makeTempDir({
    prefix: "copilotz-progressive-crash-",
  });
  try {
    const first = createFilesystemBodyStore({
      backendId: "filesystem:crash",
      protectionMs: 0,
      access: denoAssetFilesystem(root),
    });
    const writer = await createProgressiveBodyWriter(first, {
      bodyId: "stream/crash",
      mediaType: "text/plain",
    });
    await writer.write(encoder.encode("hel"));
    const recovered = createFilesystemBodyStore({
      backendId: "filesystem:crash",
      protectionMs: 0,
      access: denoAssetFilesystem(root),
    });
    const resumed = await createProgressiveBodyWriter(recovered, {
      bodyId: "stream/crash",
      mediaType: "text/plain",
      takeover: true,
    });
    const follower = await openProgressiveBodyFollower(recovered, {
      bodyId: "stream/crash",
    });
    const pending = readAll(follower.body);
    await resumed.write(encoder.encode("lo"));
    const head = await resumed.finalize();
    assertEquals(decoder.decode(await pending), "hello");
    assertEquals(head.digest, await digestContent(encoder.encode("hello")));
    assertEquals(
      await readBodyBytes(recovered, { bodyId: "stream/crash" }),
      encoder.encode("hello"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("database BodyStore recovers a prefix from durable staging", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const first = createDatabaseBodyStore({
      session: db,
      schema: "copilotz_progressive_crash",
      protectionMs: 0,
    });
    const writer = await createProgressiveBodyWriter(first, {
      bodyId: "stream/crash",
      mediaType: "text/plain",
    });
    await writer.write(encoder.encode("ab"));
    const recovered = createDatabaseBodyStore({
      session: db,
      schema: "copilotz_progressive_crash",
      protectionMs: 0,
    });
    const resumed = await createProgressiveBodyWriter(recovered, {
      bodyId: "stream/crash",
      mediaType: "text/plain",
      takeover: true,
    });
    const follower = await openProgressiveBodyFollower(recovered, {
      bodyId: "stream/crash",
    });
    const pending = readAll(follower.body);
    assertEquals(
      (await recovered.head({ bodyId: "stream/crash" }))?.state,
      "open",
    );
    await resumed.write(encoder.encode("cd"));
    const head = await resumed.finalize();
    assertEquals(decoder.decode(await pending), "abcd");
    assertEquals(head.byteLength, 4);
    assertEquals(
      await readBodyBytes(recovered, { bodyId: "stream/crash" }),
      encoder.encode("abcd"),
    );
  } finally {
    await db.close();
  }
});

Deno.test("S3 BodyStore recovers a prefix from object staging", async () => {
  const handle = await createS3Handle();
  try {
    const writer = await createProgressiveBodyWriter(handle.store, {
      bodyId: "stream/crash",
      mediaType: "text/plain",
    });
    await writer.write(encoder.encode("xy"));
    const recovered = handle.reopen();
    const resumed = await createProgressiveBodyWriter(recovered, {
      bodyId: "stream/crash",
      mediaType: "text/plain",
      takeover: true,
    });
    const follower = await openProgressiveBodyFollower(recovered, {
      bodyId: "stream/crash",
    });
    const pending = readAll(follower.body);
    await resumed.write(encoder.encode("z"));
    await resumed.finalize();
    assertEquals(decoder.decode(await pending), "xyz");
    assertEquals(
      await readBodyBytes(recovered, { bodyId: "stream/crash" }),
      encoder.encode("xyz"),
    );
  } finally {
    await handle.close();
  }
});
