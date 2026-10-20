import { assertEquals, assertRejects } from "@std/assert";
import {
  createGcsBodyStore,
  createGcsBodyStoreAdapter,
  createGcsMetadataAccessTokenProvider,
} from "./gcs-body-store.ts";

const bytes = new TextEncoder().encode("hello");
const digest =
  "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" as const;

function metadata(name = "body"): Response {
  return Response.json({
    name,
    size: "5",
    generation: "12",
    metageneration: "1",
    updated: "2025-01-01T00:00:00.000Z",
    contentType: "text/plain",
    metadata: {
      "copilotz-sha256": digest,
      "copilotz-media-type": "text/plain",
      "copilotz-maintenance-version": "1",
    },
  });
}

Deno.test("GCS metadata token provider caches and singleflights refreshes", async () => {
  let calls = 0;
  const getToken = createGcsMetadataAccessTokenProvider({
    fetch: async () => {
      calls++;
      return Response.json({ access_token: "token", expires_in: 3600 });
    },
  });
  assertEquals(await Promise.all([getToken(), getToken()]), ["token", "token"]);
  assertEquals(calls, 1);
});

Deno.test("GCS metadata tokens refresh, recover after failure, and time out", async () => {
  let now = 0, calls = 0;
  const provider = createGcsMetadataAccessTokenProvider({
    now: () => now,
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response("no", { status: 503 });
      return Response.json({ access_token: `token-${calls}`, expires_in: 61 });
    },
  });
  await assertRejects(() => provider());
  assertEquals(await provider(), "token-2");
  now = 2_000;
  assertEquals(await provider(), "token-3");
  const timeout = createGcsMetadataAccessTokenProvider({
    metadataTimeoutMs: 5,
    fetch: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
        )
      ),
  });
  await assertRejects(() => timeout());
});

Deno.test("GCS immutable put accepts only an exact existing winner", async () => {
  let uploadCalls = 0;
  let uploadUrl = "";
  let multipart = "";
  const store = createGcsBodyStore({
    bucket: "bucket",
    backendId: "gcs:test",
    getAccessToken: async () => "token",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/upload/")) {
        uploadCalls++;
        uploadUrl = url.toString();
        multipart = new TextDecoder().decode(init?.body as Uint8Array);
        return new Response(null, { status: 412 });
      }
      if (url.searchParams.get("alt") === "media") {
        assertEquals(url.searchParams.get("generation"), "12");
        return new Response(bytes, {
          status: 206,
          headers: { "content-range": "bytes 0-4/5" },
        });
      }
      return metadata();
    },
  });
  assertEquals(
    (await store.put({
      bodyId: "body",
      bytes,
      digest,
      mediaType: "text/plain",
    })).bodyId,
    "body",
  );
  assertEquals(uploadCalls, 1);
  assertEquals(new URL(uploadUrl).searchParams.get("ifGenerationMatch"), "0");
  assertEquals(multipart.includes('"copilotz-sha256"'), true);
  assertEquals(multipart.includes("hello"), true);
  const conflict = createGcsBodyStore({
    bucket: "bucket",
    backendId: "gcs:test",
    getAccessToken: async () => "token",
    fetch: async () =>
      Response.json({
        name: "body",
        size: "5",
        generation: "12",
        metageneration: "1",
        contentType: "text/plain",
        metadata: {
          "copilotz-sha256":
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "copilotz-media-type": "text/plain",
          "copilotz-maintenance-version": "1",
        },
      }),
  });
  await assertRejects(() =>
    conflict.put({ bodyId: "body", bytes, digest, mediaType: "text/plain" })
  );
});

Deno.test("GCS rejects invalid canonical input before any network request", async () => {
  let calls = 0;
  const store = createGcsBodyStore({
    bucket: "bucket",
    backendId: "gcs:test",
    getAccessToken: async () => "token",
    fetch: async () => {
      calls++;
      return metadata();
    },
  });
  await assertRejects(() =>
    store.put({
      bodyId: "body",
      bytes,
      digest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mediaType: "text/plain",
    })
  );
  assertEquals(calls, 0);
});

Deno.test("GCS adapter is Ready-only, no-GC, and does not rewrite cross-scope body IDs", async () => {
  const adapter = createGcsBodyStoreAdapter({
    bucket: "bucket",
    backendId: "gcs:test",
    getAccessToken: async () => "token",
    fetch: async () => metadata("schemas/a/namespaces/n/assets/x"),
  });
  assertEquals(adapter.deployment.readyGarbageCollection, false);
  assertEquals(
    await adapter.maintenanceForScope({
      namespace: "stream",
      databaseSchema: "a",
      maintenance: true,
    }).delete({
      bodyId: "x",
      expectedState: "ready",
      expectedMaintenanceVersion: 1,
      expectedVersionToken: "12:1",
      idleForMs: 0,
    }),
    false,
  );
  assertEquals(
    (await adapter.forScope({ namespace: "content", databaseSchema: "a" }).head(
      { bodyId: "schemas/a/namespaces/n/assets/x" },
    ))?.bodyId,
    "schemas/a/namespaces/n/assets/x",
  );
});

Deno.test("GCS range, malformed metadata, and progressive operations fail closed", async () => {
  const store = createGcsBodyStore({
    bucket: "bucket",
    backendId: "gcs:test",
    getAccessToken: async () => "token",
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("alt") === "media") return new Response(bytes);
      return metadata();
    },
  });
  // The JSON API object endpoint is also used for media reads; fake the range response by method headers.
  let mediaUrl = "";
  const rangeStore = createGcsBodyStore({
    bucket: "bucket",
    backendId: "gcs:test",
    getAccessToken: async () => "token",
    fetch: async (input, init) => {
      if (init?.headers && new Headers(init.headers).has("range")) {
        mediaUrl = String(input);
        return new Response(bytes, {
          status: 206,
          headers: { "content-range": "bytes 0-4/5" },
        });
      }
      return metadata();
    },
  });
  assertEquals(
    await rangeStore.readRange({ bodyId: "body", offset: 0, end: 5 }),
    bytes,
  );
  assertEquals(new URL(mediaUrl).searchParams.get("alt"), "media");
  assertEquals(new URL(mediaUrl).searchParams.get("generation"), "12");
  await assertRejects(async () =>
    await store.reserve({
      bodyId: "body",
      mediaType: "text/plain",
      reservationId: "test",
      generation: 1,
    })
  );
  const malformed = createGcsBodyStore({
    bucket: "bucket",
    backendId: "gcs:test",
    getAccessToken: async () => "token",
    fetch: async () => Response.json({ name: "body", size: "nope" }),
  });
  await assertRejects(() => malformed.head({ bodyId: "body" }));
});

Deno.test("GCS bounds metadata and token response bodies before decoding", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const response = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(65537));
          },
          cancel() {
            cancelled = true;
          },
        }),
        declared ? { headers: { "content-length": "65537" } } : {},
      );
    const store = createGcsBodyStore({
      bucket: "bucket",
      backendId: "gcs:test",
      getAccessToken: () => Promise.resolve("token"),
      fetch: () => Promise.resolve(response()),
    });
    await assertRejects(() => store.head({ bodyId: "oversized" }));
    assertEquals(cancelled, true);
  }
  const token = createGcsMetadataAccessTokenProvider({
    fetch: () => Promise.resolve(new Response(new Uint8Array(16385))),
  });
  await assertRejects(() => token());
});
