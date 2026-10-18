import { PHYSICAL_READ_MAX_BYTES } from "./physical-body-store.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createS3PhysicalBodyStore } from "./s3-physical-body-store.ts";
import { digestContent } from "./digest.ts";
import { OWNER_PHYSICAL_OBJECT_ROOT } from "./physical-object-namespace.ts";
import type { PhysicalWriterIdentity } from "./physical-body-store.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const writer = (): PhysicalWriterIdentity => ({
  bodyId: "copy/one",
  mediaType: "text/plain",
  reservationId: "reservation",
  generation: 7,
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
};
function fixture() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const gates: {
    method: string;
    part: string;
    arrived: ReturnType<typeof deferred>;
    released: ReturnType<typeof deferred>;
  }[] = [];
  const allGates: typeof gates = [];
  let version = 0,
    writes = 0,
    loseMetadataReply = false,
    failBeforeMetadata = false;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname.replace(/^\/bucket\//, "");
      if (!path.startsWith(OWNER_PHYSICAL_OBJECT_ROOT)) {
        return new Response(
          null,
          { status: 400 },
        );
      }
      const body = new Uint8Array(await request.arrayBuffer());
      assertEquals(
        request.headers.get("x-amz-content-sha256"),
        (await digestContent(body)).slice(7),
      );
      const index = gates.findIndex((gate) =>
        gate.method === request.method && path.includes(gate.part)
      );
      if (index >= 0) {
        const [gate] = gates.splice(index, 1);
        gate.arrived.resolve();
        await gate.released.promise;
      }
      const existing = objects.get(path);
      const match = request.headers.get("if-match");
      if (match && existing?.etag !== match) {
        return new Response(null, {
          status: 412,
        });
      }
      if (
        request.headers.get("if-none-match") === "*" && existing
      ) return new Response(null, { status: 412 });
      if (request.method === "PUT") {
        if (failBeforeMetadata && path.endsWith("manifest.json")) {
          failBeforeMetadata = false;
          return new Response(null, { status: 503 });
        }
        writes++;
        const etag = `"revision-${++version}"`;
        objects.set(path, { bytes: body, etag });
        if (loseMetadataReply && path.endsWith("manifest.json")) {
          loseMetadataReply = false;
          return new Response(null, { status: 503 });
        }
        return new Response(null, { headers: { etag } });
      }
      if (!existing) return new Response(null, { status: 404 });
      const headers = {
        etag: existing.etag,
        "content-length": String(existing.bytes.length),
      };
      return new Response(
        request.method === "HEAD" ? null : existing.bytes.slice(),
        { headers },
      );
    },
  );
  const config = {
    backendId: "fixture",
    endpoint: `http://127.0.0.1:${server.addr.port}`,
    region: "us-east-1",
    bucket: "bucket",
    accessKeyId: "test",
    secretAccessKey: "test",
  };
  return {
    config,
    objects,
    get writes() {
      return writes;
    },
    loseReply() {
      loseMetadataReply = true;
    },
    failBefore() {
      failBeforeMetadata = true;
    },
    hold(method: string, part: string) {
      const gate = { method, part, arrived: deferred(), released: deferred() };
      gates.push(gate);
      allGates.push(gate);
      return gate;
    },
    async close() {
      for (const gate of allGates) gate.released.resolve();
      await server.shutdown();
    },
  };
}
async function refused(work: () => Promise<unknown>, code = "asset_conflict") {
  const error = await assertRejects(work);
  assertEquals((error as { code: string }).code, code);
}
Deno.test("physical S3 exact reservation, offset replay, retained tail and fence reopen", async () => {
  const f = fixture();
  try {
    const store = createS3PhysicalBodyStore(f.config, { scope: "owner" });
    const identity = writer();
    assertEquals(await store.head(identity.bodyId), null);
    const reserved = await store.reserve(identity);
    assertEquals(await store.reserve({ ...identity }), reserved);
    await refused(() => store.reserve({ ...identity, generation: 8 }));
    await store.append({
      writer: identity,
      expectedOffset: 0,
      appendId: "prefix",
      bytes: bytes("pre"),
    });
    const request = {
      writer: identity,
      expectedOffset: 3,
      appendId: "append",
      bytes: bytes("hello"),
    };
    await store.append(request);
    await store.append({
      writer: identity,
      expectedOffset: 8,
      appendId: "tail",
      bytes: bytes("tail"),
    });
    assertEquals((await store.append(request)).endOffset, 12);
    await refused(() => store.append({ ...request, expectedOffset: 0 }));
    await refused(() => store.append({ ...request, bytes: bytes("other") }));
    assertEquals(
      await store.readRange({ bodyId: identity.bodyId, offset: 2, end: 10 }),
      bytes("ehellota"),
    );
    const fenced = await store.fence(identity);
    assertEquals(fenced.generation, 8);
    assertEquals(fenced.byteLength, 12);
    const reopened = createS3PhysicalBodyStore(f.config, {
      scope: "owner",
      maxParts: 1,
      maxManifestBytes: 1,
    });
    assertEquals(await reopened.fence(identity), fenced);
    await refused(() => reopened.append(request));
    assertEquals(
      await reopened.readRange({ bodyId: identity.bodyId, offset: 0, end: 12 }),
      bytes("prehellotail"),
    );
  } finally {
    await f.close();
  }
});
Deno.test("physical S3 caps new growth before uploads and permits exact retries after lower-cap reopen", async () => {
  const f = fixture();
  try {
    const store = createS3PhysicalBodyStore(f.config, {
      scope: "owner",
      maxParts: 1,
    });
    const identity = writer();
    await store.reserve(identity);
    const request = {
      writer: identity,
      expectedOffset: 0,
      appendId: "one",
      bytes: bytes("hello"),
    };
    await store.append(request);
    const before = f.writes;
    await refused(
      () => store.append({ ...request, expectedOffset: 5, appendId: "two" }),
      "content_invalid",
    );
    assertEquals(f.writes, before);
    const lower = createS3PhysicalBodyStore(f.config, {
      scope: "owner",
      maxParts: 1,
      maxManifestBytes: 1,
    });
    assertEquals((await lower.append(request)).endOffset, 5);
    await lower.fence(identity);
    assertEquals((await lower.head(identity.bodyId))?.state, "fenced");
  } finally {
    await f.close();
  }
});
Deno.test("physical S3 absent fence defeats a delayed create-only reservation", async () => {
  const f = fixture();
  try {
    const store = createS3PhysicalBodyStore(f.config, { scope: "owner" }),
      identity = writer();
    const held = f.hold("PUT", "manifest.json");
    const reserved = store.reserve(identity);
    const failed = refused(() => reserved);
    await held.arrived.promise;
    await store.fence(identity);
    held.released.resolve();
    await failed;
    assertEquals((await store.head(identity.bodyId))?.state, "fenced");
    assertEquals(f.writes, 1);
  } finally {
    await f.close();
  }
});
Deno.test("physical S3 identical concurrent retries retain shared parts after CAS loss", async () => {
  const f = fixture();
  try {
    const store = createS3PhysicalBodyStore(f.config, { scope: "owner" }),
      identity = writer();
    await store.reserve(identity);
    const request = {
      writer: identity,
      expectedOffset: 0,
      appendId: "one",
      bytes: bytes("hello"),
    };
    const held = f.hold("PUT", "manifest.json");
    const loser = store.append(request);
    await held.arrived.promise;
    const winner = await store.append(request);
    held.released.resolve();
    assertEquals(await loser, winner);
    assertEquals(
      await store.readRange({ bodyId: identity.bodyId, offset: 0, end: 5 }),
      bytes("hello"),
    );
    assertEquals(
      [...f.objects.keys()].filter((key) => key.includes("/parts/")).length,
      1,
    );
  } finally {
    await f.close();
  }
});
Deno.test("physical S3 fence excludes a delayed append while retaining speculative bytes", async () => {
  const f = fixture();
  try {
    const store = createS3PhysicalBodyStore(f.config, { scope: "owner" }),
      identity = writer();
    await store.reserve(identity);
    const held = f.hold("PUT", "manifest.json");
    const append = store.append({
      writer: identity,
      expectedOffset: 0,
      appendId: "one",
      bytes: bytes("tail"),
    });
    const failed = refused(() => append);
    await held.arrived.promise;
    await store.fence(identity);
    held.released.resolve();
    await failed;
    assertEquals((await store.head(identity.bodyId))?.byteLength, 0);
    assertEquals(
      [...f.objects.keys()].filter((key) => key.includes("/parts/")).length,
      1,
    );
  } finally {
    await f.close();
  }
});
Deno.test("physical S3 reconciles unknown reserve, append and fence acknowledgements", async () => {
  const f = fixture();
  try {
    const store = createS3PhysicalBodyStore(f.config, { scope: "owner" }),
      identity = writer();
    f.loseReply();
    await refused(() => store.reserve(identity), "asset_storage_unavailable");
    await store.reserve(identity);
    const request = {
      writer: identity,
      expectedOffset: 0,
      appendId: "one",
      bytes: bytes("data"),
    };
    f.loseReply();
    await refused(() => store.append(request), "asset_storage_unavailable");
    assertEquals((await store.append(request)).endOffset, 4);
    f.loseReply();
    await refused(() => store.fence(identity), "asset_storage_unavailable");
    assertEquals((await store.fence(identity)).state, "fenced");
    const part = [...f.objects.entries()].find(([key]) =>
      key.includes("/parts/")
    )![1];
    part.bytes.fill(0);
    await refused(
      () => store.readRange({ bodyId: identity.bodyId, offset: 0, end: 4 }),
      "asset_storage_unavailable",
    );
  } finally {
    await f.close();
  }
});
Deno.test("physical S3 HEAD and GET cannot mix metadata versions", async () => {
  const f = fixture();
  try {
    const store = createS3PhysicalBodyStore(f.config, { scope: "owner" }),
      identity = writer();
    await store.reserve(identity);
    const held = f.hold("GET", "manifest.json");
    const reading = store.head(identity.bodyId);
    const failed = refused(() => reading);
    await held.arrived.promise;
    await store.append({
      writer: identity,
      expectedOffset: 0,
      appendId: "new",
      bytes: bytes("new"),
    });
    held.released.resolve();
    await failed;
    assertEquals((await store.head(identity.bodyId))?.byteLength, 3);
  } finally {
    await f.close();
  }
});
Deno.test("physical S3 competing append identities cannot both claim one offset", async () => {
  const f = fixture();
  try {
    const store = createS3PhysicalBodyStore(f.config, { scope: "owner" }),
      identity = writer();
    await store.reserve(identity);
    const held = f.hold("PUT", "manifest.json");
    const first = store.append({
      writer: identity,
      expectedOffset: 0,
      appendId: "first",
      bytes: bytes("first"),
    });
    const failed = refused(() => first);
    await held.arrived.promise;
    await store.append({
      writer: identity,
      expectedOffset: 0,
      appendId: "winner",
      bytes: bytes("second"),
    });
    held.released.resolve();
    await failed;
    assertEquals(
      await store.readRange({ bodyId: identity.bodyId, offset: 0, end: 6 }),
      bytes("second"),
    );
    assertEquals(
      [...f.objects.keys()].filter((key) => key.includes("/parts/")).length,
      2,
    );
  } finally {
    await f.close();
  }
});
Deno.test("physical S3 scopes isolate keys and retained metadata verifies full body identity", async () => {
  const f = fixture();
  try {
    const one = createS3PhysicalBodyStore(f.config, { scope: "one" });
    const two = createS3PhysicalBodyStore(f.config, { scope: "two" });
    const identity = writer();
    await one.reserve(identity);
    assertEquals(await two.head(identity.bodyId), null);
    await two.reserve(identity);
    await one.reserve({ ...identity, bodyId: "copy/other" });
    const entries = [...f.objects.entries()];
    assertEquals(entries.length, 3);
    f.objects.set(entries[2][0], { ...entries[0][1] });
    await refused(() => one.head("copy/other"), "asset_storage_unavailable");
    f.objects.set(entries[1][0], { ...entries[0][1] });
    await refused(() => two.head(identity.bodyId), "asset_storage_unavailable");
  } finally {
    await f.close();
  }
});
Deno.test("physical S3 missing or truncated parts refuse while empty ranges need no part read", async () => {
  const f = fixture();
  try {
    const store = createS3PhysicalBodyStore(f.config, { scope: "owner" }),
      identity = writer();
    await store.reserve(identity);
    await store.append({
      writer: identity,
      expectedOffset: 0,
      appendId: "one",
      bytes: bytes("data"),
    });
    const [key, part] = [...f.objects.entries()].find(([key]) =>
      key.includes("/parts/")
    )!;
    part.bytes = bytes("dat");
    await refused(
      () => store.readRange({ bodyId: identity.bodyId, offset: 0, end: 4 }),
      "asset_storage_unavailable",
    );
    f.objects.delete(key);
    assertEquals(
      await store.readRange({ bodyId: identity.bodyId, offset: 2, end: 2 }),
      new Uint8Array(),
    );
    await refused(
      () => store.readRange({ bodyId: identity.bodyId, offset: 0, end: 4 }),
      "asset_storage_unavailable",
    );
  } finally {
    await f.close();
  }
});
Deno.test("physical S3 pre-commit HTTP failures preserve exact retry behavior", async () => {
  const f = fixture();
  try {
    const store = createS3PhysicalBodyStore(f.config, { scope: "owner" }),
      identity = writer();
    f.failBefore();
    await refused(() => store.reserve(identity), "asset_storage_unavailable");
    assertEquals(await store.head(identity.bodyId), null);
    await store.reserve(identity);
    const request = {
      writer: identity,
      expectedOffset: 0,
      appendId: "one",
      bytes: bytes("data"),
    };
    f.failBefore();
    await refused(() => store.append(request), "asset_storage_unavailable");
    assertEquals((await store.head(identity.bodyId))?.byteLength, 0);
    await store.append(request);
    f.failBefore();
    await refused(() => store.fence(identity), "asset_storage_unavailable");
    assertEquals((await store.head(identity.bodyId))?.state, "open");
    await store.fence(identity);
    assertEquals((await store.head(identity.bodyId))?.state, "fenced");
  } finally {
    await f.close();
  }
});

Deno.test("s3 physical ranges page at the shared 1 MiB bound", async () => {
  const f = fixture();
  const store = createS3PhysicalBodyStore(f.config, { scope: "owner" }),
    identity = writer();
  try {
    const payload = new Uint8Array(PHYSICAL_READ_MAX_BYTES).fill(7);
    await store.reserve(identity);
    await store.append({
      writer: identity,
      expectedOffset: 0,
      appendId: "maximum",
      bytes: payload,
    });
    assertEquals(
      await store.readRange({
        bodyId: identity.bodyId,
        offset: 0,
        end: PHYSICAL_READ_MAX_BYTES,
      }),
      payload,
    );
    const error = await assertRejects(async () =>
      await store.readRange({
        bodyId: "missing",
        offset: 0,
        end: PHYSICAL_READ_MAX_BYTES + 1,
      })
    );
    assertEquals((error as { code: string }).code, "content_invalid");
  } finally {
    await f.close();
  }
});
