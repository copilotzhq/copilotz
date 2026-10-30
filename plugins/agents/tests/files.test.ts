/**
 * Files on messages: what they are rides on the message; their content is a
 * blob (content-addressed, in the store or a bucket); agents read text files'
 * content, are shown images and PDFs when their model reads them, read what
 * audio says (transcribed as it's sent), and see the rest by name.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createRuntime, definePlugin, type Store } from "../../../runtime/mod.ts";
import { isBlobRef } from "../../../runtime/blobs.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import { httpBlobs } from "../../../stores/blobs/http/mod.ts";
import models, { type LlmAdapter, type Transcript } from "../../models/mod.ts";
import { chat, type File, type Message, type Prompt } from "../chat/mod.ts";
import { serve, tempFile, test } from "../../../testing/mod.ts";

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
        files: [
          { name: "notes.txt", type: "text/plain", data: b64("Ship on Friday.") },
          { name: "report.txt", type: "text/plain", data: b64(big) },
          { name: "logo.png", type: "image/png", data: b64("\x89PNG...") },
        ],
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
      files: [{ name: "big.txt", type: "text/plain", data: b64(big) }],
    });
    await runtime.idle();
    assertEquals(bucket.size, 1);
    const prompt = await runtime.query<Prompt>("thread.prompt", { thread, agent: "lead" });
    assertStringIncludes(JSON.stringify(prompt.history), "xxxxxxxxxx");
    assertEquals(await blobs.get("sha256-nothing"), null);
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
        files: [png],
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
      files: [{ name: "voice.m4a", type: "audio/mp4", data: b64("abcdef"), voice }],
    });
    const [sent] = await runtime.query<Message[]>("message.history", { thread });
    assertEquals(sent.files, [{
      id: `${sent._id}:file.0`,
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
    // And its content, with what it says, is the file's.
    const file = await runtime.query<File>("file.content", { id: `${sent._id}:file.0` });
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
    const audio = { name: "note.webm", type: "audio/webm", data: b64("abc") };
    const error = await assertRejects(
      () => runtime.call("chat.send", { from: "ana", text: "listen", files: [audio] }),
    );
    assertEquals((error as { code?: string }).code, "transcription_failed");
    assertStringIncludes((error as Error).message, "Couldn't transcribe note.webm: no signal");
    assertEquals(await runtime.query<unknown[]>("thread.recent"), []);
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      from: "ana",
      text: "listen",
      files: [audio],
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
