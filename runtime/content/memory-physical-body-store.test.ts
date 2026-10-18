import { PHYSICAL_READ_MAX_BYTES } from "./physical-body-store.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createMemoryPhysicalBodyStore } from "./memory-physical-body-store.ts";
import {
  OWNER_PHYSICAL_BODY_FORMAT,
  PHYSICAL_APPEND_MAX_BYTES,
  type PhysicalWriterIdentity,
} from "./physical-body-store.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const identity = (): PhysicalWriterIdentity => ({
  bodyId: "copy/attempt-a",
  mediaType: "text/plain",
  reservationId: "reservation-a",
  generation: 7,
});
async function refused(work: () => Promise<unknown>, code = "asset_conflict") {
  const error = await assertRejects(async () => await work());
  assertEquals((error as { code?: string }).code, code);
}

Deno.test("private physical reserve is exact, create-only and has no lease or maintenance API", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  assertEquals(Object.keys(store).sort(), [
    "append",
    "fence",
    "head",
    "readRange",
    "reserve",
  ]);
  const first = await store.reserve(writer);
  assertEquals(first, await store.reserve({ ...writer }));
  assertEquals(first.format, OWNER_PHYSICAL_BODY_FORMAT);
  assertEquals(first.state, "open");
  assertEquals(first.byteLength, 0);
  assertEquals(Object.keys(first).sort(), [
    "bodyId",
    "byteLength",
    "format",
    "generation",
    "mediaType",
    "reservationId",
    "state",
    "versionToken",
  ]);
  assertThrows(() => Object.assign(first, { generation: 999 }));
  assertEquals((await store.head(writer.bodyId))?.generation, 7);
});

Deno.test("private reserve and fence refuse conflicting identities without mutation", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  const before = await store.reserve(writer);
  for (
    const conflicting of [
      { ...writer, generation: 8 },
      { ...writer, mediaType: "application/octet-stream" },
      { ...writer, reservationId: "another" },
    ]
  ) {
    await refused(() => store.reserve(conflicting));
    await refused(() => store.fence(conflicting));
    assertEquals(await store.head(writer.bodyId), before);
  }
});

Deno.test("private append owns bytes and replays only at its original nonzero offset", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  await store.reserve(writer);
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "prefix",
    bytes: bytes("pre"),
  });
  const supplied = bytes("value");
  await store.append({
    writer,
    expectedOffset: 3,
    appendId: "owned",
    bytes: supplied,
  });
  supplied.fill(0);
  await store.append({
    writer,
    expectedOffset: 8,
    appendId: "tail",
    bytes: bytes("tail"),
  });
  const before = await store.head(writer.bodyId);
  const replay = await store.append({
    writer,
    expectedOffset: 3,
    appendId: "owned",
    bytes: bytes("value"),
  });
  assertEquals(replay, {
    startOffset: 3,
    endOffset: 12,
    versionToken: before!.versionToken,
  });
  await refused(() =>
    store.append({
      writer,
      expectedOffset: 4,
      appendId: "owned",
      bytes: bytes("value"),
    })
  );
  await refused(() =>
    store.append({
      writer,
      expectedOffset: 3,
      appendId: "owned",
      bytes: supplied,
    })
  );
  assertEquals(await store.head(writer.bodyId), before);
  assertEquals(
    await store.readRange({ bodyId: writer.bodyId, offset: 0, end: 12 }),
    bytes("prevaluetail"),
  );
});

Deno.test("physical fence advances once and preserves the entire physical tail", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  await store.reserve(writer);
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "one",
    bytes: bytes("accepted-and-tentative"),
  });
  const before = await store.head(writer.bodyId);
  const fenced = await store.fence(writer);
  assertEquals(fenced.state, "fenced");
  assertEquals(fenced.generation, writer.generation + 1);
  assertEquals(fenced.byteLength, before!.byteLength);
  assertEquals(fenced.versionToken === before!.versionToken, false);
  assertEquals(await store.fence({ ...writer }), fenced);
  await refused(() =>
    store.append({
      writer,
      expectedOffset: fenced.byteLength,
      appendId: "late",
      bytes: bytes("late"),
    })
  );
  await refused(() => store.reserve(writer));
  await refused(() => store.reserve({ ...writer, generation: 8 }));
  await refused(() =>
    store.reserve({ ...writer, generation: 8, reservationId: "successor" })
  );
  await refused(() => store.fence({ ...writer, generation: 8 }));
  assertEquals(
    await store.readRange({
      bodyId: writer.bodyId,
      offset: 0,
      end: fenced.byteLength,
    }),
    bytes("accepted-and-tentative"),
  );
  assertEquals(await store.head(writer.bodyId), fenced);
});

Deno.test("fence on missing creates an exact tombstone that rejects delayed reserve", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const delayed = gate.then(() => store.reserve(writer));
  const rejected = refused(() => delayed);
  const fenced = await store.fence(writer);
  assertEquals([fenced.state, fenced.generation, fenced.byteLength], [
    "fenced",
    8,
    0,
  ]);
  release();
  await rejected;
  assertEquals(await store.fence(writer), fenced);
  await refused(() => store.fence({ ...writer, reservationId: "conflicting" }));
  assertEquals(
    await store.readRange({ bodyId: writer.bodyId, offset: 0, end: 0 }),
    new Uint8Array(),
  );
  await refused(
    () => store.readRange({ bodyId: writer.bodyId, offset: 0, end: 1 }),
    "asset_storage_unavailable",
  );
});

Deno.test("a delayed append cannot commit after fencing", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  await store.reserve(writer);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const delayed = gate.then(() =>
    store.append({
      writer,
      expectedOffset: 0,
      appendId: "late",
      bytes: bytes("late"),
    })
  );
  const rejected = refused(() => delayed);
  const fenced = await store.fence(writer);
  release();
  await rejected;
  assertEquals(await store.head(writer.bodyId), fenced);
});

Deno.test("physical appends reject empty/oversized payloads and unsafe offsets before mutation", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  const before = await store.reserve(writer);
  for (
    const payload of [
      new Uint8Array(),
      new Uint8Array(PHYSICAL_APPEND_MAX_BYTES + 1),
    ]
  ) {
    await refused(
      () =>
        store.append({
          writer,
          expectedOffset: 0,
          appendId: "invalid",
          bytes: payload,
        }),
      "content_invalid",
    );
    assertEquals(await store.head(writer.bodyId), before);
  }
  await refused(
    () =>
      store.append({
        writer,
        expectedOffset: Number.MAX_SAFE_INTEGER,
        appendId: "overflow",
        bytes: bytes("a"),
      }),
    "content_invalid",
  );
  const maximum = new Uint8Array(PHYSICAL_APPEND_MAX_BYTES);
  maximum[maximum.length - 1] = 9;
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "maximum",
    bytes: maximum,
  });
  maximum.fill(0);
  assertEquals(
    await store.readRange({
      bodyId: writer.bodyId,
      offset: PHYSICAL_APPEND_MAX_BYTES - 1,
      end: PHYSICAL_APPEND_MAX_BYTES,
    }),
    new Uint8Array([9]),
  );
});

Deno.test("physical range reads never return a successful short or aliased body", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  await refused(
    () => store.readRange({ bodyId: writer.bodyId, offset: 0, end: 1 }),
    "asset_not_found",
  );
  await store.reserve(writer);
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "one",
    bytes: bytes("hello"),
  });
  const read = await store.readRange({
    bodyId: writer.bodyId,
    offset: 1,
    end: 4,
  });
  assertEquals(read, bytes("ell"));
  read.fill(0);
  assertEquals(
    await store.readRange({ bodyId: writer.bodyId, offset: 1, end: 4 }),
    bytes("ell"),
  );
  await refused(
    () => store.readRange({ bodyId: writer.bodyId, offset: 0, end: 6 }),
    "asset_storage_unavailable",
  );
  await refused(
    () => store.readRange({ bodyId: writer.bodyId, offset: 6, end: 6 }),
    "asset_storage_unavailable",
  );
  await refused(
    () => store.readRange({ bodyId: writer.bodyId, offset: 4, end: 1 }),
    "content_invalid",
  );
});

Deno.test("physical identity capture refuses accessors, unknown fields and unsafe generations", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  let getters = 0;
  const accessor = {
    ...writer,
    get generation() {
      getters++;
      return 7;
    },
  };
  await refused(() => store.reserve(accessor), "content_invalid");
  assertEquals(getters, 0);
  for (
    const invalid of [{ ...writer, lease: 1 }, { ...writer, generation: 0 }, {
      ...writer,
      generation: Number.MAX_SAFE_INTEGER,
    }, { ...writer, generation: NaN }]
  ) {
    await refused(() => store.reserve(invalid), "content_invalid");
  }
  assertEquals(await store.head(writer.bodyId), null);
  const largest = { ...writer, generation: Number.MAX_SAFE_INTEGER - 1 };
  await store.reserve(largest);
  assertEquals(
    (await store.fence(largest)).generation,
    Number.MAX_SAFE_INTEGER,
  );
});

Deno.test("physical writer authority is independent of elapsed wall-clock time", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  await store.reserve(writer);
  const now = Date.now;
  try {
    Date.now = () => now() + 365 * 24 * 60 * 60 * 1000;
    await store.append({
      writer,
      expectedOffset: 0,
      appendId: "quiet",
      bytes: bytes("still-open"),
    });
    assertEquals((await store.head(writer.bodyId))?.state, "open");
    await refused(() =>
      store.reserve({ ...writer, generation: 8, reservationId: "other" })
    );
  } finally {
    Date.now = now;
  }
});

Deno.test("memory physical ranges page at the shared 1 MiB bound", async () => {
  const store = createMemoryPhysicalBodyStore(), writer = identity();
  const payload = new Uint8Array(PHYSICAL_READ_MAX_BYTES).fill(7);
  await store.reserve(writer);
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "maximum",
    bytes: payload,
  });
  assertEquals(
    await store.readRange({
      bodyId: writer.bodyId,
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
});
