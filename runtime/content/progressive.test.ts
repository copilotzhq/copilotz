import { assertEquals, assertRejects } from "@std/assert";

import { denoAssetFilesystem } from "../adapters/deno/assets.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  type AssetBodyStore,
  createDatabaseAssetBodyStore,
  createFilesystemAssetBodyStore,
  createMemoryAssetBodyStore,
  createS3AssetBodyStore,
  digestContent,
  isContentError,
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
    Readonly<{ store: AssetBodyStore; close?: () => Promise<void> }>
  >,
  run: (store: AssetBodyStore) => Promise<void>,
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
    store: createFilesystemAssetBodyStore({
      backendId: "filesystem:progressive",
      access: denoAssetFilesystem(root),
    }),
    close: () => Deno.remove(root, { recursive: true }),
  };
}

async function createDatabaseHandle() {
  const db = await createTestDatabase({ url: ":memory:" });
  return {
    store: createDatabaseAssetBodyStore({
      session: db,
      schema: "copilotz_progressive_bodies",
      backendId: "database:progressive",
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
  } as const;
  return {
    store: createS3AssetBodyStore(config),
    reopen: () => createS3AssetBodyStore(config),
    close: () => server.shutdown(),
  };
}

async function assertContract(store: AssetBodyStore, key: string) {
  const writer = await createProgressiveBodyWriter(store, {
    key,
    mediaType: "text/plain",
  });
  const follower = await openProgressiveBodyFollower(store, { key });
  const pending = readAll(follower.body);
  await writer.write(encoder.encode("hel"));
  await writer.write(encoder.encode("lo"));
  const head = await writer.finalize();
  assertEquals(decoder.decode(await pending), "hello");
  assertEquals(head.byteLength, 5);
  assertEquals(head.digest, await digestContent(encoder.encode("hello")));
  assertEquals(await store.read(key), encoder.encode("hello"));
}

Deno.test("progressive writer finalizes a checksummed body for followers", async () => {
  await assertContract(createMemoryAssetBodyStore(), "stream/a");
});

Deno.test("progressive followers start from a committed offset", async () => {
  const store = createMemoryAssetBodyStore();
  const writer = await createProgressiveBodyWriter(store, {
    key: "stream/b",
    mediaType: "text/plain",
  });
  await writer.write(encoder.encode("abcd"));
  const follower = await openProgressiveBodyFollower(store, {
    key: "stream/b",
    offset: 2,
  });
  const pending = readAll(follower.body);
  await writer.finalize();
  assertEquals(decoder.decode(await pending), "cd");
});

Deno.test("only one progressive writer may own a key", async () => {
  const store = createMemoryAssetBodyStore();
  await createProgressiveBodyWriter(store, {
    key: "stream/c",
    mediaType: "text/plain",
  });
  const error = await assertRejects(() =>
    createProgressiveBodyWriter(store, {
      key: "stream/c",
      mediaType: "text/plain",
    })
  );
  assertEquals(isContentError(error) && error.code, "asset_conflict");
});

Deno.test("abandon discards staging and errors followers", async () => {
  const store = createMemoryAssetBodyStore();
  const writer = await createProgressiveBodyWriter(store, {
    key: "stream/d",
    mediaType: "text/plain",
  });
  const follower = await openProgressiveBodyFollower(store, {
    key: "stream/d",
  });
  const pending = assertRejects(() => readAll(follower.body));
  await writer.write(encoder.encode("partial"));
  await writer.abandon();
  const error = await pending;
  assertEquals(isContentError(error) && error.code, "asset_deleted");
  assertEquals(await store.head("stream/d"), null);
});

Deno.test("writer backpressures when a live memory follower lags the bound", async () => {
  const store = createMemoryAssetBodyStore();
  const writer = await createProgressiveBodyWriter(store, {
    key: "stream/e",
    mediaType: "text/plain",
    maxBufferedBytes: 4,
  });
  const follower = await openProgressiveBodyFollower(store, {
    key: "stream/e",
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

Deno.test("retain checksums a verified prefix and closes followers at that offset", async () => {
  const store = createMemoryAssetBodyStore();
  const writer = await createProgressiveBodyWriter(store, {
    key: "stream/retain",
    mediaType: "text/plain",
  });
  const follower = await openProgressiveBodyFollower(store, {
    key: "stream/retain",
  });
  await writer.write(encoder.encode("hello world"));
  const head = await writer.retain(5);
  assertEquals(decoder.decode(await readAll(follower.body)), "hello");
  assertEquals(head.byteLength, 5);
  assertEquals(head.digest, await digestContent(encoder.encode("hello")));
  assertEquals(await store.read("stream/retain"), encoder.encode("hello"));
});

Deno.test("discard drops a verified prefix and finalizes only the remainder", async () => {
  const store = createMemoryAssetBodyStore();
  const writer = await createProgressiveBodyWriter(store, {
    key: "stream/discard",
    mediaType: "text/plain",
  });
  await writer.write(encoder.encode("hello world"));
  const live = await openProgressiveBodyFollower(store, {
    key: "stream/discard",
  });
  await writer.discard(6);
  const liveError = await assertRejects(() => readAll(live.body));
  assertEquals(isContentError(liveError) && liveError.code, "asset_deleted");
  const openError = await assertRejects(() =>
    openProgressiveBodyFollower(store, {
      key: "stream/discard",
      offset: 0,
    })
  );
  assertEquals(isContentError(openError) && openError.code, "asset_deleted");
  const follower = await openProgressiveBodyFollower(store, {
    key: "stream/discard",
    offset: 6,
  });
  const pending = readAll(follower.body);
  await writer.write(encoder.encode("!"));
  const head = await writer.finalize();
  assertEquals(decoder.decode(await pending), "world!");
  assertEquals(head.digest, await digestContent(encoder.encode("world!")));
  assertEquals(await store.read("stream/discard"), encoder.encode("world!"));
});

Deno.test("filesystem retain and discard use spilled staging", async () => {
  await withStore(createFilesystemHandle, async (store) => {
    const writer = await createProgressiveBodyWriter(store, {
      key: "stream/prefix",
      mediaType: "text/plain",
    });
    await writer.write(encoder.encode("keep drop"));
    await writer.discard(5);
    const head = await writer.retain();
    assertEquals(decoder.decode(await store.read("stream/prefix")), "drop");
    assertEquals(head.digest, await digestContent(encoder.encode("drop")));
    assertEquals(await store.spill?.head("stream/prefix"), null);
  });
});

Deno.test("filesystem, database, and S3 progressive writers spill a checksummed body", async () => {
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

Deno.test("a slow follower does not block other followers on spilled stores", async () => {
  await withStore(createFilesystemHandle, async (store) => {
    const writer = await createProgressiveBodyWriter(store, {
      key: "stream/slow",
      mediaType: "text/plain",
      maxBufferedBytes: 2,
    });
    const slow = await openProgressiveBodyFollower(store, {
      key: "stream/slow",
    });
    const slowReader = slow.body.getReader();
    await writer.write(encoder.encode("abcd"));
    await writer.write(encoder.encode("efgh"));
    const fast = await openProgressiveBodyFollower(store, {
      key: "stream/slow",
    });
    const pending = readAll(fast.body);
    await writer.finalize();
    assertEquals(decoder.decode(await pending), "abcdefgh");
    const first = await slowReader.read();
    assertEquals(decoder.decode(first.value), "abcdefgh");
    await slowReader.cancel();
  });
});

Deno.test("spilled stores recover a prefix after the writer process is gone", async () => {
  const root = await Deno.makeTempDir({
    prefix: "copilotz-progressive-crash-",
  });
  try {
    const first = createFilesystemAssetBodyStore({
      backendId: "filesystem:crash",
      access: denoAssetFilesystem(root),
    });
    const writer = await createProgressiveBodyWriter(first, {
      key: "stream/crash",
      mediaType: "text/plain",
    });
    await writer.write(encoder.encode("hel"));
    const recovered = createFilesystemAssetBodyStore({
      backendId: "filesystem:crash",
      access: denoAssetFilesystem(root),
    });
    const resumed = await createProgressiveBodyWriter(recovered, {
      key: "stream/crash",
      mediaType: "text/plain",
      takeover: true,
    });
    const follower = await openProgressiveBodyFollower(recovered, {
      key: "stream/crash",
    });
    const pending = readAll(follower.body);
    await resumed.write(encoder.encode("lo"));
    const head = await resumed.finalize();
    assertEquals(decoder.decode(await pending), "hello");
    assertEquals(head.digest, await digestContent(encoder.encode("hello")));
    assertEquals(await recovered.read("stream/crash"), encoder.encode("hello"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("database spilled stores recover a prefix from durable staging", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const first = createDatabaseAssetBodyStore({
      session: db,
      schema: "copilotz_progressive_crash",
    });
    const writer = await createProgressiveBodyWriter(first, {
      key: "stream/crash",
      mediaType: "text/plain",
    });
    await writer.write(encoder.encode("ab"));
    const recovered = createDatabaseAssetBodyStore({
      session: db,
      schema: "copilotz_progressive_crash",
    });
    const resumed = await createProgressiveBodyWriter(recovered, {
      key: "stream/crash",
      mediaType: "text/plain",
      takeover: true,
    });
    const follower = await openProgressiveBodyFollower(recovered, {
      key: "stream/crash",
    });
    const pending = readAll(follower.body);
    assertEquals(await recovered.head("stream/crash"), null);
    await resumed.write(encoder.encode("cd"));
    const head = await resumed.finalize();
    assertEquals(decoder.decode(await pending), "abcd");
    assertEquals(head.byteLength, 4);
    assertEquals(await recovered.read("stream/crash"), encoder.encode("abcd"));
  } finally {
    await db.close();
  }
});

Deno.test("S3 spilled stores recover a prefix from object staging", async () => {
  const handle = await createS3Handle();
  try {
    const writer = await createProgressiveBodyWriter(handle.store, {
      key: "stream/crash",
      mediaType: "text/plain",
    });
    await writer.write(encoder.encode("xy"));
    const recovered = handle.reopen();
    const resumed = await createProgressiveBodyWriter(recovered, {
      key: "stream/crash",
      mediaType: "text/plain",
      takeover: true,
    });
    const follower = await openProgressiveBodyFollower(recovered, {
      key: "stream/crash",
    });
    const pending = readAll(follower.body);
    await resumed.write(encoder.encode("z"));
    await resumed.finalize();
    assertEquals(decoder.decode(await pending), "xyz");
    assertEquals(await recovered.read("stream/crash"), encoder.encode("xyz"));
  } finally {
    await handle.close();
  }
});
