import { assert, assertEquals, assertRejects } from "@std/assert";
import { Buffer } from "node:buffer";
import { type BodyStore, readBodyBytes } from "../content/body-store.ts";
import {
  BODY_APPEND_MAX_BYTES,
  BODY_READ_MAX_BYTES,
} from "../content/body-store-operations.ts";
import { digestContent } from "../content/digest.ts";
const bytes = (text: string) => new TextEncoder().encode(text);
/** Guarantees shared by every progressive physical adapter. */
export async function bodyStoreConformance(
  t: Deno.TestContext,
  store: BodyStore,
): Promise<void> {
  const identity = (name: string) => ({
    bodyId: `bodies/${name}`,
    mediaType: "text/plain",
    reservationId: `reservation:${name}`,
    generation: 7,
  });
  const reserve = (name: string) => store.reserve(identity(name));
  await t.step(
    "identities reject accessors and unsafe generations before touching storage",
    async () => {
      let getter = 0;
      await assertRejects(() =>
        store.reserve({
          ...identity("getter"),
          get reservationId() {
            getter++;
            return "bad";
          },
        })
      );
      assertEquals(getter, 0);
      for (
        const generation of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]
      ) {
        await assertRejects(() =>
          store.reserve({ ...identity("invalid-generation"), generation })
        );
      }
      await assertRejects(() =>
        store.reserve({ ...identity("unknown"), unexpected: true } as never)
      );
      assertEquals(
        await store.head({ bodyId: "bodies/invalid-generation" }),
        null,
      );
      const overflow = await assertRejects(() =>
        store.fence({
          writer: {
            ...identity("overflow-fence"),
            generation: Number.MAX_SAFE_INTEGER,
            byteLength: 0,
            discarded: 0,
          },
        })
      );
      assertEquals(
        (overflow as Error & { code: string }).code,
        "content_invalid",
      );
      assertEquals(await store.head({ bodyId: "bodies/overflow-fence" }), null);
    },
  );
  await t.step(
    "quiet writers retain authority independent of elapsed wall-clock time",
    async () => {
      const writer = await reserve("quiet"), now = Date.now;
      try {
        Date.now = () => now() + 100 * 365 * 24 * 3600 * 1000;
        await store.append({
          writer,
          expectedOffset: 0,
          appendId: "after-quiet",
          bytes: bytes("still live"),
        });
      } finally {
        Date.now = now;
      }
      assertEquals(
        (await store.head({ bodyId: writer.bodyId }))?.byteLength,
        10,
      );
    },
  );
  await t.step(
    "exact create-only reservations never choose a successor or expire",
    async () => {
      const original = await reserve("reserve");
      assertEquals(await reserve("reserve"), original);
      await assertRejects(() =>
        store.reserve({ ...identity("reserve"), generation: 8 })
      );
      await assertRejects(() =>
        store.reserve({ ...identity("reserve"), reservationId: "other" })
      );
      await assertRejects(() =>
        store.reserve({ ...identity("reserve"), mediaType: "other" })
      );
      assertEquals(
        (await store.head({ bodyId: original.bodyId }))?.state,
        "open",
      );
    },
  );
  await t.step(
    "append ID binds the original offset and an owned byte view",
    async () => {
      const writer = await reserve("append");
      const source = Buffer.from("xxfirstyy"), view = source.subarray(2, 7);
      const pending = store.append({
        writer,
        expectedOffset: 0,
        appendId: "first",
        bytes: view,
      });
      source.fill(0);
      const first = await pending;
      const tail = await store.append({
        writer,
        expectedOffset: 5,
        appendId: "tail",
        bytes: bytes("tail"),
      });
      const replay = await store.append({
        writer,
        expectedOffset: 0,
        appendId: "first",
        bytes: bytes("first"),
      });
      assertEquals(replay.startOffset, 0);
      assertEquals(replay.endOffset, 5);
      assertEquals(replay.versionToken, tail.versionToken);
      assert(first.versionToken !== tail.versionToken);
      await assertRejects(() =>
        store.append({
          writer,
          expectedOffset: 9,
          appendId: "first",
          bytes: bytes("first"),
        })
      );
      await assertRejects(() =>
        store.append({
          writer,
          expectedOffset: 0,
          appendId: "first",
          bytes: bytes("other"),
        })
      );
      assertEquals(
        await store.readRange({ bodyId: writer.bodyId, offset: 0, end: 9 }),
        bytes("firsttail"),
      );
    },
  );
  await t.step(
    "nonzero append replay returns the original span after later appends",
    async () => {
      const writer = await reserve("nonzero-replay");
      for (
        const [expectedOffset, appendId, text] of [[0, "prefix", "pre"], [
          3,
          "owned",
          "value",
        ], [8, "tail", "tail"]] as const
      ) {
        await store.append({
          writer,
          expectedOffset,
          appendId,
          bytes: bytes(text),
        });
      }
      const before = await store.head({ bodyId: writer.bodyId });
      const replay = await store.append({
        writer,
        expectedOffset: 3,
        appendId: "owned",
        bytes: bytes("value"),
      });
      assertEquals([replay.startOffset, replay.endOffset], [3, 8]);
      assertEquals(await store.head({ bodyId: writer.bodyId }), before);
      await assertRejects(() =>
        store.append({
          writer,
          expectedOffset: 4,
          appendId: "owned",
          bytes: bytes("value"),
        })
      );
    },
  );
  await t.step(
    "bounded, finite, detached requests reject invalid append data",
    async () => {
      const writer = await reserve("bounds");
      for (
        const payload of [
          new Uint8Array(),
          new Uint8Array(BODY_APPEND_MAX_BYTES + 1),
        ]
      ) {
        await assertRejects(() =>
          store.append({
            writer,
            expectedOffset: 0,
            appendId: "bad",
            bytes: payload,
          })
        );
      }
      await assertRejects(() =>
        store.append({
          writer,
          expectedOffset: -1,
          appendId: "bad",
          bytes: bytes("x"),
        })
      );
      await assertRejects(() =>
        store.readRange({
          bodyId: writer.bodyId,
          offset: 0,
          end: BODY_READ_MAX_BYTES + 1,
        })
      );
      let getter = 0;
      await assertRejects(() =>
        store.append({
          writer,
          expectedOffset: 0,
          appendId: "getter",
          get bytes() {
            getter++;
            return bytes("x");
          },
        })
      );
      assertEquals(getter, 0);
      assertEquals(
        (await store.head({ bodyId: writer.bodyId }))?.byteLength,
        0,
      );
    },
  );
  await t.step(
    "competing appends accept one contiguous value and preserve shared retries",
    async () => {
      const writer = await reserve("race");
      const requests = await Promise.allSettled([
        store.append({
          writer,
          expectedOffset: 0,
          appendId: "same",
          bytes: bytes("shared"),
        }),
        store.append({
          writer,
          expectedOffset: 0,
          appendId: "same",
          bytes: bytes("shared"),
        }),
      ]);
      assert(requests.some((result) => result.status === "fulfilled"));
      assertEquals(
        await store.readRange({ bodyId: writer.bodyId, offset: 0, end: 6 }),
        bytes("shared"),
      );
      await assertRejects(() =>
        store.append({
          writer,
          expectedOffset: 0,
          appendId: "different",
          bytes: bytes("wrong"),
        })
      );
    },
  );
  await t.step(
    "fence advances once, prevents old append/seal, and allows accepted-prefix termination",
    async () => {
      const writer = await reserve("fence");
      await store.append({
        writer,
        expectedOffset: 0,
        appendId: "all",
        bytes: bytes("accepted-tentative"),
      });
      const next = await store.fence({ writer });
      assertEquals(next.generation, writer.generation + 1);
      assertEquals(await store.fence({ writer }), next);
      await assertRejects(() => store.reserve(identity("fence")));
      await assertRejects(() =>
        store.append({
          writer,
          expectedOffset: 18,
          appendId: "old",
          bytes: bytes("x"),
        })
      );
      await assertRejects(async () =>
        store.seal({
          writer,
          expectedByteLength: 18,
          expectedDigest: await digestContent(bytes("accepted-tentative")),
        })
      );
      await assertRejects(() =>
        store.append({
          writer: next,
          expectedOffset: 18,
          appendId: "new",
          bytes: bytes("x"),
        })
      );
      const input = {
        writer: next,
        expectedByteLength: 8,
        expectedDigest: await digestContent(bytes("accepted")),
      };
      const terminal = await store.terminate(input);
      assertEquals(terminal.state, "incomplete");
      assertEquals(await store.terminate(input), terminal);
      assertEquals(
        await readBodyBytes(store, { bodyId: writer.bodyId }),
        bytes("accepted"),
      );
      assertEquals(
        await store.readRange({ bodyId: writer.bodyId, offset: 8, end: 18 }),
        new Uint8Array(),
      );
      await assertRejects(() =>
        store.put({
          bodyId: writer.bodyId,
          mediaType: "text/plain",
          bytes: bytes("accepted"),
          digest: terminal.digest,
        })
      );
      assertEquals((await store.fence({ writer })).generation, next.generation);
    },
  );
  await t.step(
    "an absent-key fence durably blocks a delayed reserve",
    async () => {
      const writer = { ...identity("absent"), byteLength: 0, discarded: 0 };
      const next = await store.fence({ writer });
      assertEquals(next.generation, 8);
      assertEquals(await store.fence({ writer }), next);
      await assertRejects(() => store.reserve(identity("absent")));
      await store.terminate({
        writer: next,
        expectedByteLength: 0,
        expectedDigest: await digestContent(new Uint8Array()),
      });
    },
  );
  await t.step(
    "seal verifies exact length and digest and is an immutable retry",
    async () => {
      const writer = await reserve("seal");
      await store.append({
        writer,
        expectedOffset: 0,
        appendId: "data",
        bytes: bytes("complete"),
      });
      const digest = await digestContent(bytes("complete"));
      await assertRejects(() =>
        store.seal({ writer, expectedByteLength: 7, expectedDigest: digest })
      );
      await assertRejects(() =>
        store.seal({
          writer,
          expectedByteLength: 8,
          expectedDigest: `sha256:${"0".repeat(64)}`,
        })
      );
      const ready = await store.seal({
        writer,
        expectedByteLength: 8,
        expectedDigest: digest,
      });
      assertEquals(ready.state, "ready");
      assertEquals(
        await store.seal({
          writer,
          expectedByteLength: 8,
          expectedDigest: digest,
        }),
        ready,
      );
      await assertRejects(() =>
        store.append({
          writer,
          expectedOffset: 8,
          appendId: "late",
          bytes: bytes("x"),
        })
      );
      assertEquals(
        await readBodyBytes(store, { bodyId: writer.bodyId }),
        bytes("complete"),
      );
      const fenced = await store.fence({ writer });
      assertEquals(fenced.generation, 8);
      await assertRejects(() =>
        store.seal({ writer, expectedByteLength: 8, expectedDigest: digest })
      );
    },
  );
  await t.step(
    "settlement CAS never certifies a body changed by a concurrent append",
    async () => {
      const writer = await reserve("settlement-race");
      await store.append({
        writer,
        expectedOffset: 0,
        appendId: "prefix",
        bytes: bytes("prefix"),
      });
      const digest = await digestContent(bytes("prefix"));
      const [seal, append] = await Promise.allSettled([
        store.seal({ writer, expectedByteLength: 6, expectedDigest: digest }),
        store.append({
          writer,
          expectedOffset: 6,
          appendId: "late",
          bytes: bytes("tail"),
        }),
      ]);
      assert(!(seal.status === "fulfilled" && append.status === "fulfilled"));
      const head = (await store.head({ bodyId: writer.bodyId }))!;
      if (head.state === "ready") {
        assertEquals(head.byteLength, 6);
        assertEquals(head.digest, digest);
      } else {
        assertEquals(head.state, "open");
        assertEquals(head.byteLength, 10);
        await assertRejects(() =>
          store.seal({ writer, expectedByteLength: 6, expectedDigest: digest })
        );
      }
    },
  );
  await t.step(
    "fenced seal-intent recovery certifies only its exact accepted prefix",
    async () => {
      const writer = await reserve("recover-intent");
      await store.append({
        writer,
        expectedOffset: 0,
        appendId: "all",
        bytes: bytes("accepted-tail"),
      });
      const next = await store.fence({ writer });
      const ready = await store.seal({
        writer: next,
        expectedByteLength: 8,
        expectedDigest: await digestContent(bytes("accepted")),
      });
      assertEquals(ready.state, "ready");
      assertEquals(
        await readBodyBytes(store, { bodyId: writer.bodyId }),
        bytes("accepted"),
      );
    },
  );
  await t.step(
    "termination cannot include tentative tail or misstate its digest",
    async () => {
      const writer = await reserve("prefix");
      await store.append({
        writer,
        expectedOffset: 0,
        appendId: "data",
        bytes: bytes("123456789"),
      });
      await assertRejects(() =>
        store.terminate({
          writer,
          expectedByteLength: 10,
          expectedDigest: `sha256:${"0".repeat(64)}`,
        })
      );
      await assertRejects(async () =>
        store.terminate({
          writer,
          expectedByteLength: 3,
          expectedDigest: await digestContent(bytes("123456789")),
        })
      );
      const terminal = await store.terminate({
        writer,
        expectedByteLength: 3,
        expectedDigest: await digestContent(bytes("123")),
      });
      assertEquals(terminal.byteLength, 3);
      assertEquals(
        await readBodyBytes({
          read: () => store.follow({ bodyId: writer.bodyId, offset: 1 }),
        }, { bodyId: writer.bodyId }),
        bytes("23"),
      );
    },
  );
  await t.step(
    "immutable put verifies input and retained bytes without changing version",
    async () => {
      const input = {
        bodyId: "bodies/put",
        mediaType: "text/plain",
        bytes: bytes("immutable"),
        digest: await digestContent(bytes("immutable")),
      };
      const head = await store.put(input);
      assertEquals(
        await store.put({ ...input, bytes: input.bytes.slice() }),
        head,
      );
      await assertRejects(() => store.put({ ...input, bytes: bytes("wrong") }));
      await assertRejects(() =>
        store.put({ ...input, mediaType: "application/json" })
      );
      assertEquals(
        await readBodyBytes(store, { bodyId: input.bodyId }),
        input.bytes,
      );
    },
  );
  await t.step(
    "abort retains a tombstone, never a delayed-reservation opening",
    async () => {
      const writer = await reserve("abort");
      await store.abort({ writer });
      await store.abort({ writer });
      assertEquals(
        (await store.head({ bodyId: writer.bodyId }))?.state,
        "aborted",
      );
      await assertRejects(() => store.reserve(identity("abort")));
      await assertRejects(() => store.read({ bodyId: writer.bodyId }));
    },
  );
  await t.step(
    "collection uses the exact version, never writer age or a diagnostic number",
    async () => {
      const writer = await reserve("delete");
      const before = (await store.head({ bodyId: writer.bodyId }))!;
      await store.append({
        writer,
        expectedOffset: 0,
        appendId: "data",
        bytes: bytes("x"),
      });
      const after = (await store.head({ bodyId: writer.bodyId }))!;
      assertEquals(
        await store.maintenance.delete({
          bodyId: writer.bodyId,
          expectedState: "open",
          expectedVersionToken: before.versionToken,
          expectedMaintenanceVersion: after.maintenanceVersion,
          idleForMs: 0,
        }),
        false,
      );
      assertEquals(
        await store.maintenance.delete({
          bodyId: writer.bodyId,
          expectedState: "open",
          expectedVersionToken: after.versionToken,
          expectedMaintenanceVersion: before.maintenanceVersion,
          idleForMs: 999999,
        }),
        store.conditionalDelete,
      );
      assertEquals(
        await store.head({ bodyId: writer.bodyId }) === null,
        store.conditionalDelete,
      );
    },
  );
  await t.step(
    "missing and empty immutable bodies remain distinct",
    async () => {
      await assertRejects(() => store.read({ bodyId: "missing" }));
      await assertRejects(() =>
        store.readRange({ bodyId: "missing", offset: 0, end: 0 })
      );
      const input = {
        bodyId: "bodies/empty",
        mediaType: "text/plain",
        bytes: new Uint8Array(),
        digest: await digestContent(new Uint8Array()),
      };
      await store.put(input);
      assertEquals(
        await readBodyBytes(store, { bodyId: input.bodyId }),
        new Uint8Array(),
      );
      assertEquals(
        await store.readRange({ bodyId: input.bodyId, offset: 0, end: 0 }),
        new Uint8Array(),
      );
    },
  );
}
