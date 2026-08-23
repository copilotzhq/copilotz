import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";

import {
  assetIdFromRef,
  type AssetRepository,
  type ContentError,
  type ContentRef,
  createBodyStorageRuntime,
  createContentNormalizer,
  createContentResolver,
  createMemoryAssetRepository,
  digestContent,
  formatAssetRef,
} from "./index.ts";
import { definePlugin } from "../plugins/index.ts";

function createFixture() {
  let nextId = 0;
  const assets = createMemoryAssetRepository({
    createId: () => `asset-${++nextId}`,
    now: () => new Date("2026-08-07T00:00:00.000Z"),
  });
  return { assets, normalize: createContentNormalizer({ assets }) };
}

Deno.test("canonical asset refs round-trip and reject cross-namespace access", () => {
  const ref = formatAssetRef("tenant a", "asset/id");
  assertEquals(ref, "asset://tenant%20a/asset%2Fid");
  assertEquals(assetIdFromRef("tenant a", ref), "asset/id");
  assertEquals(assetIdFromRef("tenant a", "raw-id"), "raw-id");
  assertEquals(assetIdFromRef("tenant a", "asset://legacy-id"), "legacy-id");
  assertThrows(
    () => assetIdFromRef("tenant-b", ref),
    Error,
    "active namespace",
  );
});

Deno.test("configured BodyStore is scoped infrastructure, not a plugin resource", async () => {
  const runtime = createBodyStorageRuntime({
    storage: { type: "memory", config: { backendId: "memory:test" } },
  });
  assert(runtime.adapter);
  assertThrows(
    () =>
      definePlugin({
        id: "test.body-store-is-infrastructure",
        version: "1.0.0",
        bodyStore: [{ id: "not-a-plugin-resource" }],
      } as never),
    TypeError,
    "cannot declare 'bodyStore'",
  );
  const scoped = runtime.adapter.forScope({
    namespace: "tenant-a",
    databaseSchema: "public",
  });
  const bytes = new TextEncoder().encode("scoped body");
  const head = await scoped.put({
    bodyId: "tenant-a/body-a",
    bytes,
    mediaType: "text/plain",
    digest: await digestContent(bytes),
  });
  assertEquals(head.bodyId, "tenant-a/body-a");
  const page = await runtime.adapter.maintenanceForScope({
    namespace: "tenant-a",
    databaseSchema: "public",
    maintenance: true,
  }).list({ states: ["ready"], idleForMs: 0, limit: 10 });
  assertEquals(page.bodies.map((body) => body.bodyId), ["tenant-a/body-a"]);
});

async function readStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

Deno.test("canonical content normalization preserves ordered text, JSON, media, and existing refs", async () => {
  const { assets, normalize } = createFixture();
  const existing = await assets.publish({
    namespace: "tenant-a",
    mediaType: "audio/ogg",
    body: new Uint8Array([7, 8, 9]),
  });
  const existingRef: ContentRef = {
    assetId: existing.id,
    kind: "audio",
    role: "recording",
    mediaType: "audio/ogg",
    name: "existing.ogg",
  };

  const refs = await normalize.normalize([
    "Hello",
    {
      type: "json",
      value: { query: "weather", units: "metric" },
      role: "tool.arguments",
    },
    {
      type: "image",
      bytes: new Uint8Array([1, 2, 3, 4]),
      mediaType: "image/png",
      name: "map.png",
      alt: "Weather map",
    },
    existingRef,
  ], {
    namespace: "tenant-a",
    idempotencyKey: "message-1",
  });

  assertEquals(
    refs.map((ref) => ({
      id: ref.assetId,
      kind: ref.kind,
      role: ref.role,
      mediaType: ref.mediaType,
      name: ref.name,
    })),
    [
      {
        id: "asset-2",
        kind: "text",
        role: "body",
        mediaType: "text/plain; charset=utf-8",
        name: undefined,
      },
      {
        id: "asset-3",
        kind: "json",
        role: "tool.arguments",
        mediaType: "application/json",
        name: undefined,
      },
      {
        id: "asset-4",
        kind: "image",
        role: "attachment",
        mediaType: "image/png",
        name: "map.png",
      },
      {
        id: "asset-1",
        kind: "audio",
        role: "recording",
        mediaType: "audio/ogg",
        name: "existing.ogg",
      },
    ],
  );

  let batchReads = 0;
  let singleReads = 0;
  const measured: AssetRepository = {
    ...assets,
    read(namespace, assetId) {
      singleReads += 1;
      return assets.read(namespace, assetId);
    },
    readMany(namespace, assetIds) {
      batchReads += 1;
      return assets.readMany(namespace, assetIds);
    },
  };
  const resolved = await createContentResolver({ assets: measured }).getMany(
    refs,
    { namespace: "tenant-a" },
  );
  assertEquals(batchReads, 1);
  assertEquals(singleReads, 0);
  assertEquals(resolved[0].text, "Hello");
  assertEquals(resolved[1].value, { query: "weather", units: "metric" });
  assertEquals(resolved[2].bytes, new Uint8Array([1, 2, 3, 4]));
  assertEquals(resolved[3].bytes, new Uint8Array([7, 8, 9]));
  assert(resolved.every((item) => item.asset.digest.startsWith("sha256:")));

  resolved[2].bytes[0] = 99;
  assertEquals(
    (await assets.read("tenant-a", refs[2].assetId)).bytes,
    new Uint8Array([1, 2, 3, 4]),
  );
});

Deno.test("asset publishing is immutable, idempotent, and tenant scoped", async () => {
  const { assets } = createFixture();
  const input = {
    namespace: "tenant-a",
    mediaType: "text/plain",
    body: new TextEncoder().encode("same body"),
    idempotencyKey: "operation-1",
  };
  const first = await assets.publish(input);
  const replay = await assets.publish(input);
  assertEquals(replay, first);

  const conflict = await assertRejects(() =>
    assets.publish({
      ...input,
      body: new TextEncoder().encode("different body"),
    })
  );
  assertEquals((conflict as ContentError).code, "asset_conflict");

  const otherTenant = await assets.publish({
    ...input,
    namespace: "tenant-b",
  });
  assert(otherTenant.id !== first.id);
  assertEquals(await assets.get("tenant-b", first.id), null);

  const deleted = await assets.markDeleted("tenant-a", first.id);
  assertEquals(deleted.state, "deleted");
  const deletionError = await assertRejects(() =>
    assets.read("tenant-a", first.id)
  );
  assertEquals((deletionError as ContentError).code, "asset_deleted");
});

Deno.test("normalization rejects cross-tenant, deleted, and mismatched refs", async () => {
  const { assets, normalize } = createFixture();
  const asset = await assets.publish({
    namespace: "tenant-a",
    mediaType: "text/plain",
    body: new TextEncoder().encode("private"),
  });
  const ref: ContentRef = {
    assetId: asset.id,
    kind: "text",
    role: "body",
    mediaType: "text/plain",
  };

  const tenantError = await assertRejects(() =>
    normalize.normalize(ref, { namespace: "tenant-b" })
  );
  assertEquals((tenantError as ContentError).code, "asset_not_found");

  const mismatchError = await assertRejects(() =>
    normalize.normalize({ ...ref, mediaType: "application/json" }, {
      namespace: "tenant-a",
    })
  );
  assertEquals((mismatchError as ContentError).code, "asset_conflict");

  await assets.markDeleted("tenant-a", asset.id);
  const deletedError = await assertRejects(() =>
    normalize.normalize(ref, { namespace: "tenant-a" })
  );
  assertEquals((deletedError as ContentError).code, "asset_deleted");
});

Deno.test("content resolution enforces authorization and body integrity", async () => {
  const { assets, normalize } = createFixture();
  const [ref] = await normalize.normalize("integrity", {
    namespace: "tenant-a",
  });

  const denied = createContentResolver({
    assets,
    authorize: () => false,
  });
  const authorizationError = await assertRejects(() =>
    denied.get(ref, { namespace: "tenant-a" })
  );
  assertEquals(
    (authorizationError as ContentError).code,
    "content_unauthorized",
  );

  const corrupted: AssetRepository = {
    ...assets,
    async read(namespace, assetId) {
      const body = await assets.read(namespace, assetId);
      body.bytes[0] ^= 0xFF;
      return body;
    },
    async readMany(namespace, assetIds) {
      const bodies = await assets.readMany(namespace, assetIds);
      return bodies.map((body, index) => ({
        ...body,
        bytes: index === 0 ? new Uint8Array([...body.bytes, 0]) : body.bytes,
      }));
    },
  };
  const resolver = createContentResolver({ assets: corrupted });
  const digestError = await assertRejects(() =>
    resolver.get(ref, { namespace: "tenant-a" })
  );
  assertEquals((digestError as ContentError).code, "asset_corrupted");
  const lengthError = await assertRejects(() =>
    resolver.getMany([ref], { namespace: "tenant-a" })
  );
  assertEquals((lengthError as ContentError).code, "asset_corrupted");
});

Deno.test("resolved content opens as a portable Web Stream", async () => {
  const { assets, normalize } = createFixture();
  const [ref] = await normalize.normalize({
    type: "audio",
    mediaType: "audio/pcm;rate=24000",
    bytes: new Uint8Array([1, 3, 5, 7]),
    role: "recording",
  }, { namespace: "tenant-a" });
  const stream = await createContentResolver({ assets }).open(ref, {
    namespace: "tenant-a",
  });
  assertEquals(await readStream(stream), new Uint8Array([1, 3, 5, 7]));
});

Deno.test("A55 canonical content core has no Deno, Node, Bun, filesystem, or server imports", async () => {
  const modules = [
    "digest.ts",
    "errors.ts",
    "index.ts",
    "normalizer.ts",
    "repository.ts",
    "resolver.ts",
    "types.ts",
  ];
  for (const module of modules) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\b/.test(source), `${module} imports or accesses Deno`);
    assert(!/\bBun\b/.test(source), `${module} imports or accesses Bun`);
    assert(!/\bprocess\b/.test(source), `${module} accesses process`);
    assert(!/from\s+["']node:/.test(source), `${module} imports node APIs`);
    assert(
      !/runtime\/cli|server\//.test(source),
      `${module} imports an adapter`,
    );
    assert(!/\bclass\s+\w+/.test(source), `${module} introduces a class`);
  }
});
