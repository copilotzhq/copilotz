import { assert, assertEquals, assertRejects } from "@std/assert";
import { bodyStoreConformance } from "../testing/body-store-conformance.ts";
import {
  createS3BodyStore,
  s3BodyStoreReadyGarbageCollection,
} from "./s3-body-store.ts";
import {
  createS3Fixture,
  s3TestConfig,
} from "../testing/s3-body-store.fixture.ts";
import { digestContent } from "./digest.ts";
const bytes = (text: string) => new TextEncoder().encode(text);
for (const provider of ["s3", "gcs"] as const) {
  Deno.test(`S3 ${provider} BodyStore physical conformance`, async (t) => {
    const fixture = createS3Fixture(provider === "gcs"),
      store = createS3BodyStore({ ...s3TestConfig, provider }, {
        fetch: fixture.fetch,
      });
    await bodyStoreConformance(t, store);
    assertEquals(store.conditionalDelete, provider === "gcs");
    assertEquals(
      s3BodyStoreReadyGarbageCollection({ ...s3TestConfig, provider }),
      provider === "gcs",
    );
  });
}
Deno.test("S3 losing identical append never deletes a shared accepted immutable part", async () => {
  const fixture = createS3Fixture(),
    store = createS3BodyStore(s3TestConfig, { fetch: fixture.fetch });
  const writer = await store.reserve({
    bodyId: "race",
    mediaType: "text/plain",
    reservationId: "shared",
    generation: 1,
  });
  const gate = fixture.hold((request) =>
    request.method === "PUT" && request.url.endsWith("/manifest.json")
  );
  const input = {
      writer,
      expectedOffset: 0,
      appendId: "same",
      bytes: bytes("shared"),
    },
    loser = store.append(input);
  await gate.arrived;
  await store.append(input);
  gate.release();
  await loser;
  assertEquals(
    await store.readRange({ bodyId: writer.bodyId, offset: 0, end: 6 }),
    bytes("shared"),
  );
  assertEquals(
    fixture.requests.filter((request) => request.method === "DELETE").length,
    0,
  );
  assertEquals(
    [...fixture.objects.keys()].filter((key) => key.includes("/parts/")).length,
    1,
  );
});
Deno.test("S3 fencing wins a delayed reserve and an append dispatched before revocation", async () => {
  const fixture = createS3Fixture(),
    store = createS3BodyStore(s3TestConfig, { fetch: fixture.fetch });
  const identity = {
    bodyId: "delayed",
    mediaType: "text/plain",
    reservationId: "delayed",
    generation: 1,
  };
  const gate = fixture.hold((request) =>
    request.method === "PUT" && request.url.endsWith("/manifest.json")
  );
  const pending = store.reserve(identity);
  const outcome = Promise.allSettled([pending]);
  await gate.arrived;
  const next = await store.fence({
    writer: { ...identity, byteLength: 0, discarded: 0 },
  });
  gate.release();
  assertEquals((await outcome)[0].status, "rejected");
  assertEquals(next.generation, 2);
  const writer = await store.reserve({ ...identity, bodyId: "late-append" });
  const appendGate = fixture.hold((request) =>
    request.method === "PUT" && request.url.endsWith("/manifest.json")
  );
  const append = Promise.allSettled([
    store.append({
      writer,
      expectedOffset: 0,
      appendId: "late",
      bytes: bytes("tail"),
    }),
  ]);
  await appendGate.arrived;
  await store.fence({ writer });
  appendGate.release();
  assertEquals((await append)[0].status, "rejected");
  assertEquals((await store.head({ bodyId: writer.bodyId }))?.byteLength, 0);
});
Deno.test("S3 growth budgets are checked before upload and never prevent fencing or retained reads", async () => {
  const fixture = createS3Fixture(),
    store = createS3BodyStore(s3TestConfig, {
      fetch: fixture.fetch,
      maxParts: 1,
    });
  const writer = await store.reserve({
    bodyId: "growth",
    mediaType: "text/plain",
    reservationId: "growth",
    generation: 1,
  });
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "one",
    bytes: bytes("first"),
  });
  const before =
    fixture.requests.filter((request) => request.method === "PUT").length;
  await assertRejects(() =>
    store.append({
      writer,
      expectedOffset: 5,
      appendId: "two",
      bytes: bytes("tail"),
    })
  );
  assertEquals(
    fixture.requests.filter((request) => request.method === "PUT").length,
    before,
  );
  const reopened = createS3BodyStore(s3TestConfig, {
    fetch: fixture.fetch,
    maxManifestBytes: 1,
  });
  const next = await reopened.fence({ writer });
  assertEquals(
    await reopened.readRange({ bodyId: writer.bodyId, offset: 0, end: 5 }),
    bytes("first"),
  );
  await reopened.terminate({
    writer: next,
    expectedByteLength: 5,
    expectedDigest: await digestContent(bytes("first")),
  });
});
Deno.test("S3 keys are collision safe and conditional retirement uses signed GCS generations", async () => {
  const fixture = createS3Fixture(true),
    store = createS3BodyStore({ ...s3TestConfig, provider: "gcs" }, {
      fetch: fixture.fetch,
    });
  for (const bodyId of ["a/b", "a%2Fb", "a/../b", "a\\b", "a+ b"]) {
    const head = await store.put({
      bodyId,
      mediaType: "text/plain",
      bytes: bytes(bodyId),
      digest: await digestContent(bytes(bodyId)),
    });
    assertEquals(head.bodyId, bodyId);
  }
  assertEquals(
    [...fixture.objects.keys()].filter((key) => key.endsWith("manifest.json"))
      .length,
    5,
  );
  const list = await store.maintenance.list({
    states: ["ready"],
    idleForMs: 0,
    limit: 20,
  });
  assertEquals(list.bodies.length, 5);
  const head = list.bodies[0];
  assert(
    await store.maintenance.delete({
      bodyId: head.bodyId,
      expectedState: "ready",
      expectedVersionToken: head.versionToken,
      idleForMs: 0,
    }),
  );
  for (
    const request of fixture.requests.filter((request) =>
      request.method === "DELETE"
    )
  ) {
    assert(
      request.headers.get("authorization")?.includes(
        "x-goog-if-generation-match",
      ),
    );
    assert(
      request.headers.get("authorization")?.includes(
        "x-goog-if-metageneration-match",
      ),
    );
  }
});

Deno.test("S3 exact retries reconcile lost committed reserve, append and fence acknowledgements", async () => {
  const fixture = createS3Fixture();
  let lose = false;
  const store = createS3BodyStore(s3TestConfig, {
    fetch: async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (
        lose && input instanceof Request && input.method === "PUT" &&
        input.url.endsWith("manifest.json")
      ) {
        lose = false;
        throw new Error("lost committed acknowledgement");
      }
      return response;
    },
  });
  const identity = {
    bodyId: "lost",
    mediaType: "text/plain",
    reservationId: "lost",
    generation: 1,
  };
  lose = true;
  await assertRejects(() => store.reserve(identity));
  const writer = await store.reserve(identity);
  const request = {
    writer,
    expectedOffset: 0,
    appendId: "append",
    bytes: bytes("bytes"),
  };
  lose = true;
  await assertRejects(() => store.append(request));
  const committed = (await store.head({ bodyId: writer.bodyId }))!;
  assertEquals(
    (await store.append(request)).versionToken,
    committed.versionToken,
  );
  assertEquals(
    [...fixture.objects.keys()].filter((key) => key.includes("/parts/")).length,
    1,
  );
  lose = true;
  await assertRejects(() => store.fence({ writer }));
  const fenced = await store.fence({ writer });
  assertEquals(fenced.generation, 2);
  assertEquals(await store.fence({ writer }), fenced);
});
Deno.test("S3 rejects missing GET version tokens, malformed identity and missing parts", async () => {
  const fixture = createS3Fixture();
  let mode = "ordinary";
  const store = createS3BodyStore(s3TestConfig, {
    fetch: async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (!(input instanceof Request) || response.status !== 200) {
        return response;
      }
      if (mode === "no-etag" && input.method === "GET") {
        const headers = new Headers(response.headers);
        headers.delete("etag");
        return new Response(await response.arrayBuffer(), { headers });
      }
      return response;
    },
  });
  const writer = await store.reserve({
    bodyId: "validation",
    mediaType: "text/plain",
    reservationId: "validation",
    generation: 1,
  });
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "a",
    bytes: bytes("abcd"),
  });
  mode = "no-etag";
  await assertRejects(() => store.head({ bodyId: writer.bodyId }));
  mode = "ordinary";
  const part = [...fixture.objects.keys()].find((key) =>
    key.includes("/parts/")
  )!;
  fixture.objects.delete(part);
  assertEquals(
    await store.readRange({ bodyId: writer.bodyId, offset: 0, end: 0 }),
    new Uint8Array(),
  );
  await assertRejects(() =>
    store.readRange({ bodyId: writer.bodyId, offset: 0, end: 4 })
  );
  const key = [...fixture.objects.keys()].find((key) =>
      key.endsWith("manifest.json")
    )!,
    object = fixture.objects.get(key)!;
  const changed = JSON.parse(new TextDecoder().decode(object.bytes));
  changed.bodyId = "other";
  object.bytes = new TextEncoder().encode(JSON.stringify(changed));
  await assertRejects(() => store.head({ bodyId: writer.bodyId }));
});
Deno.test("GCS-compatible S3 refuses incomplete generation guards before collection", async () => {
  const fixture = createS3Fixture(true);
  let omit = false;
  const store = createS3BodyStore({ ...s3TestConfig, provider: "gcs" }, {
    fetch: async (input, init) => {
      const response = await fixture.fetch(input, init);
      if (omit && response.status === 200) {
        const headers = new Headers(response.headers);
        headers.delete("x-goog-metageneration");
        return new Response(response.body, {
          headers,
          status: response.status,
        });
      }
      return response;
    },
  });
  const writer = await store.reserve({
      bodyId: "guard",
      mediaType: "text/plain",
      reservationId: "guard",
      generation: 1,
    }),
    head = (await store.head({ bodyId: writer.bodyId }))!;
  omit = true;
  await assertRejects(() =>
    store.maintenance.delete({
      bodyId: writer.bodyId,
      expectedState: "open",
      expectedVersionToken: head.versionToken,
      idleForMs: 0,
    })
  );
  assertEquals(
    fixture.requests.filter((request) => request.method === "DELETE").length,
    0,
  );
});

Deno.test("GCS-compatible retirement resumes interrupted part cleanup and blocks delayed resurrection", async () => {
  const fixture = createS3Fixture(true);
  let fail = true;
  const store = createS3BodyStore({ ...s3TestConfig, provider: "gcs" }, {
    fetch: (input, init) => {
      if (fail && input instanceof Request && input.method === "DELETE") {
        fail = false;
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return fixture.fetch(input, init);
    },
  });
  const identity = {
      bodyId: "retiring",
      mediaType: "text/plain",
      reservationId: "retiring",
      generation: 1,
    },
    writer = await store.reserve(identity);
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "part",
    bytes: bytes("bytes"),
  });
  const original = (await store.head({ bodyId: writer.bodyId }))!;
  const deletion = {
    bodyId: writer.bodyId,
    expectedState: "open" as const,
    expectedVersionToken: original.versionToken,
    idleForMs: 0,
  };
  await assertRejects(() => store.maintenance.delete(deletion));
  const diagnostic = (await store.head({ bodyId: writer.bodyId }))!;
  assertEquals(diagnostic.state, "aborted");
  assert(diagnostic.versionToken !== original.versionToken);
  await assertRejects(() => store.reserve(identity));
  await assertRejects(() => store.fence({ writer }));
  assertEquals(await store.maintenance.delete(deletion), true);
  assertEquals(await store.head({ bodyId: writer.bodyId }), null);
  assertEquals(await store.maintenance.delete(deletion), true);
  assertEquals(
    [...fixture.objects.keys()].filter((key) => key.includes("/parts/")).length,
    0,
  );
  await assertRejects(() => store.reserve(identity));
});

Deno.test("GCS retirement discovers late speculative uploads and sweeps only its retired namespace", async () => {
  const fixture = createS3Fixture(true),
    store = createS3BodyStore({ ...s3TestConfig, provider: "gcs" }, {
      fetch: fixture.fetch,
    });
  const writer = await store.reserve({
    bodyId: "late-orphan",
    mediaType: "text/plain",
    reservationId: "late-orphan",
    generation: 1,
  });
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "accepted",
    bytes: bytes("first"),
  });
  const other = await store.put({
    bodyId: "active-other",
    mediaType: "text/plain",
    bytes: bytes("protected"),
    digest: await digestContent(bytes("protected")),
  });
  const gate = fixture.hold((request) =>
    request.method === "PUT" && request.url.includes("/parts/")
  );
  const late = Promise.allSettled([
    store.append({
      writer,
      expectedOffset: 5,
      appendId: "late",
      bytes: bytes("orphan"),
    }),
  ]);
  await gate.arrived;
  const head = (await store.head({ bodyId: writer.bodyId }))!;
  assertEquals(
    await store.maintenance.delete({
      bodyId: writer.bodyId,
      expectedState: "open",
      expectedVersionToken: head.versionToken,
      idleForMs: 0,
    }),
    true,
  );
  assertEquals(await store.head({ bodyId: writer.bodyId }), null);
  gate.release();
  assertEquals((await late)[0].status, "rejected");
  const listed = await store.maintenance.list({
    states: ["aborted"],
    idleForMs: 0,
    limit: 10,
  });
  assertEquals(listed.bodies.map((body) => body.bodyId), [writer.bodyId]);
  const orphan = listed.bodies[0];
  assertEquals((await store.head({ bodyId: writer.bodyId }))?.state, "aborted");
  assertEquals(
    await store.maintenance.delete({
      bodyId: writer.bodyId,
      expectedState: "aborted",
      expectedVersionToken: orphan.versionToken,
      idleForMs: 0,
    }),
    true,
  );
  assertEquals(await store.head({ bodyId: writer.bodyId }), null);
  assertEquals(
    await store.readRange({
      bodyId: other.bodyId,
      offset: 0,
      end: other.byteLength,
    }),
    bytes("protected"),
  );
  await assertRejects(() =>
    store.reserve({
      bodyId: writer.bodyId,
      mediaType: writer.mediaType,
      reservationId: writer.reservationId,
      generation: writer.generation,
    })
  );
});

Deno.test("fresh S3 append uses one manifest GET and two conditional PUTs", async () => {
  const fixture = createS3Fixture();
  const store = createS3BodyStore(s3TestConfig, { fetch: fixture.fetch });
  const writer = await store.reserve({
    bodyId: "counted",
    reservationId: "counted",
    generation: 1,
    mediaType: "text/plain",
  });
  const before = fixture.requests.length;
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "one",
    bytes: bytes("prefix"),
  });
  assertEquals(
    fixture.requests.slice(before).map((request) => request.method),
    ["GET", "PUT", "PUT"],
  );
});
