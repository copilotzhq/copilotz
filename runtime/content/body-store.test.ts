import { assertEquals, assertRejects, assertThrows } from "@std/assert";

import { denoAssetFilesystem } from "../adapters/deno/assets.ts";
import {
  createFilesystemBodyStore,
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

Deno.test("filesystem store instances serialize settlement against late appends", async () => {
  const root = await Deno.makeTempDir({ prefix: "copilotz-body-fence-" });
  try {
    const first = createFilesystemBodyStore({
      backendId: "filesystem:fence-first",
      protectionMs: 0,
      access: denoAssetFilesystem(root),
    });
    const second = createFilesystemBodyStore({
      backendId: "filesystem:fence-second",
      protectionMs: 0,
      access: denoAssetFilesystem(root),
    });
    const writer = await first.reserve({
      bodyId: "bodies/filesystem-race",
      mediaType: "text/plain",
    });
    const bytes = encoder.encode("committed");
    await first.append({
      writer,
      expectedOffset: 0,
      appendId: "prefix",
      bytes,
    });

    const incompletePromise = first.terminate!({ writer });
    const lateAppendResult = assertRejects(() =>
      second.append({
        writer,
        expectedOffset: bytes.byteLength,
        appendId: "too-late",
        bytes: encoder.encode("late"),
      })
    );
    assertEquals((await incompletePromise).state, "incomplete");
    await lateAppendResult;
    assertEquals(
      await readBodyBytes(first, { bodyId: writer.bodyId }),
      bytes,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
