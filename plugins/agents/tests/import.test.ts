/**
 * Moving in: a conversation (`chat.import`) and memories (`memory.import`)
 * come from another app as they were, under the importer's ids, in a space:
 * who said what to whom and when, its files, its title; whom memories are
 * about, who wrote them and when. Nothing runs (no model is called), the
 * space's members read it and nobody else, and importing again replaces what
 * it made. Only the system imports.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Actor, createRuntime, definePlugin, type Store } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { access } from "../../access/mod.ts";
import { chat, type File, type Message, type Thread } from "../chat/mod.ts";
import { type Memory, memory } from "../memory/mod.ts";
import { tempFile, test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

/** Any model call fails the test: an import runs nothing. */
const calls: string[] = [];
const never: LlmAdapter = {
  // deno-lint-ignore require-yield
  async *generate({ connection }) {
    calls.push(connection.model);
    throw new Error("An import calls no model");
  },
};
const app = definePlugin({
  name: "app",
  resources: {
    provider: { q: { adapter: "q" } },
    agents: {
      lead: { instructions: "Help.", model: "q/lead", default: true },
      helper: { instructions: "Help too.", model: "q/helper" },
    },
    memory: { embedder: "hash/words" },
  },
  adapters: { llm: { q: never } },
});

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  sqlite: () => sqliteStore({ path: tempFile(".sqlite") }),
};

async function start(make: () => Store | Promise<Store>) {
  const store = await make();
  const runtime = await createRuntime({ store, plugins: [models, chat, memory, ...access, app] });
  const { space } = await runtime.call<{ space: string }>("space.create", { name: "Acme" }, {
    actor: ana,
  });
  return { store, runtime, space };
}

/** A conversation as another app had it: times with their zones, a voice note, a picture. */
const conversation = (space: string) => ({
  thread: "old-thread-1",
  in: space,
  title: "Launch plan",
  messages: [
    {
      id: "old-1",
      from: "ana",
      to: ["lead"],
      text: "When do we launch?",
      at: "2025-03-01T12:00:00Z",
    },
    // Another zone, the same moment plus a second.
    { id: "old-2", from: "lead", to: ["ana"], text: "On Friday.", at: "2025-03-01T09:00:01-03:00" },
    {
      id: "old-3",
      from: "ana",
      to: ["lead"],
      files: [{ name: "note.webm", type: "audio/webm", data: b64("sound"), transcript: "Ship it" }],
      at: "2025-03-01T12:01:00.250Z",
    },
    {
      id: "old-4",
      from: "lead",
      to: ["ana"],
      files: [{ name: "poster.png", type: "image/png", data: b64("\x89PNG poster") }],
      at: "2025-03-01T12:02:00Z",
    },
  ],
});

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: a conversation moves in as it was, read by the space's members alone`, async () => {
    const { runtime, space } = await start(make);
    try {
      // The system's alone.
      await assertRejects(() => runtime.call("chat.import", conversation(space), { actor: ana }));
      const answer = await runtime.call("chat.import", conversation(space));
      assertEquals(answer, { thread: "old-thread-1", messages: 4, files: 2 });
      await runtime.idle();
      assertEquals(calls, []);

      const read = await runtime.query<Message[]>("message.history", { thread: "old-thread-1" }, {
        actor: ana,
      });
      assertEquals(read.map((m) => [m._id, m.from, m.to, m.text, m.at]), [
        ["old-1", "ana", ["lead"], "When do we launch?", "2025-03-01T12:00:00.000Z"],
        ["old-2", "lead", ["ana"], "On Friday.", "2025-03-01T12:00:01.000Z"],
        ["old-3", "ana", ["lead"], "", "2025-03-01T12:01:00.250Z"],
        ["old-4", "lead", ["ana"], "", "2025-03-01T12:02:00.000Z"],
      ]);
      assertEquals(read[2].files, [{
        id: "old-3:file.0",
        name: "note.webm",
        type: "audio/webm",
        size: 5,
        transcript: "Ship it",
      }]);
      assert(read.every((m) => m.in === space && !m.turn));
      // Its files open for the space's members, as a person's do.
      const poster = await runtime.query<File | null>("file.content", { id: "old-4:file.0" }, {
        actor: ana,
      });
      assertEquals([poster?.data, poster?.in, poster?.at], [
        b64("\x89PNG poster"),
        space,
        "2025-03-01T12:02:00.000Z",
      ]);
      // Its thread: in the space, titled, to the space's default agent, with its summary.
      const [thread] = await runtime.query<(Thread & { last?: string })[]>("thread.recent", {
        in: space,
      }, { actor: ana });
      assertEquals(
        [thread._id, thread.title, thread.in, thread.agents, thread.messages, thread.opened],
        ["old-thread-1", "Launch plan", space, ["lead"], 4, "old-1"],
      );
      assertEquals([thread.latest, thread.at], ["old-4", "2025-03-01T12:02:00.000Z"]);
      // Nobody outside the space reads any of it.
      assertEquals(
        await runtime.query("message.history", { thread: "old-thread-1" }, { actor: bob }),
        [],
      );
      assertEquals(
        await runtime.query("file.content", { id: "old-4:file.0" }, { actor: bob }),
        null,
      );
    } finally {
      await runtime.close();
    }
  });
}

test("importing again replaces what it made; a long conversation comes in several calls", async () => {
  const { runtime, space, store } = await start(memoryStore);
  try {
    await runtime.call("chat.import", conversation(space));
    // Again, with one message corrected, and the rest of the conversation in a call of its own.
    const again = conversation(space);
    await runtime.call("chat.import", {
      ...again,
      messages: [
        { ...again.messages[0], text: "When do we launch, again?" },
        ...again.messages.slice(1),
      ],
    });
    await runtime.call("chat.import", {
      thread: "old-thread-1",
      agents: ["lead", "helper"],
      // When the other app last saw it move: later than its latest message (a rename).
      at: "2025-03-02T08:00:00Z",
      messages: [
        // A file it already has, by its id: its content, name and type, reused.
        {
          id: "old-5",
          from: "helper",
          to: ["ana"],
          files: [{ id: "old-4:file.0" }],
          at: "2025-03-01T12:03:00Z",
        },
      ],
    });
    const read = await runtime.query<Message[]>("message.history", { thread: "old-thread-1" }, {
      actor: ana,
    });
    assertEquals(read.length, 5);
    assertEquals(read[0].text, "When do we launch, again?");
    assertEquals(read[4].files?.map((f) => [f.id, f.name, f.type, f.size]), [
      ["old-5:file.0", "poster.png", "image/png", 12],
    ]);
    assertEquals((await store.find("file", {})).length, 3);
    const [thread] = await store.find("thread", { _id: "old-thread-1" }) as Thread[];
    assertEquals(
      [thread.messages, thread.opened, thread.latest, thread.at, thread.agents, thread.title],
      [5, "old-1", "old-5", "2025-03-02T08:00:00.000Z", ["lead", "helper"], "Launch plan"],
    );
    await runtime.idle();
    assertEquals(calls, []);
  } finally {
    await runtime.close();
  }
});

test("an import says when, in which space, and something", async () => {
  const { runtime, space } = await start(memoryStore);
  try {
    const one = (message: Record<string, unknown>, more: Record<string, unknown> = {}) =>
      runtime.call("chat.import", {
        thread: "t",
        in: space,
        messages: [{ id: "m", from: "ana", text: "Hi", at: "2025-03-01T12:00:00Z", ...message }],
        ...more,
      });
    // A time without its zone could be anywhere's.
    await assertRejects(() => one({ at: "2025-03-01T12:00:00" }), Error, "with its zone");
    await assertRejects(() => one({ at: "yesterday" }), Error, "with its zone");
    await assertRejects(() => one({ text: " " }), Error, "says something");
    await assertRejects(() => one({ files: [{ id: "nowhere" }] }), Error, 'no "nowhere"');
    await assertRejects(
      () => one({ files: [{ name: "a.txt", type: "text/plain" }] }),
      Error,
      "its `data`",
    );
    await one({});
    // A conversation moves between spaces with chat.move, never by an import.
    const { space: other } = await runtime.call<{ space: string }>("space.create", {
      name: "Other",
    }, { actor: ana });
    await assertRejects(() => one({}, { in: other }), Error, "chat.move");
  } finally {
    await runtime.close();
  }
});

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: memories move in as they were, in their space, and are recalled there`, async () => {
    const { runtime, space } = await start(make);
    try {
      const memories = {
        in: space,
        memories: [
          {
            id: "old-mem-1",
            text: "Ana's brand sells handmade ceramics.",
            about: "person:ana",
            by: "lead",
            at: "2025-02-01T10:00:00Z",
          },
          {
            id: "old-mem-2",
            text: "Ana prefers posting on weekday mornings.",
            about: "person:ana",
            by: "ana",
            core: true,
            at: "2025-02-03T10:00:00-03:00",
            updated: "2025-02-04T10:00:00Z",
          },
        ],
      };
      await assertRejects(() => runtime.call("memory.import", memories, { actor: ana }));
      await assertRejects(
        () =>
          runtime.call("memory.import", {
            memories: [{ ...memories.memories[0], about: "ana" }],
          }),
        Error,
      );
      assertEquals(await runtime.call("memory.import", memories), { memories: 2 });
      assertEquals(await runtime.call("memory.import", memories), { memories: 2 });
      const listed = await runtime.query<Memory[]>("memory.list", { in: space }, { actor: ana });
      assertEquals(listed.map((m) => [m._id, m.by, m.in, m.core ?? false, m.at, m.updated]), [
        ["old-mem-2", "ana", space, true, "2025-02-03T13:00:00.000Z", "2025-02-04T10:00:00.000Z"],
        ["old-mem-1", "lead", space, false, "2025-02-01T10:00:00.000Z", undefined],
      ]);
      assertEquals(await runtime.query("memory.list", { in: space }, { actor: bob }), []);
      // Embedded as they're kept (recall by meaning finds only what has a vector), recalled where
      // they were learned.
      const found = await runtime.query<Memory[]>("memory.relevant", {
        agent: "lead",
        thread: "",
        people: ["ana"],
        in: space,
        text: "what does the brand sell? ceramics",
      });
      assertEquals(found[0]?._id, "old-mem-1");
    } finally {
      await runtime.close();
    }
  });
}
