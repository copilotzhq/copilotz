import { assertEquals } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { createDatabaseAssetBodyStore } from "./database-body-store.ts";
import {
  createProgressiveBodyWriter,
  openProgressiveBodyFollower,
} from "./progressive.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

Deno.test("a remote follower can open an empty reserved progressive body", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const writerStore = createDatabaseAssetBodyStore({
    session: db,
    schema: "copilotz_progressive_remote_follower",
    backendId: "database:writer-process",
  });
  const followerStore = createDatabaseAssetBodyStore({
    session: db,
    schema: "copilotz_progressive_remote_follower",
    backendId: "database:follower-process",
  });
  const writer = await createProgressiveBodyWriter(writerStore, {
    key: "streams/remote-before-first-byte",
    mediaType: "text/plain",
  });
  try {
    const follower = await openProgressiveBodyFollower(followerStore, {
      key: writer.key,
    });
    const reading = readAll(follower.body);
    await writer.write(encoder.encode("remote stream"));
    await writer.finalize();
    assertEquals(decoder.decode(await reading), "remote stream");
  } finally {
    await writer.abandon().catch(() => undefined);
    await db.close();
  }
});

Deno.test("progressive writer ownership is exclusive across store instances", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const firstStore = createDatabaseAssetBodyStore({
    session: db,
    schema: "copilotz_progressive_writer_fence",
    backendId: "database:first-process",
  });
  const secondStore = createDatabaseAssetBodyStore({
    session: db,
    schema: "copilotz_progressive_writer_fence",
    backendId: "database:second-process",
  });
  const first = await createProgressiveBodyWriter(firstStore, {
    key: "streams/one-writer",
    mediaType: "text/plain",
  });
  let second:
    | Awaited<ReturnType<typeof createProgressiveBodyWriter>>
    | undefined;
  let rejected = false;
  try {
    try {
      second = await createProgressiveBodyWriter(secondStore, {
        key: "streams/one-writer",
        mediaType: "text/plain",
      });
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
  } finally {
    await second?.abandon().catch(() => undefined);
    await first.abandon().catch(() => undefined);
    await db.close();
  }
});
