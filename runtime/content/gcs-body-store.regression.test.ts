import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createFixedBodyStoreAdapter,
  createMemoryBodyStore,
  readBodyBytes,
} from "./body-store.ts";
import { digestContent } from "./digest.ts";
import {
  createGcsBodyStore,
  createGcsBodyStoreAdapter,
  createGcsMetadataAccessTokenProvider,
} from "./gcs-body-store.ts";
import { createPromotedBodyStoreAdapter } from "./promoted-body-store.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fakeGcs() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; metadata: Record<string, unknown> }
  >();
  const requests: { url: URL; method: string }[] = [];
  let tokenRequests = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assertEquals(init?.redirect, "error");
    if (url.hostname === "metadata.google.internal") {
      tokenRequests++;
      assertEquals(headers.get("metadata-flavor"), "Google");
      return Response.json({ access_token: "fake-token", expires_in: 3600 });
    }
    assertEquals(url.origin, "https://storage.googleapis.com");
    assertEquals(headers.get("authorization"), "Bearer fake-token");
    requests.push({ url, method: init?.method ?? "GET" });
    if (init?.method === "POST") {
      assertEquals(url.searchParams.get("ifGenerationMatch"), "0");
      assertEquals(url.searchParams.get("uploadType"), "multipart");
      const boundary = headers.get("content-type")!.split("boundary=")[1];
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      // Metadata precedes the raw binary media part; never text-decode the body.
      const header = decoder.decode(
        bytes.subarray(0, Math.min(bytes.length, 4096)),
      );
      const metadataStart = header.indexOf("\r\n\r\n") + 4;
      const metadataEnd = header.indexOf(`\r\n--${boundary}`, metadataStart);
      const metadata = JSON.parse(header.slice(metadataStart, metadataEnd));
      assertEquals(metadata.cacheControl, "private, no-store");
      assertEquals(metadata.acl, undefined);
      const mediaStart = encoder.encode(
        header.slice(0, header.indexOf("\r\n\r\n", metadataEnd + 2) + 4),
      ).length;
      const mediaEnd = bytes.length -
        encoder.encode(`\r\n--${boundary}--\r\n`).length;
      if (objects.has(metadata.name)) {
        return new Response(null, { status: 412 });
      }
      const media = bytes.slice(mediaStart, mediaEnd);
      objects.set(metadata.name, {
        bytes: media,
        metadata: {
          ...metadata,
          size: String(media.length),
          generation: "9007199254740993",
          metageneration: "1",
        },
      });
      return Response.json(objects.get(metadata.name)!.metadata);
    }
    const name = decodeURIComponent(url.pathname.split("/o/")[1]);
    const object = objects.get(name);
    if (!object) return new Response(null, { status: 404 });
    if (url.searchParams.get("alt") !== "media") {
      return Response.json(object.metadata);
    }
    assertEquals(url.searchParams.get("generation"), "9007199254740993");
    const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range")!);
    assert(match);
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(object.bytes.slice(start, end + 1), {
      status: 206,
      headers: {
        "content-range": `bytes ${start}-${end}/${object.bytes.length}`,
      },
    });
  };
  return { fetcher, objects, requests, tokenRequests: () => tokenRequests };
}

Deno.test("GCS binary multipart, immutable concurrent puts, range and follow retain exact generations", async () => {
  const fake = fakeGcs();
  const store = createGcsBodyStore({
    bucket: "test-bucket",
    backendId: "gcs:test",
    fetch: fake.fetcher,
  });
  const bytes = new Uint8Array([0, 255, 13, 10, 128, 65]);
  const input = {
    bodyId: "schemas/a//body é",
    bytes,
    digest: await digestContent(bytes),
    mediaType: "application/octet-stream",
  };
  const [first, second] = await Promise.all([
    store.put(input),
    store.put(input),
  ]);
  assertEquals(first, second);
  assertEquals(first.etag, "9007199254740993");
  assertEquals(fake.objects.size, 1);
  assertEquals(fake.tokenRequests(), 1);
  assertEquals(await readBodyBytes(store, { bodyId: input.bodyId }), bytes);
  assertEquals(
    await store.readRange({ bodyId: input.bodyId, offset: 1, end: 4 }),
    bytes.slice(1, 4),
  );
  assertEquals(
    new Uint8Array(
      await new Response(
        await store.follow({ bodyId: input.bodyId, offset: 2 }),
      ).arrayBuffer(),
    ),
    bytes.slice(2),
  );
  const changed = new Uint8Array([1, 2]);
  await assertRejects(() =>
    store.put({ ...input, bytes: changed, digest: "sha256:invalid" })
  );
  const changedDigest = await digestContent(changed);
  await assertRejects(
    () => store.put({ ...input, bytes: changed, digest: changedDigest }),
    Error,
    "conflicts",
  );
  assertEquals(await readBodyBytes(store, { bodyId: input.bodyId }), bytes);
});

Deno.test("GCS explicit promotion keeps scope-independent keys and retains staging until catalog retirement", async () => {
  const fake = fakeGcs();
  const ready = createGcsBodyStoreAdapter({
    bucket: "test-bucket",
    backendId: "gcs:test",
    fetch: fake.fetcher,
  });
  const staging = createFixedBodyStoreAdapter(
    createMemoryBodyStore(),
    {
      durability: "durable",
      reach: "cluster",
      readyGarbageCollection: true,
    },
  );
  const promoted = createPromotedBodyStoreAdapter({ staging, ready });
  const scope = {
    namespace: "@copilotz/stream",
    databaseSchema: "test_schema",
  };
  const streamStore = promoted.forScope(scope);
  const bodyId = "schemas/test_schema/namespaces/customer/body-stream";
  const bytes = encoder.encode("hello from stream");
  const writer = await streamStore.reserve({
    bodyId,
    mediaType: "text/plain",
    reservationId: "stream",
    generation: 1,
  });
  await streamStore.append({
    writer,
    expectedOffset: 0,
    appendId: "one",
    bytes,
  });
  await streamStore.seal({
    writer,
    expectedByteLength: bytes.length,
    expectedDigest: await digestContent(bytes),
  });
  const content = ready.forScope({ ...scope, namespace: "@copilotz/content" });
  assertEquals(await content.head({ bodyId }), null);
  const published = await content.put({
    bodyId,
    mediaType: "text/plain",
    bytes: await readBodyBytes(streamStore, { bodyId }),
    digest: await digestContent(bytes),
  });
  assertEquals(await readBodyBytes(content, { bodyId }), bytes);
  assertEquals(
    (await staging.forScope(scope).head({ bodyId }))?.state,
    "ready",
  );
  const requestCount = fake.requests.length;
  assertEquals(
    await content.maintenance.delete({
      bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: 1,
      expectedVersionToken: published.versionToken,
      idleForMs: 0,
    }),
    false,
  );
  assertEquals(fake.requests.length, requestCount);
});

Deno.test("GCS missing and empty bodies have distinct follow/range semantics", async () => {
  const fake = fakeGcs();
  const store = createGcsBodyStore({
    bucket: "test-bucket",
    backendId: "gcs:test",
    fetch: fake.fetcher,
  });
  await assertRejects(
    () => store.follow({ bodyId: "missing" }),
    Error,
    "not found",
  );
  await assertRejects(
    () => store.readRange({ bodyId: "missing", offset: 0, end: 0 }),
    Error,
    "not found",
  );
  const bytes = new Uint8Array();
  await store.put({
    bodyId: "empty",
    bytes,
    digest: await digestContent(bytes),
    mediaType: "text/plain",
  });
  assertEquals(await readBodyBytes(store, { bodyId: "empty" }), bytes);
  await assertRejects(
    () => store.follow({ bodyId: "empty", offset: 1 }),
    RangeError,
  );
});

Deno.test("GCS rejects malformed, transformed, and overlarge generation metadata", async () => {
  const digest = await digestContent(encoder.encode("hello"));
  const base = {
    name: "body",
    size: "5",
    generation: "12",
    metageneration: "1",
    contentType: "text/plain",
    metadata: { "copilotz-sha256": digest },
  };
  for (
    const response of [
      null,
      { ...base, generation: 12 },
      { ...base, generation: "18446744073709551616" },
      { ...base, contentEncoding: "gzip" },
      { ...base, size: "9007199254740993" },
    ]
  ) {
    const store = createGcsBodyStore({
      bucket: "test-bucket",
      backendId: "gcs:test",
      getAccessToken: async () => "token",
      fetch: async () => Response.json(response),
    });
    await assertRejects(
      () => store.head({ bodyId: "body" }),
      Error,
      "metadata",
    );
  }
});

Deno.test("GCS rejects truncated and oversized streams and invalid content ranges", async () => {
  const fake = fakeGcs();
  const bytes = encoder.encode("hello");
  const normal = createGcsBodyStore({
    bucket: "test-bucket",
    backendId: "gcs:test",
    fetch: fake.fetcher,
  });
  await normal.put({
    bodyId: "body",
    bytes,
    digest: await digestContent(bytes),
    mediaType: "text/plain",
  });
  for (
    const payload of [
      encoder.encode("short"),
      encoder.encode("bad"),
      encoder.encode("too long"),
    ]
  ) {
    const corrupted = createGcsBodyStore({
      bucket: "test-bucket",
      backendId: "gcs:test",
      fetch: async (input, init) => {
        if (new URL(String(input)).searchParams.get("alt") === "media") {
          return new Response(payload, {
            status: 206,
            headers: {
              "content-range": payload.length === 5
                ? "bytes 1-5/6"
                : "bytes 0-4/5",
            },
          });
        }
        return await fake.fetcher(input, init);
      },
    });
    await assertRejects(() => readBodyBytes(corrupted, { bodyId: "body" }));
  }
});

Deno.test("GCS permission failures are bounded and do not reflect provider bodies", async () => {
  const store = createGcsBodyStore({
    bucket: "test-bucket",
    backendId: "gcs:test",
    getAccessToken: async () => "token",
    fetch: async () =>
      new Response("private-provider-details", { status: 403 }),
  });
  const error = await assertRejects(
    () => store.head({ bodyId: "body" }),
    Error,
    "403",
  );
  assert(!error.message.includes("private-provider-details"));
  const slow = createGcsBodyStore({
    bucket: "test-bucket",
    backendId: "gcs:test",
    getAccessToken: async () => "token",
    fetch: async (_input, init) =>
      await new Promise((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        )
      ),
  }, { requestTimeoutMs: 5 });
  await assertRejects(() => slow.head({ bodyId: "body" }));
  const invalid = createGcsMetadataAccessTokenProvider({
    fetch: async () =>
      Response.json({ access_token: "token", expires_in: "never" }),
  });
  await assertRejects(invalid, Error, "invalid");
});

Deno.test("GCS immutable retries verify retained bytes in bounded generation-bound ranges", async () => {
  const fake = fakeGcs(), ranges: string[] = [];
  const store = createGcsBodyStore({
    bucket: "test-bucket",
    backendId: "gcs:test",
    fetch: (input, init) => {
      const range = new Headers(init?.headers).get("range");
      if (range) ranges.push(range);
      return fake.fetcher(input, init);
    },
  });
  const bytes = new Uint8Array(1024 * 1024 + 3).fill(17);
  const input = {
    bodyId: "retained",
    mediaType: "application/octet-stream",
    bytes,
    digest: await digestContent(bytes),
  };
  await store.put(input);
  assertEquals(ranges, ["bytes=0-1048575", "bytes=1048576-1048578"]);
  fake.objects.get("retained")!.bytes[1048576] = 99;
  const error = await assertRejects(() => store.put(input));
  assertEquals((error as Error & { code: string }).code, "asset_corrupted");
});
