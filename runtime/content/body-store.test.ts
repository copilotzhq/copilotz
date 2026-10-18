import { assertEquals, assertRejects, assertThrows } from "@std/assert";

import {
  createMemoryBodyStore,
  readBodyBytes,
  readBodyRange,
} from "./body-store.ts";
import { digestContent } from "./digest.ts";

const encoder = new TextEncoder();
const expired = "2000-01-01T00:00:00.000Z";

Deno.test("memory BodyStore acquire-or-create renews protection and fences maintenance", async () => {
  const store = createMemoryBodyStore({ protectionMs: 60_000 });
  const bytes = encoder.encode("immutable");
  const input = {
    bodyId: "bodies/memory-renewal",
    bytes,
    mediaType: "text/plain",
    digest: await digestContent(bytes),
  } as const;

  const expiredHead = await store.put({ ...input, protectedUntil: expired });
  const renewed = await store.put(input);
  assertEquals(renewed.maintenanceVersion, expiredHead.maintenanceVersion + 1);
  assertEquals(Date.parse(renewed.protectedUntil!) > Date.now(), true);
  const kept = await store.put({ ...input, protectedUntil: expired });
  assertEquals(kept.maintenanceVersion, renewed.maintenanceVersion + 1);
  assertEquals(kept.protectedUntil, renewed.protectedUntil);
  assertEquals(
    await store.maintenance.delete({
      bodyId: renewed.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: expiredHead.maintenanceVersion,
      idleForMs: 0,
    }),
    false,
  );
  assertEquals(
    await store.maintenance.delete({
      bodyId: renewed.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: kept.maintenanceVersion,
      idleForMs: 0,
    }),
    false,
  );

  assertThrows(() =>
    store.put({
      ...input,
      bytes: encoder.encode("different"),
      digest:
        "sha256:9d6f965ac832e40a5df6c06afe983e3b4a6fba16c4baadd5f38b359904f9e39c",
    })
  );
});

Deno.test("memory BodyStore maintenance enforces version, idle, and protection in one delete", async () => {
  const store = createMemoryBodyStore({ protectionMs: 0 });
  const bytes = encoder.encode("collectable");
  const input = {
    bodyId: "bodies/memory-collectable",
    bytes,
    mediaType: "text/plain",
    digest: await digestContent(bytes),
    protectedUntil: expired,
  } as const;
  const first = await store.put(input);
  const current = await store.put(input);

  assertEquals(
    await store.maintenance.delete({
      bodyId: current.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: first.maintenanceVersion,
      idleForMs: 0,
    }),
    false,
  );
  assertEquals(
    await store.maintenance.delete({
      bodyId: current.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: current.maintenanceVersion,
      idleForMs: 60_000,
    }),
    false,
  );
  assertEquals(
    await store.maintenance.delete({
      bodyId: current.bodyId,
      expectedState: "ready",
      expectedMaintenanceVersion: current.maintenanceVersion,
      idleForMs: 0,
    }),
    true,
  );
  assertEquals(await store.head({ bodyId: current.bodyId }), null);
});

Deno.test("memory retained termination freezes readable bytes and purges with exact CAS", async () => {
  const store = createMemoryBodyStore({ protectionMs: 0 });
  const bytes = encoder.encode("committed failure evidence");
  const writer = await store.reserve({
    bodyId: "bodies/incomplete",
    mediaType: "text/plain",
  });
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "evidence",
    bytes,
  });

  const incomplete = await store.terminate!({
    writer,
    expectedByteLength: bytes.byteLength,
    expectedDigest: await digestContent(bytes),
  });
  assertEquals(incomplete.state, "incomplete");
  assertEquals(
    await readBodyBytes(store, { bodyId: incomplete.bodyId }),
    bytes,
  );
  assertEquals(
    await readBodyRange(store, {
      bodyId: incomplete.bodyId,
      offset: 10,
      end: 17,
    }),
    bytes.slice(10, 17),
  );
  assertEquals(
    await readBodyBytes(
      { read: () => store.follow({ bodyId: incomplete.bodyId, offset: 4 }) },
      { bodyId: incomplete.bodyId },
    ),
    bytes.slice(4),
  );
  assertThrows(() =>
    store.put({
      bodyId: incomplete.bodyId,
      bytes,
      mediaType: incomplete.mediaType,
      digest: incomplete.digest,
    })
  );
  assertEquals(
    await store.maintenance.delete({
      bodyId: incomplete.bodyId,
      expectedState: "incomplete",
      expectedMaintenanceVersion: incomplete.maintenanceVersion - 1,
      idleForMs: 0,
    }),
    false,
  );
  assertEquals(
    await store.maintenance.delete({
      bodyId: incomplete.bodyId,
      expectedState: "incomplete",
      expectedMaintenanceVersion: incomplete.maintenanceVersion,
      idleForMs: 0,
    }),
    true,
  );
  assertEquals(await store.head({ bodyId: incomplete.bodyId }), null);
});

Deno.test("memory settlement freezes synchronously across digest awaits", async () => {
  const bytes = encoder.encode("a prefix that must not change while hashing");
  const sealing = createMemoryBodyStore({ protectionMs: 0 });
  const sealWriter = await sealing.reserve({
    bodyId: "bodies/seal-race",
    mediaType: "text/plain",
  });
  await sealing.append({
    writer: sealWriter,
    expectedOffset: 0,
    appendId: "prefix",
    bytes,
  });

  const readyPromise = sealing.seal({ writer: sealWriter });
  assertEquals(
    (await sealing.head({ bodyId: sealWriter.bodyId }))?.state,
    "sealing",
  );
  assertThrows(() =>
    sealing.append({
      writer: sealWriter,
      expectedOffset: bytes.byteLength,
      appendId: "too-late",
      bytes: encoder.encode("late"),
    })
  );
  await assertRejects(() => sealing.terminate!({ writer: sealWriter }));
  assertEquals((await readyPromise).state, "ready");

  const terminating = createMemoryBodyStore({ protectionMs: 0 });
  const terminateWriter = await terminating.reserve({
    bodyId: "bodies/terminate-race",
    mediaType: "text/plain",
  });
  await terminating.append({
    writer: terminateWriter,
    expectedOffset: 0,
    appendId: "prefix",
    bytes,
  });
  const incompletePromise = terminating.terminate!({
    writer: terminateWriter,
  });
  assertEquals(
    (await terminating.head({ bodyId: terminateWriter.bodyId }))?.state,
    "terminating",
  );
  assertThrows(() =>
    terminating.append({
      writer: terminateWriter,
      expectedOffset: bytes.byteLength,
      appendId: "too-late",
      bytes: encoder.encode("late"),
    })
  );
  await assertRejects(() => terminating.seal({ writer: terminateWriter }));
  assertEquals((await incompletePromise).state, "incomplete");
});

for (const text of ["", "first"]) {
  Deno.test(`memory append identity preserves original offset for ${text ? "nonempty" : "empty"} chunks`, async () => {
    const store = createMemoryBodyStore();
    const writer = await store.reserve({
      bodyId: `bodies/append-offset-${text || "empty"}`,
      mediaType: "text/plain",
    });
    const first = encoder.encode(text);
    await store.append({
      writer,
      expectedOffset: 0,
      appendId: "first",
      bytes: first,
    });
    await store.append({
      writer,
      expectedOffset: first.byteLength,
      appendId: "tail",
      bytes: encoder.encode("tail"),
    });
    const headBefore = await store.head({ bodyId: writer.bodyId });
    const replay = await store.append({
      writer,
      expectedOffset: 0,
      appendId: "first",
      bytes: first.slice(),
    });
    assertEquals(replay.startOffset, 0);
    assertEquals(replay.endOffset, first.byteLength + 4);
    const error = assertThrows(() =>
      store.append({
        writer,
        expectedOffset: 1,
        appendId: "first",
        bytes: first.slice(),
      })
    );
    assertEquals((error as { code?: string }).code, "asset_conflict");
    const headAfter = await store.head({ bodyId: writer.bodyId });
    assertEquals(headAfter?.byteLength, headBefore?.byteLength);
    assertEquals(headAfter?.maintenanceVersion, headBefore?.maintenanceVersion);
    assertEquals(
      await store.readRange({
        bodyId: writer.bodyId,
        offset: 0,
        end: first.byteLength + 4,
      }),
      encoder.encode(text + "tail"),
    );
  });
}

Deno.test("memory append replay retains nonzero offset and an owned byte snapshot", async () => {
  const store = createMemoryBodyStore();
  const writer = await store.reserve({
    bodyId: "bodies/append-owned",
    mediaType: "text/plain",
  });
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "prefix",
    bytes: encoder.encode("pre"),
  });
  const supplied = encoder.encode("value");
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
    bytes: encoder.encode("tail"),
  });
  const before = await store.head({ bodyId: writer.bodyId });
  const replay = await store.append({
    writer,
    expectedOffset: 3,
    appendId: "owned",
    bytes: encoder.encode("value"),
  });
  assertEquals([replay.startOffset, replay.endOffset], [3, 12]);
  for (
    const [expectedOffset, bytes] of [[3, supplied], [
      4,
      encoder.encode("value"),
    ]] as const
  ) {
    const error = assertThrows(() =>
      store.append({ writer, expectedOffset, appendId: "owned", bytes })
    );
    assertEquals((error as { code?: string }).code, "asset_conflict");
  }
  const after = await store.head({ bodyId: writer.bodyId });
  assertEquals(after?.byteLength, before?.byteLength);
  assertEquals(after?.maintenanceVersion, before?.maintenanceVersion);
  assertEquals(
    await store.readRange({ bodyId: writer.bodyId, offset: 0, end: 12 }),
    encoder.encode("prevaluetail"),
  );
});
