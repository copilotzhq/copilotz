import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createS3Fixture,
  s3TestConfig,
} from "../testing/s3-body-store.fixture.ts";
import {
  createLegacyObjectBodyStore,
  legacyObjectBodyReader,
} from "./index.ts";
import { digestContent } from "./digest.ts";
import { readBodyBytes } from "./body-store.ts";
import { BODY_READ_MAX_BYTES } from "./body-store-operations.ts";
import { bodyStoreReader } from "../actions/owner-transfer-storage.ts";

const bodyId =
  "prefix/schemas/synthetic/content-streams/archive/incarnation%3Atest+body";
async function fixture(provider: "s3" | "gcs" = "gcs", size = 17) {
  const f = createS3Fixture(provider === "gcs");
  const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
  const digest = await digestContent(bytes);
  const object = {
    bytes,
    generation: 42,
    etag: '"legacy-etag"',
    metadata: {
      [`x-${provider === "gcs" ? "goog" : "amz"}-meta-copilotz-sha256`]: digest
        .slice(7),
      [`x-${provider === "gcs" ? "goog" : "amz"}-meta-copilotz-media-type`]:
        "text/plain",
      "content-type": "application/octet-stream",
      "x-amz-meta-copilotz-maintenance-version": "1",
    } as Record<string, string>,
  };
  f.objects.set(bodyId, object);
  const store = createLegacyObjectBodyStore({
    ...s3TestConfig,
    provider,
    prefix: "must-not-be-applied",
  }, { fetch: f.fetch });
  const copy = {
    key: bodyId,
    backendId: store.backendId,
    length: bytes.length,
    namespace: "archive",
  };
  return { ...f, object, store, bytes, digest, copy };
}
for (const provider of ["s3", "gcs"] as const) {
  Deno.test(`legacy ${provider} reads absolute names, metadata, empty bodies and bounded guarded ranges`, async () => {
    const f = await fixture(provider, 10 * 1024 * 1024 + 3);
    assertEquals(await f.store.head({ bodyId }), {
      bodyId,
      state: "ready",
      byteLength: f.bytes.length,
      digest: f.digest,
      mediaType: "text/plain",
      maintenanceVersion: 1,
      versionToken: provider === "gcs" ? "42:1" : '"legacy-etag"',
    });
    assertEquals(await readBodyBytes(f.store, { bodyId }), f.bytes);
    assertEquals(await legacyObjectBodyReader(f.store)(f.copy), {
      bytes: f.bytes,
      mediaType: "text/plain",
    });
    assertEquals(await bodyStoreReader(() => f.store)(f.copy), {
      bytes: f.bytes,
      mediaType: "text/plain",
    });
    assertEquals(
      await f.store.readRange({ bodyId, offset: 2, end: 9 }),
      f.bytes.slice(2, 9),
    );
    const tail = await f.store.follow({ bodyId, offset: f.bytes.length - 3 });
    assertEquals(
      new Uint8Array(await new Response(tail).arrayBuffer()),
      f.bytes.slice(-3),
    );
    const empty = await fixture(provider, 0);
    assertEquals(
      (await legacyObjectBodyReader(empty.store)(empty.copy)).bytes,
      new Uint8Array(),
    );
    assertEquals(
      await readBodyBytes(empty.store, { bodyId }),
      new Uint8Array(),
    );
    assertEquals(empty.requests.some((r) => r.method === "GET"), false);
    for (const request of f.requests) {
      assert(["HEAD", "GET"].includes(request.method));
      assertEquals(
        decodeURIComponent(new URL(request.url).pathname),
        `/test-bucket/${bodyId}`,
      );
      if (request.method === "GET") {
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(
          request.headers.get("range")!,
        )!;
        assert(Number(end) - Number(start) + 1 <= BODY_READ_MAX_BYTES);
        assertEquals(
          request.headers.get(
            provider === "gcs" ? "x-goog-if-generation-match" : "if-match",
          ),
          provider === "gcs" ? "42" : '"legacy-etag"',
        );
        if (provider === "gcs") {
          assertEquals(
            request.headers.get("x-goog-if-metageneration-match"),
            "1",
          );
        }
      }
    }
  });

  Deno.test(`legacy ${provider} refuses changed versions between HEAD and GET and across calls`, async () => {
    const f = await fixture(provider);
    const stream = await f.store.read({ bodyId });
    f.object.generation++;
    f.object.etag = '"changed"';
    await assertRejects(
      () => new Response(stream).arrayBuffer(),
      Error,
      "source changed",
    );
    await assertRejects(
      () => f.store.readRange({ bodyId, offset: 0, end: 1 }),
      Error,
      "source version changed",
    );
  });
}
Deno.test("legacy reader refuses absent objects, absent digest, corruption, wrong length/backend and progressive sources", async () => {
  const f = await fixture();
  assertEquals(await f.store.head({ bodyId: "missing" }), null);
  await assertRejects(
    () => f.store.read({ bodyId: "missing" }),
    Error,
    "source object is missing",
  );
  await assertRejects(
    () => legacyObjectBodyReader(f.store)({ ...f.copy, key: "missing" }),
    Error,
    "source object is missing",
  );
  await assertRejects(
    () => legacyObjectBodyReader(f.store)({ ...f.copy, length: 1 }),
    Error,
    "retained length differs",
  );
  await assertRejects(
    () => legacyObjectBodyReader(f.store)({ ...f.copy, backendId: "other" }),
    Error,
    "wrong migration backend",
  );
  f.object.bytes[0] ^= 255;
  await assertRejects(
    () => legacyObjectBodyReader(f.store)(f.copy),
    Error,
    "digest mismatch",
  );
  // The automatic upgrade resolver must use the same verified reader.
  await assertRejects(
    () => bodyStoreReader(() => f.store)(f.copy),
    Error,
    "digest mismatch",
  );
  delete f.object.metadata["x-goog-meta-copilotz-sha256"];
  await assertRejects(
    () => f.store.head({ bodyId }),
    Error,
    "missing or invalid copilotz-sha256",
  );
  for (const state of ["open", "incomplete"]) {
    f.objects.set(`${state}.progressive/meta.json`, {
      ...f.object,
      bytes: new TextEncoder().encode(JSON.stringify({ state })),
    });
    await assertRejects(
      () => f.store.head({ bodyId: state }),
      Error,
      "progressive legacy bodies (including incomplete) are unsupported",
    );
  }
});
Deno.test("legacy store refuses every mutation and maintenance call without HTTP", async () => {
  const f = await fixture();
  for (
    const operation of [
      f.store.put,
      f.store.reserve,
      f.store.fence,
      f.store.append,
      f.store.seal,
      f.store.terminate,
      f.store.abort,
      f.store.maintenance.list,
      f.store.maintenance.delete,
    ]
  ) {
    assertThrows(() => operation({} as never), Error, "read-only store");
  }
  assertEquals(f.requests.length, 0);
});
Deno.test("legacy source refuses weak ETags, absent generations and transformed ranges", async () => {
  const f = await fixture("s3");
  f.object.etag = 'W/"weak"';
  await assertRejects(
    () => f.store.head({ bodyId }),
    Error,
    "missing exact source ETag",
  );
  for (const change of ["generation", "metageneration", "range", "version"]) {
    const g = await fixture();
    const store = createLegacyObjectBodyStore({
      ...s3TestConfig,
      provider: "gcs",
    }, {
      fetch: async (input, init) => {
        const response = await g.fetch(input, init);
        if (change === "generation") {
          response.headers.delete("x-goog-generation");
        }
        if (change === "metageneration") {
          response.headers.delete("x-goog-metageneration");
        }
        if (input instanceof Request && input.method === "GET") {
          if (change === "range") {
            response.headers.set("content-range", "bytes 0-1/2");
          }
          if (change === "version") {
            response.headers.set("x-goog-metageneration", "2");
          }
        }
        return response;
      },
    });
    await assertRejects(
      () => legacyObjectBodyReader(store)(g.copy),
      Error,
      ["generation", "metageneration"].includes(change)
        ? "missing exact source generation"
        : "source changed",
    );
  }
});
