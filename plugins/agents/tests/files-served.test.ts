/**
 * Files served (`GET /files/<id>`, chat's route), of any size chat takes: a
 * recording of megabytes, a picture just past what one answer once carried
 * (1 MiB of base64), whole and in parts (ranges, as audio players ask), byte
 * for byte, wherever their blob is kept, streamed a part at a time. To
 * whoever may read them, and to a link signed for them; to nobody else.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  signLink,
  type Store,
} from "../../../runtime/mod.ts";
import type { Blobs } from "../../../runtime/blobs.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { fileBlobs } from "../../../stores/blobs/files/mod.ts";
import models from "../../models/mod.ts";
import { access } from "../../access/mod.ts";
import { chat, type FileAbout, type Message } from "../chat/mod.ts";
import { PART } from "../chat/routes/files.ts";
import { attached } from "./fixtures/files.ts";
import { tempDir, tempFile, test, TEST_ACTOR, testWho } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const LINKS = { origin: "https://app.test", secret: "links-secret-for-tests-0123456789abcdef" };

/** Bytes that look like nothing (a recording's): the same each run. */
function noise(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

/** Bytes as base64, as chat takes a file's content. */
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(text);
}

/** A recording of 5.6 MB; a picture whose base64 is just past 1 MiB; a few bytes. */
const LARGE = noise(5_600_000, 7);
const PAST = noise(786_433, 11);
const SMALL = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6]);

const places: Record<string, () => { store: Store | Promise<Store>; blobs?: Blobs }> = {
  memory: () => ({ store: memoryStore() }),
  sqlite: () => ({ store: sqliteStore({ path: tempFile(".sqlite") }) }),
  "files as blobs": () => ({ store: memoryStore(), blobs: fileBlobs({ dir: tempDir() }) }),
};

const app = definePlugin({
  name: "app",
  resources: {
    shared: { thread: {}, message: {}, file: {} },
    agents: { lead: { instructions: "Hi.", model: "fake/echo", default: true } },
    links: LINKS,
  },
  actions: {
    // A file uploaded more than a day ago.
    "test.age": defineAction({
      input: { type: "object" },
      run: (ctx, input: { id: string }) =>
        ctx.db.collection("file").updateOne({ _id: input.id }, {
          $set: { at: new Date(Date.now() - 86_400_001).toISOString() },
        }),
    }),
  },
});

/** Ana's message with the three files, each uploaded first, in her own space; each file's path. */
async function start(place: () => { store: Store | Promise<Store>; blobs?: Blobs }) {
  const { store, blobs } = place();
  const rt = await createRuntime({
    store: await store,
    ...(blobs ? { blobs } : {}),
    plugins: [models, chat, ...access, testWho, app],
  });
  const as = { actor: ana };
  const { space } = await rt.call<{ space: string }>("space.personal", {}, as);
  const { thread } = await rt.call<{ thread: string }>("chat.send", {
    text: "files",
    in: space,
    transcribe: false,
    files: await attached(rt, [
      { name: "call.wav", type: "audio/wav", data: base64(LARGE) },
      { name: "photo.jpg", type: "image/jpeg", data: base64(PAST) },
      { name: "a.png", type: "image/png", data: base64(SMALL) },
    ], as),
  }, as);
  const said = await rt.query<Message[]>("message.history", { thread }, as);
  const ids = said.flatMap((m) => m.files?.map((f) => f.id) ?? []);
  const paths = ids.map((id) => `/files/${encodeURIComponent(id)}`);
  /** A request for `path`, as `actor` (nobody, without), with these headers. */
  const get = (path: string, actor?: Actor, headers: Record<string, string> = {}, method = "GET") =>
    rt.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: { ...(actor ? { [TEST_ACTOR]: JSON.stringify(actor) } : {}), ...headers },
      }),
    );
  return { rt, ids, paths, get };
}

/** A response's body, and the parts it came in. */
async function body(response: Response): Promise<{ bytes: Uint8Array; parts: number[] }> {
  const reader = response.body!.getReader();
  const parts: number[] = [];
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value.length);
    chunks.push(value);
  }
  const bytes = new Uint8Array(parts.reduce((a, b) => a + b, 0));
  let at = 0;
  for (const chunk of chunks) bytes.set(chunk, (at += chunk.length) - chunk.length);
  return { bytes, parts };
}

for (const [name, place] of Object.entries(places)) {
  test(`${name}: a file of megabytes is served whole and in parts, byte for byte, streamed`, async () => {
    const { rt, paths: [large, past, small], ids, get } = await start(place);
    try {
      const whole = await get(large, ana);
      assertEquals(whole.status, 200);
      assertEquals(whole.headers.get("content-type"), "audio/wav");
      assertEquals(whole.headers.get("content-length"), String(LARGE.length));
      assertEquals(whole.headers.get("accept-ranges"), "bytes");
      const { bytes, parts } = await body(whole);
      assertEquals(bytes, LARGE);
      // A part at a time, none larger than a part: never the file in one piece.
      assert(parts.length >= Math.ceil(LARGE.length / PART), `${parts.length} parts`);
      assert(parts.every((n) => n <= PART), `parts of ${Math.max(...parts)}`);

      const head = await get(large, ana, {}, "HEAD");
      assertEquals([head.status, head.headers.get("content-length")], [200, String(LARGE.length)]);
      assertEquals(head.body, null);

      // Parts, as an audio player asks: its first bytes, a stretch from anywhere (across parts),
      // one across a part's edge, the end, the last bytes, and one past the end.
      const size = LARGE.length;
      const asked: [string, number, number][] = [
        ["0-1", 0, 1],
        ["1000001-2999998", 1_000_001, 2_999_998],
        [`${PART - 2}-${PART + 2}`, PART - 2, PART + 2],
        [`${size - 5}-`, size - 5, size - 1],
        ["-100", size - 100, size - 1],
        [`0-${size + 50}`, 0, size - 1],
      ];
      for (const [range, start, end] of asked) {
        const part = await get(large, ana, { range: `bytes=${range}` });
        assertEquals(part.status, 206, range);
        assertEquals(part.headers.get("content-range"), `bytes ${start}-${end}/${size}`, range);
        assertEquals(part.headers.get("content-length"), String(end - start + 1), range);
        assertEquals((await body(part)).bytes, LARGE.subarray(start, end + 1), range);
      }
      const beyond = await get(large, ana, { range: `bytes=${size}-` });
      assertEquals([beyond.status, beyond.headers.get("content-range")], [416, `bytes */${size}`]);

      // Just past 1 MiB of base64: what once came back as missing.
      const photo = await get(past, ana);
      assertEquals([photo.status, photo.headers.get("content-type")], [200, "image/jpeg"]);
      assertEquals((await body(photo)).bytes, PAST);
      assertEquals((await body(await get(small, ana))).bytes, SMALL);
      // What it is comes without its content.
      const about = await rt.query<FileAbout>("file.about", { id: ids[1] }, { actor: ana });
      assertEquals([about.name, about.size, "data" in about], ["photo.jpg", PAST.length, false]);
    } finally {
      await rt.close();
    }
  });
}

test("a file is theirs who may read it, and a link's signed for it; nobody else's", async () => {
  const { rt, paths: [large, , small], get } = await start(places.memory);
  try {
    // Nobody signed in, someone the file isn't shared with, no such file: alike.
    assertEquals((await get(large)).status, 404);
    assertEquals((await get(large, bob)).status, 404);
    assertEquals((await get(large, bob, { range: "bytes=0-1" })).status, 404);
    assertEquals((await get("/files/nope", ana)).status, 404);
    // A link signed for it opens it, whole, without anyone signed in (Meta fetching a picture).
    const link = new URL(await signLink(LINKS, large));
    const served = await get(link.pathname + link.search);
    assertEquals(served.status, 200);
    assertEquals((await body(served)).bytes, LARGE);
    // Altered, expired, signed for another file, or not signed: nothing.
    const altered = new URL(link);
    altered.searchParams.set("exp", String(Number(link.searchParams.get("exp")) + 60));
    const expired = new URL(await signLink(LINKS, large, {}, -60_000));
    const other = new URL(await signLink(LINKS, small));
    const forged = [
      altered.pathname + altered.search,
      expired.pathname + expired.search,
      large + other.search,
      `${large}?exp=${link.searchParams.get("exp")}&sig=forged`,
    ];
    for (const path of forged) assertEquals((await get(path)).status, 404, path);
    // Nor does a link make someone who can't read it able to.
    assertEquals((await get(large + other.search, bob)).status, 404);
  } finally {
    await rt.close();
  }
});

test("a file's content is plain base64, or it isn't uploaded", async () => {
  const { rt } = await start(places.memory);
  try {
    for (const data of [`${base64(SMALL)}\n`, `data:image/png;base64,${base64(SMALL)}`, "a b c"]) {
      const error = await assertRejects(() =>
        rt.call("chat.attach", { name: "a.png", type: "image/png", data }, { actor: ana })
      );
      assertEquals((error as { code?: string }).code, "invalid", data.slice(0, 30));
    }
  } finally {
    await rt.close();
  }
});

test("a file not sent yet is its uploader's alone, sent by their message only, gone after a day", async () => {
  const { rt, get } = await start(places.memory);
  const as = (actor: Actor) => ({ actor });
  const code = (call: Promise<unknown>) =>
    call.then(() => "done", (error) => (error as { code?: string }).code);
  try {
    const { space: hers } = await rt.call<{ space: string }>("space.personal", {}, as(ana));
    const { space: his } = await rt.call<{ space: string }>("space.personal", {}, as(bob));
    const [draft] = await attached(rt, [{
      name: "plan.txt",
      type: "text/plain",
      data: btoa("plan"),
    }], as(ana));
    const path = `/files/${encodeURIComponent(draft.id)}`;
    const about = (actor: Actor) =>
      rt.query<FileAbout | null>("file.about", { id: draft.id }, as(actor));
    // Nobody reads it before it's sent, its uploader neither: it's in no conversation yet.
    for (const who of [ana, bob]) {
      assertEquals(await about(who), null);
      assertEquals((await get(path, who)).status, 404);
    }
    // Nobody else sends it.
    const send = (actor: Actor, space: string, files: { id: string }[]) =>
      rt.call("chat.send", { text: "here", in: space, files }, as(actor));
    assertEquals(await code(send(bob, his, [draft])), "not_found");
    // Sent where she can't write, nothing's sent, and it's hers alone still: not theirs who are there.
    assert((await code(send(ana, his, [draft]))) !== "done");
    assertEquals(await about(bob), null);
    // Sent where she writes, it's the message's: whoever reads that reads it.
    assertEquals(await code(send(ana, hers, [draft])), "done");
    assertEquals((await about(ana))?.name, "plan.txt");
    assertEquals((await body(await get(path, ana))).bytes, new TextEncoder().encode("plan"));
    // Twenty at most wait to be sent, the oldest dropped past them; any a day old goes.
    const many = await attached(
      rt,
      Array.from({ length: 21 }, (_, i) => ({ name: `${i}.txt`, data: btoa(String(i)) })),
      as(ana),
    );
    assertEquals(await code(send(ana, hers, [many[0]])), "not_found");
    await rt.call("test.age", { id: many[1].id });
    assertEquals(await rt.call("chat.prune", {}), { gone: 1 });
    assertEquals(await code(send(ana, hers, [many[1]])), "not_found");
    assertEquals(await code(send(ana, hers, many.slice(2, 12))), "done");
  } finally {
    await rt.close();
  }
});
