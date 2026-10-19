import { assertEquals, assertRejects } from "@std/assert";
import {
  createS3Fixture,
  s3TestConfig,
} from "../testing/s3-body-store.fixture.ts";
import { importS3BodyCopies } from "./s3-body-migration.ts";
import { createS3BodyStore } from "./s3-body-store.ts";
import { digestContent } from "./digest.ts";
import { readBodyBytes } from "./body-store.ts";
const bytes = (text: string) => new TextEncoder().encode(text);
for (const provider of ["s3", "gcs"] as const) {
  Deno.test(`offline ${provider} import preserves Ready and incomplete copies, source keys, and retry mapping`, async () => {
    const fixture = createS3Fixture(provider === "gcs"),
      config = { ...s3TestConfig, provider };
    const sourceBodyId = "old/ready+body%2F",
      payload = bytes("retained bytes"),
      digest = await digestContent(payload);
    fixture.objects.set(sourceBodyId, {
      bytes: payload,
      generation: 100,
      etag: '"old-ready"',
      metadata: {
        "content-type": "text/plain",
        "x-amz-meta-copilotz-sha256": digest,
      },
    });
    const incomplete = "old/incomplete",
      partKey = `${incomplete}.progressive/parts/g1/rid/one`,
      prefix = bytes("failed prefix"),
      prefixDigest = await digestContent(prefix);
    fixture.objects.set(partKey, {
      bytes: prefix,
      generation: 101,
      etag: '"old-part"',
    });
    fixture.objects.set(`${incomplete}.progressive/meta.json`, {
      bytes: bytes(
        JSON.stringify({
          state: "incomplete",
          mediaType: "text/plain",
          byteLength: prefix.length,
          discarded: 0,
          terminalDigest: prefixDigest,
          parts: [{ key: partKey, offset: 0, length: prefix.length }],
        }),
      ),
      generation: 102,
      etag: '"old-terminal"',
    });
    const copies = [{
      sourceBodyId,
      targetBodyId: "imported/ready",
      state: "ready" as const,
      mediaType: "text/plain",
      byteLength: payload.length,
      digest,
    }, {
      sourceBodyId: incomplete,
      targetBodyId: "imported/failed",
      state: "incomplete" as const,
      mediaType: "text/plain",
      byteLength: prefix.length,
      digest: prefixDigest,
    }];
    const imported = await importS3BodyCopies(
      config,
      { drained: true, copies },
      { fetch: fixture.fetch },
    );
    assertEquals(
      imported.map(
        (copy) => [copy.sourceBodyId, copy.targetBodyId, copy.head.state],
      ),
      [[sourceBodyId, "imported/ready", "ready"], [
        incomplete,
        "imported/failed",
        "incomplete",
      ]],
    );
    assertEquals(
      await importS3BodyCopies(config, { drained: true, copies }, {
        fetch: fixture.fetch,
      }),
      imported,
    );
    const store = createS3BodyStore(config, { fetch: fixture.fetch });
    assertEquals(
      await readBodyBytes(store, { bodyId: "imported/ready" }),
      payload,
    );
    assertEquals(
      await readBodyBytes(store, { bodyId: "imported/failed" }),
      prefix,
    );
    assertEquals(fixture.objects.get(sourceBodyId)?.bytes, payload);
    assertEquals(fixture.objects.get(partKey)?.bytes, prefix);
    assertEquals(
      fixture.requests.some((request) => request.method === "DELETE"),
      false,
    );
  });
}
Deno.test("offline S3 import refuses changed reviewed source, corrupt bytes, live staging and unsafe part keys", async () => {
  const fixture = createS3Fixture(),
    payload = bytes("actual"),
    digest = await digestContent(bytes("review")),
    sourceBodyId = "old/body";
  fixture.objects.set(sourceBodyId, {
    bytes: payload,
    generation: 100,
    etag: '"source"',
    metadata: {
      "content-type": "text/plain",
      "x-amz-meta-copilotz-sha256": digest,
    },
  });
  const copy = {
    sourceBodyId,
    targetBodyId: "imported/body",
    state: "ready" as const,
    mediaType: "text/plain",
    byteLength: payload.length,
    digest,
  };
  await assertRejects(() =>
    importS3BodyCopies(s3TestConfig, {
      drained: true,
      copies: [{ ...copy, sourceVersionToken: '"wrong"' }],
    }, { fetch: fixture.fetch })
  );
  await assertRejects(() =>
    importS3BodyCopies(s3TestConfig, { drained: true, copies: [copy] }, {
      fetch: fixture.fetch,
    })
  );
  assertEquals(
    (await createS3BodyStore(s3TestConfig, { fetch: fixture.fetch }).head({
      bodyId: copy.targetBodyId,
    }))?.state,
    "open",
  );
  for (
    const meta of [{ state: "open" }, {
      state: "incomplete",
      mediaType: "text/plain",
      byteLength: 6,
      discarded: 0,
      terminalDigest: digest,
      parts: [{ key: "unrelated/secret", offset: 0, length: 6 }],
    }]
  ) {
    fixture.objects.set("old/failure.progressive/meta.json", {
      bytes: bytes(JSON.stringify(meta)),
      generation: 101,
      etag: '"meta"',
    });
    await assertRejects(() =>
      importS3BodyCopies(s3TestConfig, {
        drained: true,
        copies: [{
          ...copy,
          sourceBodyId: "old/failure",
          targetBodyId: "imported/failure",
          state: "incomplete",
        }],
      }, { fetch: fixture.fetch })
    );
  }
});
