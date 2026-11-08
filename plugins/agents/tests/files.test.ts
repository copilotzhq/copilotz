/**
 * Files on messages: what they are rides on the message; their content is a
 * blob (content-addressed, in the store or a bucket); agents read text files'
 * content, are shown images and PDFs when their model reads them, read what
 * audio says (transcribed as it's sent), and see the rest by name.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createRuntime, defineAction, definePlugin, type Store } from "../../../runtime/mod.ts";
import { isBlobRef } from "../../../runtime/blobs.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { httpBlobs } from "../../../stores/blobs/http/mod.ts";
import models, { type LlmAdapter, type Transcript } from "../../models/mod.ts";
import { chat, type File, type FileAbout, type Message, type Prompt } from "../chat/mod.ts";
import { serve, tempFile, test } from "../../../testing/mod.ts";
import { attached } from "./fixtures/files.ts";

const quiet: LlmAdapter = {
  async *generate() {
    yield { type: "text", text: "Got it." };
  },
};
const app = definePlugin({
  name: "app",
  resources: {
    provider: { q: { adapter: "q" } },
    agents: { lead: { instructions: "Hi.", model: "q/lead", default: true } },
  },
  adapters: { llm: { q: quiet } },
});
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
};

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: a message's files: the agent reads text, sees the rest by name`, async () => {
    const store = await make();
    const runtime = await createRuntime({ store, plugins: [models, chat, app] });
    try {
      const big = "line of the report\n".repeat(6_000); // ~110 KB: a blob
      const { thread } = await runtime.call<{ thread: string }>("chat.send", {
        from: "ana",
        text: "Please look at these",
        files: await attached(runtime, [
          { name: "notes.txt", type: "text/plain", data: b64("Ship on Friday.") },
          { name: "report.txt", type: "text/plain", data: b64(big) },
          { name: "logo.png", type: "image/png", data: b64("\x89PNG...") },
        ]),
      });
      await runtime.idle();
      const [sent] = await runtime.query<Message[]>("message.history", { thread });
      assertEquals(sent.files!.map((f) => [f.name, f.type, f.size]), [
        ["notes.txt", "text/plain", 15],
        ["report.txt", "text/plain", big.length],
        ["logo.png", "image/png", 8],
      ]);
      const prompt = await runtime.query<Prompt>("thread.prompt", { thread, agent: "lead" });
      const said = JSON.stringify(prompt.history);
      assertStringIncludes(said, "[file notes.txt]\\nShip on Friday.\\n[end of notes.txt]");
      assertStringIncludes(said, "[…cut]");
      // An image goes as it is, named in the text; the models plugin decides, by model, whether it's shown.
      assertStringIncludes(said, "[image logo.png]");
      assertStringIncludes(said, `"files":[{"name":"logo.png","type":"image/png"`);
      // The large one is kept as a blob; plugin code never sees the reference.
      const stored = await store.find("file", { name: "report.txt" });
      assert(isBlobRef(stored[0].data), JSON.stringify(stored[0].data).slice(0, 80));
    } finally {
      await runtime.close();
    }
  });
}

test("an agent's message with files: another plugin's document, or one given; each a file of the chat", async () => {
  const store = memoryStore();
  // A plugin keeping pictures as the models plugin keeps those it makes: `type` and `data`.
  const pictures = definePlugin({
    name: "pictures",
    collections: {
      picture: {
        schema: {
          type: "object",
          properties: { type: { type: "string" }, data: { type: "string" } },
        },
      },
    },
    actions: {
      "test.picture": defineAction({
        input: { type: "object" },
        run: async (ctx, input) => (await ctx.db.collection("picture").insertOne(input)).insertedId,
      }),
    },
  });
  const runtime = await createRuntime({ store, plugins: [models, chat, app, pictures] });
  const code = (p: Promise<unknown>) => p.then(() => "said", (e) => e.code);
  try {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      from: "ana",
      text: "Make me a logo",
    });
    await runtime.idle();
    const logo = b64("\x89PNG" + "pixels".repeat(5_000)); // ~40 KB: a blob
    const picture = await runtime.call<string>("test.picture", { type: "image/png", data: logo });
    const say = {
      id: "logo-1",
      thread,
      from: "lead",
      files: [
        { id: picture, collection: "picture" },
        { name: "brief.txt", type: "text/plain", data: b64("Round, blue.") },
      ],
    };
    const said = await runtime.call("chat.say", say);
    const id = `${thread}:say:logo-1`;
    assertEquals(said, { message: id, files: [`${id}:file.0`, `${id}:file.1`] });
    // Said again: nothing new.
    assertEquals(await runtime.call("chat.say", say), said);
    const history = await runtime.query<Message[]>("message.history", { thread });
    const posted = history.filter((m) => m.from === "lead" && m.files);
    assertEquals(posted.length, 1);
    assertEquals([posted[0].text, posted[0].to], ["", ["ana"]]);
    assertEquals(posted[0].files!.map((f) => [f.id, f.name, f.type, f.size]), [
      [`${id}:file.0`, "image.png", "image/png", 30_005],
      [`${id}:file.1`, "brief.txt", "text/plain", 12],
    ]);
    // A file of the chat, its content the picture's own blob: kept once.
    const [kept] = await store.find("file", { _id: `${id}:file.0` });
    const [made] = await store.find("picture", { _id: picture });
    assert(isBlobRef(kept.data));
    assertEquals([kept.thread, (kept.data as { $blob: string }).$blob], [
      thread,
      (made.data as { $blob: string }).$blob,
    ]);
    // Its next turn, the agent knows what it sent.
    const prompt = await runtime.query<Prompt>("thread.prompt", { thread, agent: "lead" });
    assertStringIncludes(JSON.stringify(prompt.history), "[sent: image.png, brief.txt]");
    // Refused before anything's said: what isn't there to read, what isn't a file, saying nothing.
    const refused = await Promise.all([
      { files: [{ id: "nope", collection: "picture" }] },
      { files: [{ id: picture, collection: "picture", data: logo }] },
      { files: [{ name: "x", type: "not a type", data: b64("x") }] },
      { files: [{ name: "x", type: "text/plain" }] },
      { text: " " },
    ].map((rest, i) =>
      code(runtime.call("chat.say", { id: `bad-${i}`, thread, from: "lead", ...rest }))
    ));
    assertEquals(refused, ["not_found", "invalid", "invalid", "invalid", "invalid"]);
  } finally {
    await runtime.close();
  }
});

test("blobs can live in a bucket, over HTTP", async () => {
  const bucket = new Map<string, { data: Uint8Array; type: string }>();
  const server = await serve(async (request) => {
    const id = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (request.headers.get("authorization") !== "Bearer t") {
      return new Response("no", { status: 401 });
    }
    if (request.method === "PUT") {
      bucket.set(id, {
        data: new Uint8Array(await request.arrayBuffer()),
        type: request.headers.get("content-type") ?? "",
      });
      return new Response(null, { status: 200 });
    }
    const found = bucket.get(id);
    return found
      ? new Response(found.data as BodyInit, { headers: { "content-type": found.type } })
      : new Response("missing", { status: 404 });
  });
  const blobs = httpBlobs({ url: server.url, headers: () => ({ authorization: "Bearer t" }) });
  const runtime = await createRuntime({
    store: memoryStore(),
    blobs,
    plugins: [models, chat, app],
  });
  try {
    const big = "x".repeat(50_000);
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      from: "ana",
      text: "here",
      files: await attached(runtime, [{ name: "big.txt", type: "text/plain", data: b64(big) }]),
    });
    await runtime.idle();
    assertEquals(bucket.size, 1);
    const prompt = await runtime.query<Prompt>("thread.prompt", { thread, agent: "lead" });
    assertStringIncludes(JSON.stringify(prompt.history), "xxxxxxxxxx");
    assertEquals(await blobs.get(`sha256-${"0".repeat(64)}`), null);
    const [file] = await runtime.query<File[]>("message.history", { thread }).then(() =>
      blobs.get([...bucket.keys()][0]).then((b) => [b])
    );
    assert(file && file.data.length > 0);
  } finally {
    await runtime.close();
    await server.close();
  }
});

/** An app whose agent answers with the fake model (it echoes, and names what it was shown). */
const echoing = (model: unknown, extra: Record<string, unknown> = {}) =>
  definePlugin({
    name: "app",
    resources: {
      agents: { lead: { instructions: "Hi.", model, default: true } },
      model: { transcribe: "fake/echo" },
      ...extra,
    },
  });

/** The agent's answer in a thread: its last message. */
async function answer(runtime: Awaited<ReturnType<typeof createRuntime>>, thread: string) {
  await runtime.idle();
  const said = await runtime.query<Message[]>("message.history", { thread });
  return said.at(-1)!;
}

const png = { name: "a.png", type: "image/png", data: b64("\x89PNG...") };

test("an image goes to a model that reads images; one that doesn't is told it isn't shown", async () => {
  for (
    const [model, sees] of [[{ model: "fake/echo", input: ["image"] }, true], ["fake/echo", false]]
  ) {
    const runtime = await createRuntime({
      store: memoryStore(),
      plugins: [models, chat, echoing(model)],
    });
    try {
      const { thread } = await runtime.call<{ thread: string }>("chat.send", {
        from: "ana",
        text: "What's this?",
        files: await attached(runtime, [png]),
      });
      const reply = (await answer(runtime, thread)).text ?? "";
      if (sees) assertStringIncludes(reply, "[saw a.png]");
      else assertStringIncludes(reply, "a.png isn't shown: this model can't read image files");
    } finally {
      await runtime.close();
    }
  }
});

test("audio is transcribed as it's sent; agents read what it says", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, echoing("fake/echo")],
  });
  try {
    const voice = { duration: 2_400, peaks: [0.1, 0.6, 0.3] };
    // A voice message may say nothing else.
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      from: "ana",
      files: await attached(runtime, [
        { name: "voice.m4a", type: "audio/mp4", data: b64("abcdef"), voice },
      ]),
    });
    const [sent] = await runtime.query<Message[]>("message.history", { thread });
    const id = sent.files![0].id;
    assertEquals(sent.files, [{
      id,
      name: "voice.m4a",
      type: "audio/mp4",
      size: 6,
      voice,
      transcript: "(A recording, 6 bytes.)",
    }]);
    assertStringIncludes((await answer(runtime, thread)).text ?? "", "(A recording, 6 bytes.)");
    // A voice message's conversation is titled by what it says.
    const [listed] = await runtime.query<{ first?: string }[]>("thread.recent");
    assertEquals(listed.first, "(A recording, 6 bytes.)");
    // And what it says is the file's.
    const file = await runtime.query<FileAbout>("file.about", { id });
    assertEquals([file.transcript, file.voice], ["(A recording, 6 bytes.)", voice]);
  } finally {
    await runtime.close();
  }
});

test("when transcribing fails nothing is sent; sent without transcribing, audio goes as it is", async () => {
  const deaf = definePlugin({
    name: "deaf",
    resources: { provider: { deaf: { adapter: "deaf" } }, model: { transcribe: "deaf/ear" } },
    adapters: {
      transcription: {
        deaf: { transcribe: (): Promise<Transcript> => Promise.reject(new Error("no signal")) },
      },
    },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, echoing("fake/echo"), deaf],
  });
  try {
    const audio = await attached(runtime, [{
      name: "note.webm",
      type: "audio/webm",
      data: b64("abc"),
    }]);
    const error = await assertRejects(
      () => runtime.call("chat.send", { from: "ana", text: "listen", files: audio }),
    );
    assertEquals((error as { code?: string }).code, "transcription_failed");
    assertStringIncludes((error as Error).message, "Couldn't transcribe note.webm: no signal");
    assertEquals(await runtime.query<unknown[]>("thread.recent"), []);
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      from: "ana",
      text: "listen",
      // The same upload: nothing was sent the first time.
      files: audio,
      transcribe: false,
    });
    const [sent] = await runtime.query<Message[]>("message.history", { thread });
    assertEquals(sent.files![0].transcript, undefined);
    assertStringIncludes((await answer(runtime, thread)).text ?? "", "[file note.webm: audio/webm");
    // A message with nothing to say, and nothing sent, isn't one.
    const empty = await assertRejects(() => runtime.call("chat.send", { from: "ana", text: " " }));
    assertEquals((empty as { code?: string }).code, "invalid");
  } finally {
    await runtime.close();
  }
});

test("a message's pictures reach the prompt however large together: each read on its own", async () => {
  /** Base64 of `size` bytes that look like nothing, the same each run. */
  const noise = (size: number, seed: number) => {
    let text = "";
    let x = seed;
    for (let i = 0; i < size; i++) {
      x = (x * 1_103_515_245 + 12_345) >>> 0;
      text += String.fromCharCode(x >>> 24);
    }
    return btoa(text);
  };
  // Pictures a tool made, kept on a message one at a time: together, more than one answer of the
  // owner's carries (16 MiB), each alone well within it.
  const pictures = definePlugin({
    name: "pictures",
    actions: {
      "test.picture": defineAction({
        input: { type: "object" },
        run: async (ctx, input: { thread: string; id: string; seed: number }) => {
          await ctx.db.collection("file").insertOne({
            _id: input.id,
            name: `${input.id}.png`,
            type: "image/png",
            size: 6_500_000,
            data: noise(6_500_000, input.seed),
            thread: input.thread,
            at: new Date().toISOString(),
          });
        },
      }),
      "test.shown": defineAction({
        input: { type: "object" },
        run: (ctx, input: { thread: string; files: string[] }) =>
          ctx.db.collection("message").insertOne({
            _id: `${input.thread}:shown`,
            thread: input.thread,
            from: "ana",
            to: ["lead"],
            text: "These two",
            files: input.files.map((id) => ({ id, name: `${id}.png`, type: "image/png", size: 1 })),
            at: new Date().toISOString(),
          }),
      }),
    },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, echoing({ model: "fake/echo", input: ["image"] }), pictures],
  });
  try {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      from: "ana",
      text: "hi",
    });
    await runtime.idle();
    for (const [id, seed] of [["p1", 3], ["p2", 5]] as const) {
      await runtime.call("test.picture", { thread, id, seed });
    }
    await runtime.call("test.shown", { thread, files: ["p1", "p2"] });
    const prompt = await runtime.query<Prompt>("thread.prompt", { thread, agent: "lead" });
    const shown = prompt.history.flatMap((m) => m.role === "user" ? m.files ?? [] : []);
    assertEquals(shown.map((f) => [f.name, f.data.length]), [
      ["p1.png", noise(6_500_000, 3).length],
      ["p2.png", noise(6_500_000, 5).length],
    ]);
    assertEquals(shown[1].data, noise(6_500_000, 5));
  } finally {
    await runtime.close();
  }
});

test("files of about 10 MB go, several in a message: each uploaded on its own, sent by id", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, echoing("fake/echo")],
  });
  try {
    // 9.5 MB each, 12.7 MB of base64: within what one call carries (16 MiB), alone. Three of them,
    // or one sent with what a call is given on record, are not.
    const bytes = (seed: number) => {
      let text = "";
      for (let i = 0; i < 9_500_000; i++) {
        text += String.fromCharCode((i * seed + (i >> 11)) & 0xff);
      }
      return btoa(text);
    };
    const datas = [3, 5, 7].map(bytes);
    const files = await attached(
      runtime,
      datas.map((data, i) => ({ name: `scan-${i}.bin`, type: "application/octet-stream", data })),
    );
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      from: "ana",
      text: "The scans",
      files,
    });
    const [sent] = await runtime.query<Message[]>("message.history", { thread });
    assertEquals(sent.files!.map((f) => [f.id, f.size]), files.map((f) => [f.id, 9_500_000]));
    // Its content, as uploaded.
    for (const [i, { id }] of files.entries()) {
      const content = (await runtime.bytes("file", { _id: id }, "data"))!;
      assertEquals(content.size, datas[i].length);
      assertEquals(new TextDecoder().decode(await content.read(0, 64)), datas[i].slice(0, 64));
    }
    // Sent, they're no one's drafts: sending them again is refused.
    const again = await assertRejects(() =>
      runtime.call("chat.send", { from: "ana", text: "again", files: [files[0]] })
    );
    assertEquals((again as { code?: string }).code, "not_found");
  } finally {
    await runtime.close();
  }
});
