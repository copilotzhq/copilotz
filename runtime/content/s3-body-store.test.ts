import { assertEquals, assertRejects } from "@std/assert";

import { digestContent } from "./digest.ts";
import { readBodyBytes } from "./body-store.ts";
import { createS3BodyStore } from "./s3-body-store.ts";
import type { ContentError } from "./types.ts";

type StoredObject = {
  bytes: Uint8Array;
  mediaType: string;
  digest: string;
  maintenanceVersion: string;
  protectedUntil: string;
  modified: string;
};

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}

type GcsStoredObject = {
  bytes: Uint8Array;
  mediaType: string;
  digest: string;
  maintenanceVersion: string;
  protectedUntil: string;
  generation: string;
  metageneration: string;
  etag: string;
  modified: string;
};

function gcsError(status: number, code: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
    { status, headers: { "content-type": "application/xml" } },
  );
}

function createMockGcs(
  options: Readonly<{
    omitMetageneration?: boolean;
    omitEtag?: boolean;
  }> = {},
) {
  const objects = new Map<string, GcsStoredObject>();
  const copyHeaders: Headers[] = [];
  let nextGeneration = 100;
  let deleteRequests = 0;
  const requestGates: Array<{
    method: string;
    pathIncludes: string;
    arrived: ReturnType<typeof deferred>;
    released: ReturnType<typeof deferred>;
  }> = [];
  let failedDeletePath: string | undefined;
  let partGetGate:
    | {
      expected: number;
      active: number;
      maximum: number;
      arrived: ReturnType<typeof deferred>;
      released: ReturnType<typeof deferred>;
    }
    | undefined;
  let pendingDeleteGate:
    | Readonly<{
      arrived: ReturnType<typeof deferred>;
      released: ReturnType<typeof deferred>;
    }>
    | undefined;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    async (request) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname).replace(
        /^\/bucket\/?/,
        "",
      );
      const requestTarget = `${path}${url.search}`;
      const requestGateIndex = requestGates.findIndex((gate) =>
        gate.method === request.method &&
        requestTarget.includes(gate.pathIncludes)
      );
      if (requestGateIndex >= 0) {
        const [gate] = requestGates.splice(requestGateIndex, 1);
        gate.arrived.resolve();
        await gate.released.promise;
      }
      if (
        request.method === "GET" && path.includes(".progressive/parts/") &&
        partGetGate
      ) {
        const gate = partGetGate;
        gate.active++;
        gate.maximum = Math.max(gate.maximum, gate.active);
        if (gate.active >= gate.expected) gate.arrived.resolve();
        await gate.released.promise;
        gate.active--;
      }
      if (
        request.method === "GET" && url.searchParams.get("list-type") === "2"
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
      if (request.method === "HEAD") {
        const existing = objects.get(path);
        if (!existing) return gcsError(404, "NoSuchKey");
        return new Response(null, {
          headers: {
            "content-length": String(existing.bytes.byteLength),
            "content-type": existing.mediaType,
            ...(options.omitEtag ? {} : { "etag": existing.etag }),
            "last-modified": existing.modified,
            "x-goog-generation": existing.generation,
            ...(options.omitMetageneration
              ? {}
              : { "x-goog-metageneration": existing.metageneration }),
            "x-goog-meta-copilotz-sha256": existing.digest.slice(
              "sha256:".length,
            ),
            "x-goog-meta-copilotz-media-type": existing.mediaType,
            "x-goog-meta-copilotz-maintenance-version":
              existing.maintenanceVersion,
            "x-goog-meta-copilotz-protected-until": existing.protectedUntil,
            "x-amz-meta-copilotz-sha256": existing.digest.slice(
              "sha256:".length,
            ),
            "x-amz-meta-copilotz-media-type": existing.mediaType,
            "x-amz-meta-copilotz-maintenance-version":
              existing.maintenanceVersion,
            "x-amz-meta-copilotz-protected-until": existing.protectedUntil,
          },
        });
      }
      if (request.method === "PUT") {
        const existing = objects.get(path);
        const copySource = request.headers.get("x-goog-copy-source");
        if (copySource) {
          if (!existing) return gcsError(404, "NoSuchKey");
          copyHeaders.push(new Headers(request.headers));
          const sourceMatches =
            request.headers.get("x-goog-copy-source-generation") ===
              existing.generation &&
            request.headers.get("x-goog-copy-source-if-generation-match") ===
              existing.generation &&
            request.headers.get(
                "x-goog-copy-source-if-metageneration-match",
              ) === existing.metageneration;
          const destinationMatches =
            request.headers.get("x-goog-if-generation-match") ===
              existing.generation &&
            request.headers.get("x-goog-if-metageneration-match") ===
              existing.metageneration;
          if (
            !sourceMatches || !destinationMatches ||
            request.headers.get("x-goog-metadata-directive") !== "REPLACE"
          ) {
            return gcsError(412, "PreconditionFailed");
          }
          const metageneration = String(Number(existing.metageneration) + 1);
          const updated: GcsStoredObject = {
            ...existing,
            mediaType: request.headers.get("content-type") ??
              existing.mediaType,
            digest: `sha256:${
              request.headers.get("x-goog-meta-copilotz-sha256")
            }`,
            maintenanceVersion: request.headers.get(
              "x-goog-meta-copilotz-maintenance-version",
            ) ?? "",
            protectedUntil:
              request.headers.get("x-goog-meta-copilotz-protected-until") ??
                "",
            metageneration,
            modified: new Date(
              Date.parse(existing.modified) + 1_000,
            ).toUTCString(),
          };
          objects.set(path, updated);
          return new Response(
            `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>${updated.modified}</LastModified><ETag>${updated.etag}</ETag></CopyObjectResult>`,
            {
              status: 200,
              headers: {
                "content-type": "application/xml",
                "etag": updated.etag,
                "x-goog-generation": updated.generation,
                "x-goog-metageneration": updated.metageneration,
              },
            },
          );
        }
        const generationMatch = request.headers.get(
          "x-goog-if-generation-match",
        );
        const metagenerationMatch = request.headers.get(
          "x-goog-if-metageneration-match",
        );
        const ifNoneMatch = request.headers.get("if-none-match");
        const ifMatch = request.headers.get("if-match");
        if (
          existing &&
          (generationMatch === "0" || ifNoneMatch === "*")
        ) {
          return gcsError(412, "PreconditionFailed");
        }
        if (
          generationMatch !== null && generationMatch !== "0" &&
          (!existing || generationMatch !== existing.generation ||
            metagenerationMatch !== existing.metageneration)
        ) {
          return gcsError(412, "PreconditionFailed");
        }
        if (ifMatch !== null && (!existing || ifMatch !== existing.etag)) {
          return gcsError(412, "PreconditionFailed");
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        const generation = String(nextGeneration++);
        const created: GcsStoredObject = {
          bytes,
          mediaType: request.headers.get("content-type") ??
            "application/octet-stream",
          digest: `sha256:${
            request.headers.get("x-goog-meta-copilotz-sha256") ??
              request.headers.get("x-amz-meta-copilotz-sha256")
          }`,
          maintenanceVersion: request.headers.get(
            "x-goog-meta-copilotz-maintenance-version",
          ) ?? request.headers.get(
            "x-amz-meta-copilotz-maintenance-version",
          ) ?? "",
          protectedUntil:
            request.headers.get("x-goog-meta-copilotz-protected-until") ??
              request.headers.get("x-amz-meta-copilotz-protected-until") ?? "",
          generation,
          metageneration: "1",
          etag: `"object-${generation}"`,
          modified: "Wed, 01 Jan 2020 00:00:00 GMT",
        };
        objects.set(path, created);
        return new Response(null, {
          status: 200,
          headers: {
            "etag": created.etag,
            "last-modified": created.modified,
            "x-goog-generation": created.generation,
            "x-goog-metageneration": created.metageneration,
          },
        });
      }
      if (request.method === "GET") {
        const existing = objects.get(path);
        return existing
          ? new Response(existing.bytes.slice().buffer, {
            headers: {
              "content-length": String(existing.bytes.byteLength),
              "content-type": existing.mediaType,
              ...(options.omitEtag ? {} : { "etag": existing.etag }),
              "last-modified": existing.modified,
              "x-goog-generation": existing.generation,
              ...(options.omitMetageneration
                ? {}
                : { "x-goog-metageneration": existing.metageneration }),
            },
          })
          : gcsError(404, "NoSuchKey");
      }
      if (request.method === "DELETE") {
        deleteRequests++;
        const gate = pendingDeleteGate;
        pendingDeleteGate = undefined;
        if (gate) {
          gate.arrived.resolve();
          await gate.released.promise;
        }
        if (failedDeletePath && path.includes(failedDeletePath)) {
          failedDeletePath = undefined;
          return gcsError(503, "ServiceUnavailable");
        }
        const current = objects.get(path);
        if (!current) return gcsError(404, "NoSuchKey");
        const generationMatch = request.headers.get(
          "x-goog-if-generation-match",
        );
        const metagenerationMatch = request.headers.get(
          "x-goog-if-metageneration-match",
        );
        const ifMatch = request.headers.get("if-match");
        if (
          (generationMatch !== null || metagenerationMatch !== null) &&
          (generationMatch !== current.generation ||
            metagenerationMatch !== current.metageneration)
        ) {
          return gcsError(412, "PreconditionFailed");
        }
        if (ifMatch !== null && ifMatch !== current.etag) {
          return gcsError(412, "PreconditionFailed");
        }
        objects.delete(path);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  );
  const address = server.addr as Deno.NetAddr;
  return Object.freeze({
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    copyHeaders,
    get deleteRequests() {
      return deleteRequests;
    },
    blockNextRequest(method: string, pathIncludes: string) {
      const arrived = deferred();
      const released = deferred();
      requestGates.push({ method, pathIncludes, arrived, released });
      return Object.freeze({
        arrived: arrived.promise,
        release: released.resolve,
      });
    },
    blockPartGets(expected: number) {
      const arrived = deferred();
      const released = deferred();
      const gate = {
        expected,
        active: 0,
        maximum: 0,
        arrived,
        released,
      };
      partGetGate = gate;
      return Object.freeze({
        arrived: arrived.promise,
        release: released.resolve,
        maximum: () => gate.maximum,
        clear: () => {
          partGetGate = undefined;
        },
      });
    },
    failNextDelete(pathIncludes: string) {
      failedDeletePath = pathIncludes;
    },
    blockNextDelete() {
      const arrived = deferred();
      const released = deferred();
      pendingDeleteGate = Object.freeze({ arrived, released });
      return Object.freeze({
        arrived: arrived.promise,
        release: released.resolve,
      });
    },
    shutdown: () => server.shutdown(),
  });
}

function createGcsStore(endpoint: string, protectionMs = 0) {
  return createS3BodyStore({
    backendId: "gcs:test",
    endpoint,
    region: "auto",
    bucket: "bucket",
    accessKeyId: "access",
    secretAccessKey: "secret",
    pathStyle: true,
    protectionMs,
    provider: "gcs",
  });
}

function createS3CasStore(endpoint: string) {
  return createS3BodyStore({
    backendId: "s3:cas-test",
    endpoint,
    region: "us-east-1",
    bucket: "bucket",
    accessKeyId: "access",
    secretAccessKey: "secret",
    pathStyle: true,
    protectionMs: 0,
  });
}

Deno.test("S3 BodyStore reuses immutable objects and disables unsafe Ready GC", async () => {
  const objects = new Map<string, StoredObject>();
  let headRequests = 0;
  let putRequests = 0;
  let deleteRequests = 0;
  const putPayloadDigests: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    async (request) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname).replace(/^\/bucket\/?/, "");
      if (
        request.method === "GET" && url.searchParams.get("list-type") === "2"
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
      const existing = objects.get(path);
      if (request.method === "HEAD") {
        headRequests++;
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
            "x-amz-meta-copilotz-maintenance-version":
              existing.maintenanceVersion,
            "x-amz-meta-copilotz-protected-until": existing.protectedUntil,
          },
        });
      }
      if (request.method === "PUT") {
        putRequests++;
        putPayloadDigests.push(
          request.headers.get("x-amz-content-sha256") ?? "",
        );
        if (existing && request.headers.get("if-none-match") === "*") {
          return new Response(null, { status: 412 });
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        const stored = {
          bytes,
          mediaType: request.headers.get("content-type") ??
            "application/octet-stream",
          digest: `sha256:${request.headers.get("x-amz-meta-copilotz-sha256")}`,
          maintenanceVersion:
            request.headers.get("x-amz-meta-copilotz-maintenance-version") ??
              "1",
          protectedUntil:
            request.headers.get("x-amz-meta-copilotz-protected-until") ?? "",
          modified: new Date().toUTCString(),
        };
        objects.set(path, stored);
        return new Response(null, {
          status: 200,
          headers: {
            etag: '"etag"',
            "last-modified": stored.modified,
          },
        });
      }
      if (request.method === "GET") {
        return existing
          ? new Response(
            existing.bytes.buffer.slice(
              existing.bytes.byteOffset,
              existing.bytes.byteOffset + existing.bytes.byteLength,
            ) as ArrayBuffer,
            {
              headers: { "content-type": existing.mediaType },
            },
          )
          : new Response(null, { status: 404 });
      }
      if (request.method === "DELETE") {
        deleteRequests++;
        objects.delete(path);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  );
  try {
    const address = server.addr as Deno.NetAddr;
    const store = createS3BodyStore({
      backendId: "s3:test",
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "us-east-1",
      bucket: "bucket",
      accessKeyId: "access",
      secretAccessKey: "secret",
      pathStyle: true,
      protectionMs: 0,
    });
    const bytes = new TextEncoder().encode("hello s3");
    const input = {
      bodyId: "copilotz/schemas/test/assets/a",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
      ifAbsent: true,
    } as const;
    const first = await store.put(input);
    assertEquals(first.byteLength, bytes.byteLength);
    assertEquals({ putRequests, headRequests }, {
      putRequests: 1,
      headRequests: 0,
    });
    assertEquals(
      putPayloadDigests[0],
      input.digest.slice("sha256:".length),
    );
    assertEquals(await store.put(input), first);
    assertEquals({ putRequests, headRequests }, {
      putRequests: 2,
      headRequests: 1,
    });
    assertEquals(await readBodyBytes(store, { bodyId: input.bodyId }), bytes);
    assertEquals(
      await new Response(await store.read({ bodyId: input.bodyId })).text(),
      "hello s3",
    );
    await store.put({ ...input, bodyId: "aaa/unrelated" });
    const listed = await store.maintenance.list({
      states: ["ready"],
      idleForMs: 0,
      prefix: "copilotz/schemas/test/",
      limit: 1,
    });
    assertEquals(listed.bodies.map((item) => item.bodyId), [input.bodyId]);
    const conflict = await assertRejects(() =>
      store.put({
        ...input,
        bytes: new TextEncoder().encode("different"),
        digest:
          "sha256:9d6f965ac832e40a5df6c06afe983e3b4a6fba16c4baadd5f38b359904f9e39c",
      })
    );
    assertEquals((conflict as ContentError).code, "asset_conflict");
    assertEquals(
      await store.maintenance.delete({
        bodyId: input.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: first.maintenanceVersion,
        idleForMs: 0,
      }),
      false,
    );
    assertEquals(deleteRequests, 0);
    assertEquals(
      (await store.head({ bodyId: input.bodyId }))?.bodyId,
      input.bodyId,
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("GCS BodyStore atomically renews and deletes the exact Ready version", async () => {
  const gcs = createMockGcs();
  try {
    const store = createGcsStore(gcs.endpoint);
    const bytes = new TextEncoder().encode("gcs ready cas");
    const input = {
      bodyId: "copilotz/schemas/test/assets/gcs-cas",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
      ifAbsent: true,
      protectedUntil: "2000-01-01T00:00:00.000Z",
    } as const;
    const created = await store.put(input);
    assertEquals(created.maintenanceVersion, 1);

    const renewed = await store.put(input);
    assertEquals(renewed.maintenanceVersion, 2);
    assertEquals(renewed.protectedUntil, input.protectedUntil);
    assertEquals(gcs.copyHeaders.length, 1);
    assertEquals(
      gcs.copyHeaders[0].get("x-goog-copy-source-if-generation-match"),
      "100",
    );
    assertEquals(
      gcs.copyHeaders[0].get("x-goog-copy-source-if-metageneration-match"),
      "1",
    );
    assertEquals(
      gcs.copyHeaders[0].get("x-goog-if-metageneration-match"),
      "1",
    );

    assertEquals(
      await store.maintenance.delete({
        bodyId: input.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: created.maintenanceVersion,
        idleForMs: 0,
      }),
      false,
    );
    assertEquals(gcs.deleteRequests, 0);
    assertEquals(
      await store.maintenance.delete({
        bodyId: input.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: renewed.maintenanceVersion,
        idleForMs: 0,
      }),
      true,
    );
    assertEquals(gcs.deleteRequests, 1);
    assertEquals(await store.head({ bodyId: input.bodyId }), null);

    // Absence is an idempotent false result and never becomes an unconditional
    // DELETE request.
    assertEquals(
      await store.maintenance.delete({
        bodyId: input.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: renewed.maintenanceVersion,
        idleForMs: 0,
      }),
      false,
    );
    assertEquals(gcs.deleteRequests, 1);
  } finally {
    await gcs.shutdown();
  }
});

Deno.test("GCS Ready renewal makes an in-flight stale delete fail closed", async () => {
  const gcs = createMockGcs();
  try {
    const store = createGcsStore(gcs.endpoint);
    const bytes = new TextEncoder().encode("renew wins stale delete");
    const input = {
      bodyId: "copilotz/schemas/test/assets/gcs-race",
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
      protectedUntil: "2000-01-01T00:00:00.000Z",
    } as const;
    const stale = await store.put(input);
    const gate = gcs.blockNextDelete();
    const deletion = store.maintenance.delete({
      bodyId: input.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: stale.maintenanceVersion,
      idleForMs: 0,
    });
    await gate.arrived;

    const renewed = await store.put(input);
    assertEquals(renewed.maintenanceVersion, 2);
    // The content ETag intentionally remains identical in this mock. The GCS
    // metageneration is what fences the already-issued delete.
    gate.release();
    assertEquals(await deletion, false);
    assertEquals(
      (await store.head({ bodyId: input.bodyId }))?.maintenanceVersion,
      2,
    );
  } finally {
    await gcs.shutdown();
  }
});

Deno.test("GCS Ready deletion refuses a missing metageneration guard", async () => {
  const gcs = createMockGcs({ omitMetageneration: true });
  try {
    const bodyId = "copilotz/schemas/test/assets/gcs-missing-guard";
    const bytes = new TextEncoder().encode("guard required");
    gcs.objects.set(bodyId, {
      bytes,
      mediaType: "text/plain",
      digest: await digestContent(bytes),
      maintenanceVersion: "1",
      protectedUntil: "2000-01-01T00:00:00.000Z",
      generation: "777",
      metageneration: "4",
      etag: '"object-777"',
      modified: "Wed, 01 Jan 2020 00:00:00 GMT",
    });
    const store = createGcsStore(gcs.endpoint);
    assertEquals(
      await store.maintenance.delete({
        bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: 1,
        idleForMs: 0,
      }),
      false,
    );
    assertEquals(gcs.deleteRequests, 0);
    assertEquals((await store.head({ bodyId }))?.bodyId, bodyId);
  } finally {
    await gcs.shutdown();
  }
});

Deno.test("S3 progressive staging uses strong ETag CAS and fails closed without it", async () => {
  const s3 = createMockGcs();
  try {
    const store = createS3CasStore(s3.endpoint);
    const bodyId = "copilotz/schemas/test/assets/s3-progressive-cas";
    const bytes = new TextEncoder().encode("etag fenced staging");
    const writer = await store.reserve({ bodyId, mediaType: "text/plain" });
    await store.append({
      writer,
      expectedOffset: 0,
      appendId: "one",
      bytes,
    });
    const ready = await store.seal({
      writer,
      expectedByteLength: bytes.byteLength,
      expectedDigest: await digestContent(bytes),
    });
    assertEquals(ready.state, "ready");
    assertEquals(await readBodyBytes(store, { bodyId }), bytes);
  } finally {
    await s3.shutdown();
  }

  const unsupported = createMockGcs({ omitEtag: true });
  try {
    const store = createS3CasStore(unsupported.endpoint);
    const error = await assertRejects(() =>
      store.reserve({
        bodyId: "copilotz/schemas/test/assets/s3-no-cas",
        mediaType: "text/plain",
      })
    );
    assertEquals(
      (error as ContentError).code,
      "asset_storage_unavailable",
    );
  } finally {
    await unsupported.shutdown();
  }
});

Deno.test("GCS progressive seal freezes isolated parts and reads them in bounded order", async () => {
  const gcs = createMockGcs();
  try {
    const store = createGcsStore(gcs.endpoint, 60_000);
    const bodyId = "copilotz/schemas/test/assets/progressive-bounded";
    let writer = await store.reserve({ bodyId, mediaType: "text/plain" });
    const chunks = Array.from(
      { length: 12 },
      (_, index) => new TextEncoder().encode(`[${index}]`),
    );
    let offset = 0;
    for (const [index, bytes] of chunks.entries()) {
      const appended = await store.append({
        writer,
        expectedOffset: offset,
        appendId: `append-${index}`,
        bytes,
      });
      offset = appended.endOffset;
      writer = Object.freeze({ ...writer, byteLength: offset });
    }
    const partKeys = [...gcs.objects.keys()].filter((key) =>
      key.includes(".progressive/parts/")
    );
    assertEquals(partKeys.length, chunks.length);
    assertEquals(new Set(partKeys).size, chunks.length);
    assertEquals(
      partKeys.every((key) =>
        key.includes(`/g${writer.generation}/r${writer.reservationId}/`)
      ),
      true,
    );

    const expected = new TextEncoder().encode(
      chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""),
    );
    const gate = gcs.blockPartGets(8);
    const sealing = store.seal({
      writer,
      expectedByteLength: expected.byteLength,
      expectedDigest: await digestContent(expected),
    });
    await gate.arrived;
    assertEquals(gate.maximum(), 8);
    assertEquals((await store.head({ bodyId }))?.state, "sealing");
    const appendError = await assertRejects(() =>
      store.append({
        writer,
        expectedOffset: expected.byteLength,
        appendId: "too-late",
        bytes: new TextEncoder().encode("late"),
      })
    );
    assertEquals((appendError as ContentError).code, "asset_conflict");
    const abortError = await assertRejects(() => store.abort({ writer }));
    assertEquals((abortError as ContentError).code, "asset_conflict");
    const takeoverError = await assertRejects(() =>
      store.reserve({
        bodyId,
        mediaType: writer.mediaType,
        expectedGeneration: writer.generation,
      })
    );
    assertEquals((takeoverError as ContentError).code, "asset_conflict");
    gate.clear();
    gate.release();

    const ready = await sealing;
    assertEquals(ready.byteLength, expected.byteLength);
    assertEquals(await readBodyBytes(store, { bodyId }), expected);
    assertEquals(
      [...gcs.objects.keys()].filter((key) =>
        key.startsWith(`${bodyId}.progressive/`)
      ),
      [],
    );
  } finally {
    await gcs.shutdown();
  }
});

Deno.test("GCS expired sealing takeover preserves and finalizes the frozen parts", async () => {
  const gcs = createMockGcs();
  try {
    const store = createGcsStore(gcs.endpoint);
    const bodyId = "copilotz/schemas/test/assets/sealing-recovery";
    const bytes = new TextEncoder().encode("frozen across recovery");
    const staleWriter = await store.reserve({
      bodyId,
      mediaType: "text/plain",
    });
    await store.append({
      writer: staleWriter,
      expectedOffset: 0,
      appendId: "frozen-part",
      bytes,
    });

    const readGate = gcs.blockPartGets(1);
    const staleSeal = store.seal({
      writer: staleWriter,
      expectedByteLength: bytes.byteLength,
      expectedDigest: await digestContent(bytes),
    });
    await readGate.arrived;
    const frozen = await store.head({ bodyId });
    assertEquals(frozen?.state, "sealing");
    const recovered = await store.reserve({
      bodyId,
      mediaType: staleWriter.mediaType,
      expectedGeneration: staleWriter.generation,
    });
    assertEquals(recovered.generation, staleWriter.generation + 1);
    assertEquals(recovered.byteLength, bytes.byteLength);
    const recoveredHead = await store.head({ bodyId });
    assertEquals(recoveredHead?.state, "sealing");

    readGate.clear();
    readGate.release();
    const staleError = await assertRejects(() => staleSeal);
    assertEquals((staleError as ContentError).code, "asset_conflict");
    const ready = await store.seal({
      writer: recovered,
      expectedByteLength: bytes.byteLength,
      expectedDigest: await digestContent(bytes),
    });
    assertEquals(ready.state, "ready");
    assertEquals(await readBodyBytes(store, { bodyId }), bytes);
  } finally {
    await gcs.shutdown();
  }
});

Deno.test("GCS progressive metadata CAS fences stale takeover, append, abort, and seal", async () => {
  const gcs = createMockGcs();
  try {
    const store = createGcsStore(gcs.endpoint);

    const takeoverBody = "copilotz/schemas/test/assets/takeover-race";
    const takeoverOriginal = await store.reserve({
      bodyId: takeoverBody,
      mediaType: "text/plain",
    });
    const takeoverGate = gcs.blockNextRequest(
      "PUT",
      ".progressive/meta.json",
    );
    const staleTakeover = store.reserve({
      bodyId: takeoverBody,
      mediaType: "text/plain",
      expectedGeneration: takeoverOriginal.generation,
    });
    await takeoverGate.arrived;
    const takeoverWinner = await store.reserve({
      bodyId: takeoverBody,
      mediaType: "text/plain",
      expectedGeneration: takeoverOriginal.generation,
    });
    takeoverGate.release();
    const staleTakeoverError = await assertRejects(() => staleTakeover);
    assertEquals(
      (staleTakeoverError as ContentError).code,
      "asset_conflict",
    );
    const takeoverHead = await store.head({ bodyId: takeoverBody });
    assertEquals(
      takeoverHead && takeoverHead.state !== "ready"
        ? takeoverHead.reservationId
        : undefined,
      takeoverWinner.reservationId,
    );

    const appendBody = "copilotz/schemas/test/assets/append-race";
    const staleAppender = await store.reserve({
      bodyId: appendBody,
      mediaType: "text/plain",
    });
    const appendGate = gcs.blockNextRequest(
      "PUT",
      ".progressive/parts/",
    );
    const staleAppend = store.append({
      writer: staleAppender,
      expectedOffset: 0,
      appendId: "stale-append",
      bytes: new TextEncoder().encode("stale"),
    });
    await appendGate.arrived;
    const appendWinner = await store.reserve({
      bodyId: appendBody,
      mediaType: "text/plain",
      expectedGeneration: staleAppender.generation,
    });
    const appendWinnerBytes = new TextEncoder().encode("winner");
    await store.append({
      writer: appendWinner,
      expectedOffset: 0,
      appendId: "winner-append",
      bytes: appendWinnerBytes,
    });
    appendGate.release();
    const staleAppendError = await assertRejects(() => staleAppend);
    assertEquals((staleAppendError as ContentError).code, "asset_conflict");
    const appendHead = await store.head({ bodyId: appendBody });
    assertEquals(
      appendHead && appendHead.state !== "ready"
        ? appendHead.reservationId
        : undefined,
      appendWinner.reservationId,
    );
    assertEquals(appendHead?.byteLength, appendWinnerBytes.byteLength);
    assertEquals(
      await store.readRange!({
        bodyId: appendBody,
        offset: 0,
        end: appendWinnerBytes.byteLength,
      }),
      appendWinnerBytes,
    );
    assertEquals(
      [...gcs.objects.keys()].some((key) =>
        key.includes(`/r${staleAppender.reservationId}/`)
      ),
      false,
    );

    const abortBody = "copilotz/schemas/test/assets/abort-race";
    const staleAborter = await store.reserve({
      bodyId: abortBody,
      mediaType: "text/plain",
    });
    const abortGate = gcs.blockNextRequest("PUT", ".progressive/meta.json");
    const staleAbort = store.abort({ writer: staleAborter });
    await abortGate.arrived;
    const abortWinner = await store.reserve({
      bodyId: abortBody,
      mediaType: "text/plain",
      expectedGeneration: staleAborter.generation,
    });
    const abortWinnerBytes = new TextEncoder().encode("keep");
    await store.append({
      writer: abortWinner,
      expectedOffset: 0,
      appendId: "keep-after-takeover",
      bytes: abortWinnerBytes,
    });
    abortGate.release();
    const staleAbortError = await assertRejects(() => staleAbort);
    assertEquals((staleAbortError as ContentError).code, "asset_conflict");
    const abortHead = await store.head({ bodyId: abortBody });
    assertEquals(
      abortHead && abortHead.state !== "ready"
        ? abortHead.reservationId
        : undefined,
      abortWinner.reservationId,
    );
    assertEquals(abortHead?.byteLength, abortWinnerBytes.byteLength);

    const sealBody = "copilotz/schemas/test/assets/seal-race";
    const staleSealer = await store.reserve({
      bodyId: sealBody,
      mediaType: "text/plain",
    });
    const sealGate = gcs.blockNextRequest("PUT", ".progressive/meta.json");
    const staleSeal = store.seal({
      writer: staleSealer,
      expectedByteLength: 0,
      expectedDigest: await digestContent(new Uint8Array()),
    });
    await sealGate.arrived;
    const sealWinner = await store.reserve({
      bodyId: sealBody,
      mediaType: "text/plain",
      expectedGeneration: staleSealer.generation,
    });
    const sealWinnerBytes = new TextEncoder().encode("new seal data");
    await store.append({
      writer: sealWinner,
      expectedOffset: 0,
      appendId: "new-seal-data",
      bytes: sealWinnerBytes,
    });
    sealGate.release();
    const staleSealError = await assertRejects(() => staleSeal);
    assertEquals((staleSealError as ContentError).code, "asset_conflict");
    const sealHead = await store.head({ bodyId: sealBody });
    assertEquals(
      sealHead && sealHead.state !== "ready"
        ? sealHead.reservationId
        : undefined,
      sealWinner.reservationId,
    );
    assertEquals(sealHead?.byteLength, sealWinnerBytes.byteLength);
  } finally {
    await gcs.shutdown();
  }
});

Deno.test("GCS progressive abort and seal cleanup resume safely after interruption", async () => {
  const gcs = createMockGcs();
  try {
    const store = createGcsStore(gcs.endpoint);
    const abortBody = "copilotz/schemas/test/assets/abort-retry";
    const abortWriter = await store.reserve({
      bodyId: abortBody,
      mediaType: "text/plain",
    });
    await store.append({
      writer: abortWriter,
      expectedOffset: 0,
      appendId: "abort-part",
      bytes: new TextEncoder().encode("discard"),
    });
    gcs.failNextDelete(".progressive/parts/");
    await assertRejects(() => store.abort({ writer: abortWriter }));
    assertEquals((await store.head({ bodyId: abortBody }))?.state, "aborted");
    await store.abort({ writer: abortWriter });
    assertEquals(await store.head({ bodyId: abortBody }), null);

    const sealBody = "copilotz/schemas/test/assets/seal-retry";
    const bytes = new TextEncoder().encode("publish before cleanup");
    const sealWriter = await store.reserve({
      bodyId: sealBody,
      mediaType: "text/plain",
    });
    await store.append({
      writer: sealWriter,
      expectedOffset: 0,
      appendId: "seal-part",
      bytes,
    });
    const sealDigest = await digestContent(bytes);
    gcs.failNextDelete(".progressive/parts/");
    await assertRejects(() =>
      store.seal({
        writer: sealWriter,
        expectedByteLength: bytes.byteLength,
        expectedDigest: sealDigest,
      })
    );
    assertEquals((await store.head({ bodyId: sealBody }))?.state, "ready");
    const recoveredSealWriter = await store.reserve({
      bodyId: sealBody,
      mediaType: sealWriter.mediaType,
      expectedGeneration: sealWriter.generation,
    });
    const retried = await store.seal({
      writer: recoveredSealWriter,
      expectedByteLength: bytes.byteLength,
      expectedDigest: sealDigest,
    });
    assertEquals(retried.state, "ready");
    assertEquals(await readBodyBytes(store, { bodyId: sealBody }), bytes);
    assertEquals(
      [...gcs.objects.keys()].filter((key) =>
        key.startsWith(`${sealBody}.progressive/`)
      ),
      [],
    );
  } finally {
    await gcs.shutdown();
  }
});

Deno.test("GCS stale cleanup cannot delete a newly reserved writer's parts", async () => {
  const gcs = createMockGcs();
  try {
    const store = createGcsStore(gcs.endpoint);
    const bodyId = "copilotz/schemas/test/assets/stale-cleanup";
    const staleWriter = await store.reserve({
      bodyId,
      mediaType: "text/plain",
    });
    await store.append({
      writer: staleWriter,
      expectedOffset: 0,
      appendId: "stale-part",
      bytes: new TextEncoder().encode("old"),
    });

    const staleList = gcs.blockNextRequest("GET", "list-type=2");
    const staleCleanup = store.abort({ writer: staleWriter });
    await staleList.arrived;
    await store.abort({ writer: staleWriter });

    const currentWriter = await store.reserve({
      bodyId,
      mediaType: "text/plain",
    });
    const currentBytes = new TextEncoder().encode("current");
    await store.append({
      writer: currentWriter,
      expectedOffset: 0,
      appendId: "current-part",
      bytes: currentBytes,
    });
    staleList.release();
    const staleError = await assertRejects(() => staleCleanup);
    assertEquals((staleError as ContentError).code, "asset_conflict");
    assertEquals(
      await store.readRange!({
        bodyId,
        offset: 0,
        end: currentBytes.byteLength,
      }),
      currentBytes,
    );
  } finally {
    await gcs.shutdown();
  }
});

Deno.test("GCS maintenance collects late orphan parts without touching active staging", async () => {
  const gcs = createMockGcs();
  try {
    const store = createGcsStore(gcs.endpoint);
    const bodyId = "copilotz/schemas/test/assets/orphan-maintenance";
    const writer = await store.reserve({ bodyId, mediaType: "text/plain" });
    const currentBytes = new TextEncoder().encode("protected");
    await store.append({
      writer,
      expectedOffset: 0,
      appendId: "protected-part",
      bytes: currentBytes,
    });
    const orphanKey = `${bodyId}.progressive/parts/g0/rstale/00000000-orphan`;
    gcs.objects.set(orphanKey, {
      bytes: new TextEncoder().encode("orphan"),
      mediaType: "application/octet-stream",
      digest: "sha256:null",
      maintenanceVersion: "",
      protectedUntil: "",
      generation: "9999",
      metageneration: "1",
      etag: '"object-9999"',
      modified: "Wed, 01 Jan 2020 00:00:00 GMT",
    });

    const page = await store.maintenance.list({
      states: ["aborted"],
      idleForMs: 0,
      prefix: bodyId,
      limit: 10,
    });
    assertEquals(
      page.bodies.map((body) => ({
        bodyId: body.bodyId,
        state: body.state,
        maintenanceVersion: body.maintenanceVersion,
      })),
      [{ bodyId, state: "aborted", maintenanceVersion: 1 }],
    );
    assertEquals(
      await store.maintenance.delete({
        bodyId,
        expectedState: "aborted",
        expectedMaintenanceVersion: 1,
        idleForMs: 0,
      }),
      true,
    );
    assertEquals(gcs.objects.has(orphanKey), false);
    assertEquals(
      await store.readRange!({
        bodyId,
        offset: 0,
        end: currentBytes.byteLength,
      }),
      currentBytes,
    );
  } finally {
    await gcs.shutdown();
  }
});
