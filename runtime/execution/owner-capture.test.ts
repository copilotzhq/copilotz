import { assert, assertEquals, assertRejects } from "@std/assert";
import { digestContent } from "../content/digest.ts";
import {
  CAPTURE_CHUNK_BYTES,
  type CapturePort,
  captureWorkerContent,
} from "./owner-capture.ts";
import {
  encodeCapability,
  OWNER_CAPABILITY_BYTES,
} from "./owner-capability-wire.ts";

function fixture() {
  const abort = new AbortController();
  const opens: Record<string, unknown>[] = [];
  const uploads: Uint8Array[][] = [];
  const closeInputs: Record<string, unknown>[] = [];
  const appendIds: string[][] = [];
  const references: unknown[] = [];
  let aborts = 0;
  const bounded = (value: unknown) =>
    assert(encodeCapability(value).byteLength <= OWNER_CAPABILITY_BYTES);
  const port: CapturePort = {
    namespace: "test",
    signal: abort.signal,
    open(input) {
      bounded(input);
      opens.push(input);
      const chunks: Uint8Array[] = [];
      uploads.push(chunks);
      const ids: string[] = [];
      appendIds.push(ids);
      return Promise.resolve({
        append(input) {
          bounded(input);
          chunks.push(input.bytes);
          ids.push(input.appendId);
          return Promise.resolve({});
        },
        close(input) {
          bounded(input);
          closeInputs.push(input);
          return Promise.resolve({
            type: "content.pending",
            pendingRef: String(opens.length),
          });
        },
        abort() {
          aborts++;
          return Promise.resolve();
        },
      });
    },
    reference(input, options) {
      bounded({ input, options });
      references.push(input);
      return Promise.resolve([input]);
    },
  };
  return {
    port,
    abort,
    opens,
    uploads,
    closeInputs,
    appendIds,
    references,
    aborts: () => aborts,
  };
}

Deno.test("worker capture streams multi-frame authored bytes and preserves order, metadata and stable identities", async () => {
  const f = fixture();
  const bytes = new Uint8Array(2 * 1024 * 1024 + 3).map((_, i) => i % 251);
  const ref = {
    assetId: "existing",
    kind: "file" as const,
    role: "attachment",
    mediaType: "application/pdf",
    name: "existing.pdf",
  };
  const input = [ref, {
    type: "file" as const,
    bytes,
    mediaType: "application/octet-stream",
    role: "attachment",
    name: "large.bin",
    alt: "payload",
    metadata: { label: "kept" },
  }, "after"];
  const options = {
    operationKey: "semantic/key:0",
    origin: { type: "message", id: "message-1" },
  };
  const result = await captureWorkerContent(input, options, f.port);
  assertEquals(result, [ref, { type: "content.pending", pendingRef: "1" }, {
    type: "content.pending",
    pendingRef: "2",
  }]);
  assertEquals(f.uploads[0].length, 33);
  assert(
    f.uploads[0].every((chunk) => chunk.byteLength <= CAPTURE_CHUNK_BYTES),
  );
  const joined = new Uint8Array(bytes.length);
  let offset = 0;
  for (const chunk of f.uploads[0]) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  assertEquals(joined, bytes);
  assertEquals(
    f.appendIds[0],
    f.uploads[0].map((_, i) => `chunk:${i * CAPTURE_CHUNK_BYTES}`),
  );
  assertEquals(f.closeInputs[0].descriptor, {
    reference: {
      kind: "file",
      role: "attachment",
      name: "large.bin",
      alt: "payload",
      metadata: { label: "kept" },
    },
    asset: { origin: options.origin, metadata: { label: "kept" } },
  });
  const replay = fixture();
  await captureWorkerContent(input, options, replay.port);
  assertEquals(
    replay.opens.map((value) => value.operationKey),
    f.opens.map((value) => value.operationKey),
  );
  assertEquals(replay.closeInputs, f.closeInputs);
});

Deno.test("worker capture accepts large PreparedContent bytes with distinct reference and asset metadata", async () => {
  const f = fixture(),
    body = new Uint8Array(CAPTURE_CHUNK_BYTES * 3 + 7).fill(17);
  const input = {
    content: [{
      assetId: "prepared",
      kind: "image",
      role: "attachment",
      mediaType: "image/png",
      metadata: { reference: true },
      name: "image.png",
    }],
    assets: [{
      id: "prepared",
      namespace: "test",
      mediaType: "image/png",
      body,
      byteLength: body.length,
      digest: await digestContent(body),
      metadata: { asset: true },
      origin: { type: "ignored-candidate", id: "one" },
    }],
  };
  await captureWorkerContent(input, {
    operationKey: "prepared",
    origin: { type: "capture", id: "two" },
  }, f.port);
  assertEquals(f.uploads[0].length, 4);
  assertEquals(f.closeInputs[0].descriptor, {
    reference: {
      kind: "image",
      role: "attachment",
      metadata: { reference: true },
      name: "image.png",
    },
    asset: {
      origin: { type: "capture", id: "two" },
      metadata: { asset: true },
    },
  });
});

Deno.test("worker capture detaches all authored bodies and metadata before asynchronous normalization", async () => {
  const f = fixture(),
    bytes = new Uint8Array(CAPTURE_CHUNK_BYTES + 1).fill(9),
    metadata = { label: "before" };
  const task = captureWorkerContent(
    [{ type: "file", bytes, mediaType: "application/octet-stream", metadata }],
    { operationKey: "immutable" },
    f.port,
  );
  bytes.fill(22);
  metadata.label = "after";
  await task;
  assert(f.uploads[0].every((chunk) => chunk.every((byte) => byte === 9)));
  assertEquals(f.opens[0].metadata, { label: "before" });
});

Deno.test("worker capture rejects hostile input hooks and owner physical descriptors before opening a writer", async () => {
  const f = fixture();
  let hooks = 0;
  await assertRejects(() =>
    captureWorkerContent(
      {
        type: "file",
        get bytes() {
          hooks++;
          return new Uint8Array();
        },
        mediaType: "x",
      },
      { operationKey: "hook" },
      f.port,
    ), TypeError);
  const body = new Uint8Array([1]), digest = await digestContent(body);
  for (
    const extra of [
      { readyBody: {} },
      { location: { kind: "database", key: "foreign" } },
      { logicalBodyId: "foreign" },
      { pendingAdoption: "foreign" },
      { namespace: "other" },
      { digest: "sha256:forged" },
      { byteLength: 22 },
    ]
  ) {
    await assertRejects(
      () =>
        captureWorkerContent(
          {
            content: [{
              assetId: "a",
              kind: "file",
              role: "attachment",
              mediaType: "x",
            }],
            assets: [{
              id: "a",
              namespace: "test",
              mediaType: "x",
              body,
              byteLength: 1,
              digest,
              ...extra,
            }],
          },
          { operationKey: "hostile" },
          f.port,
        ),
      TypeError,
    );
  }
  assertEquals(hooks, 0);
  assertEquals(f.opens.length, 0);
});

Deno.test("worker capture aborts an admitted upload when a bounded append fails", async () => {
  const f = fixture(), error = new Error("append failed"), open = f.port.open;
  const port: CapturePort = {
    ...f.port,
    async open(input) {
      const writer = await open(input);
      return { ...writer, append: () => Promise.reject(error) };
    },
  };
  await assertRejects(
    () =>
      captureWorkerContent(
        {
          type: "file",
          bytes: new Uint8Array(CAPTURE_CHUNK_BYTES + 1),
          mediaType: "x",
        },
        { operationKey: "fail" },
        port,
      ),
    Error,
    "append failed",
  );
  assertEquals(f.aborts(), 1);
  assertEquals(f.closeInputs.length, 0);
});

Deno.test("worker capture observes cancellation between frames and awaits failed cleanup", async () => {
  const f = fixture(), open = f.port.open;
  const port: CapturePort = {
    ...f.port,
    async open(input) {
      const writer = await open(input);
      return {
        ...writer,
        async append(value) {
          await writer.append(value);
          f.abort.abort(new Error("cancelled"));
        },
        abort: () => Promise.reject(new Error("cleanup unknown")),
      };
    },
  };
  const error = await assertRejects(
    () =>
      captureWorkerContent(
        {
          type: "file",
          bytes: new Uint8Array(CAPTURE_CHUNK_BYTES + 1),
          mediaType: "x",
        },
        { operationKey: "cancel" },
        port,
      ),
    AggregateError,
  );
  assertEquals(error.errors.map((item: Error) => item.message), [
    "cancelled",
    "cleanup unknown",
  ]);
  assertEquals(f.uploads[0].length, 1);
  assertEquals(f.closeInputs.length, 0);
});

Deno.test("worker capture preserves text, JSON and empty body normalization", async () => {
  const f = fixture();
  await captureWorkerContent(["", {
    type: "json",
    value: { b: [1, true] },
    name: "data",
  }, { type: "text", text: "hello", language: "en" }], {
    operationKey: "formats",
  }, f.port);
  assertEquals(
    f.uploads.map((chunks) =>
      chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")
    ),
    ["", '{"b":[1,true]}', "hello"],
  );
  assertEquals(
    f.opens.map((value) => [value.kind, value.role, value.mediaType]),
    [["text", "body", "text/plain; charset=utf-8"], [
      "json",
      "body",
      "application/json",
    ], ["text", "body", "text/plain; charset=utf-8"]],
  );
});
