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
  maintainProgressiveBodies,
  readBodyBytes,
  readBodyRange,
} from "./index.ts";
import {
  createProgressiveBodyWriter,
  openProgressiveBodyFollower,
  progressiveBodyTesting,
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
  create: () =>
    | Readonly<{ store: BodyStore; close?: () => Promise<void> }>
    | Promise<Readonly<{ store: BodyStore; close?: () => Promise<void> }>>,
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
  etag: string;
};

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function createS3Handle() {
  const objects = new Map<string, StoredObject>();
  let etagSequence = 0;
  const nextEtag = () => `"etag-${++etagSequence}"`;
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
            "etag": existing.etag,
            "last-modified": existing.modified,
            "x-amz-meta-copilotz-sha256": existing.digest.slice(
              "sha256:".length,
            ),
            "x-amz-meta-copilotz-media-type": existing.mediaType,
          },
        });
      }
      if (request.method === "PUT") {
        if (request.headers.get("if-none-match") === "*" && existing) {
          return new Response(null, { status: 412 });
        }
        const ifMatch = request.headers.get("if-match");
        if (ifMatch && (!existing || existing.etag !== ifMatch)) {
          return new Response(null, { status: 412 });
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        const etag = nextEtag();
        objects.set(path, {
          bytes,
          mediaType: request.headers.get("content-type") ??
            "application/octet-stream",
          digest: `sha256:${
            request.headers.get("x-amz-meta-copilotz-sha256") ?? ""
          }`,
          modified: new Date().toUTCString(),
          etag,
        });
        return new Response(null, {
          status: 200,
          headers: {
            etag,
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
            }</Key><LastModified>${value.modified}</LastModified><ETag>${
              xmlEscape(value.etag)
            }</ETag><Size>${value.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`
          ).join("");
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bucket</Name><Prefix>${
              xmlEscape(prefix)
            }</Prefix><KeyCount>${objects.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
            { headers: { "content-type": "application/xml" } },
          );
        }
        if (!existing) return new Response(null, { status: 404 });
        const range = request.headers.get("range")?.match(
          /^bytes=(\d+)-(\d+)$/,
        );
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(Number(range[2]) + 1, existing.bytes.byteLength);
          return new Response(existing.bytes.slice(start, end), {
            status: 206,
            headers: {
              "content-type": existing.mediaType,
              etag: existing.etag,
              "content-range": `bytes ${start}-${
                end - 1
              }/${existing.bytes.byteLength}`,
            },
          });
        }
        return new Response(existing.bytes.slice(), {
          headers: {
            "content-type": existing.mediaType,
            etag: existing.etag,
            "last-modified": existing.modified,
          },
        });
      }
      if (request.method === "DELETE") {
        const ifMatch = request.headers.get("if-match");
        if (ifMatch && (!existing || existing.etag !== ifMatch)) {
          return new Response(null, { status: 412 });
        }
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
  assertEquals(typeof store.readRange, "function");
  const writer = await createProgressiveBodyWriter(store, {
    bodyId,
    mediaType: "text/plain",
  });
  const follower = await openProgressiveBodyFollower(store, { bodyId });
  const pending = readAll(follower.body);
  await writer.write(encoder.encode("hel"));
  await writer.write(encoder.encode("lo"));
  assertEquals(
    decoder.decode(await readBodyRange(store, { bodyId, offset: 1, end: 4 })),
    "ell",
  );
  const head = await writer.finalize();
  assertEquals(decoder.decode(await pending), "hello");
  assertEquals(head.byteLength, 5);
  assertEquals(head.digest, await digestContent(encoder.encode("hello")));
  assertEquals(await readBodyBytes(store, { bodyId }), encoder.encode("hello"));
  assertEquals(
    decoder.decode(await readBodyRange(store, { bodyId, offset: 2, end: 5 })),
    "llo",
  );
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

Deno.test("progressive cache is bounded and released at terminal state", async () => {
  const store = createMemoryBodyStore();
  const writer = await createProgressiveBodyWriter(store, {
    bodyId: "stream/bounded",
    mediaType: "text/plain",
    maxBufferedBytes: 4,
  });
  await writer.write(encoder.encode("abcd"));
  await writer.write(encoder.encode("efgh"));
  assertEquals(progressiveBodyTesting.inspect(store, writer.bodyId), {
    state: "open",
    byteLength: 8,
    bufferOffset: 4,
    bufferedBytes: 4,
    followers: 0,
  });

  const follower = await openProgressiveBodyFollower(store, {
    bodyId: writer.bodyId,
  });
  const pending = readAll(follower.body);
  await writer.finalize();
  assertEquals(decoder.decode(await pending), "abcdefgh");
  assertEquals(progressiveBodyTesting.inspect(store, writer.bodyId), null);

  const abandoned = await createProgressiveBodyWriter(store, {
    bodyId: "stream/released-abandon",
    mediaType: "text/plain",
    maxBufferedBytes: 2,
  });
  await abandoned.write(encoder.encode("partial"));
  assertEquals(
    progressiveBodyTesting.inspect(store, abandoned.bodyId)?.bufferedBytes,
    2,
  );
  await abandoned.abandon();
  assertEquals(progressiveBodyTesting.inspect(store, abandoned.bodyId), null);
});

Deno.test("failed recovery hydration aborts its newly fenced writer", async () => {
  const base = createMemoryBodyStore({ protectionMs: 0 });
  const original = await base.reserve({
    bodyId: "stream/recovery-read-failure",
    mediaType: "text/plain",
  });
  await base.append({
    writer: original,
    expectedOffset: 0,
    appendId: "partial",
    bytes: encoder.encode("partial"),
  });
  const failing: BodyStore = Object.freeze({
    ...base,
    follow() {
      throw new Error("simulated recovery read failure");
    },
  });
  await assertRejects(() =>
    createProgressiveBodyWriter(failing, {
      bodyId: original.bodyId,
      mediaType: original.mediaType,
      takeover: true,
    })
  );
  assertEquals(await base.head({ bodyId: original.bodyId }), null);
  assertEquals(progressiveBodyTesting.inspect(failing, original.bodyId), null);
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
    assertEquals(
      progressiveBodyTesting.inspect(store, writer.bodyId)?.bufferedBytes,
      2,
    );
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

Deno.test("S3 maintenance discovers and idempotently removes expired staging", async () => {
  const handle = await createS3Handle();
  try {
    const writer = await handle.store.reserve({
      bodyId: "stream/expired-s3",
      mediaType: "text/plain",
    });
    await handle.store.append({
      writer,
      expectedOffset: 0,
      appendId: "partial",
      bytes: encoder.encode("partial"),
    });

    const recovered = handle.reopen();
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
    await handle.close();
  }
});
