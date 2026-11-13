/**
 * At the terminal: `/notes` opens a contact's chat's staff notes, and again
 * goes back; a line where a reply went says where, in chat's words; `/move`
 * says first who'll see a conversation there and what it drew on, and moves
 * it only with `yes`.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Writable } from "node:stream";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, notesOf, type Thread } from "../chat/mod.ts";
import { chatTerminal } from "../chat/terminal.ts";
import { terminalPlugin } from "../../interfaces/terminal/mod.ts";
import { terminalShell } from "../../interfaces/terminal/terminal.ts";
import { plain, terminal } from "../../../hosts/terminal/mod.ts";
import { access } from "../../access/mod.ts";
import { accessTerminal } from "../../access/spaces/terminal.ts";
import { join } from "../../access/tests/join.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

const echo: LlmAdapter = {
  async *generate() {
    yield { type: "text", text: "noted" };
  },
};

const app = definePlugin({
  name: "app",
  resources: {
    provider: { e: { adapter: "e" } },
    agents: { lead: { instructions: "Hi.", model: "e/lead", default: true } },
  },
  adapters: { llm: { e: echo } },
});

/** An agent's answer as its work recorded it: what other spaces it drew on. */
const seed = definePlugin({
  name: "seed",
  actions: {
    "test.seed": defineAction({
      input: { type: "object" },
      run: (ctx, input: { message: Record<string, unknown> }) =>
        ctx.as().db.collection("message").insertOne(input.message),
    }),
  },
});

/** One person's terminal, given what they type: what it printed. */
async function session(runtime: Runtime, me: Actor, lines: string[]) {
  const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: me });
  let out = "";
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        out += chunk.toString();
        done();
      },
    }),
    { columns: 140, isTTY: false },
  );
  await terminal({
    runtime,
    me: me.id,
    actor: me,
    space,
    stdout,
    input: (async function* () {
      yield* lines;
    })(),
  });
  return plain(out);
}

const open = () =>
  createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      terminalPlugin,
      seed,
      app,
      terminalShell,
      chatTerminal,
      accessTerminal,
    ],
  });

test("/notes opens a contact's chat's staff notes, and goes back", async () => {
  const runtime = await open();
  try {
    const { space: shop } = await runtime.call<{ space: string }>("space.create", {
      name: "Shop",
    }, { actor: ana });
    await runtime.call("contact.start", { id: "c-carla-01", in: shop, via: "web", name: "Carla" });
    const { thread: carlas } = await runtime.call<{ thread: string }>("contact.chat", {
      contact: "c-carla-01",
      in: shop,
    });
    const shown = await session(runtime, ana, [
      `/open ${carlas}`,
      "/notes",
      "a regular",
      "/notes",
    ]);
    assertStringIncludes(shown, "Staff notes: only your team sees them");
    assertStringIncludes(shown, "Back in the chat.");
    // What was said went into the notes, not the chat.
    const notes = await runtime.query<Thread[]>("thread.recent", {}, { actor: ana });
    assert(notes.some((t) => t._id === notesOf(carlas) && t.messages === 2));
  } finally {
    await runtime.close();
  }
});

test("a line where a reply went says where, in chat's words, never what it said", async () => {
  const runtime = await open();
  try {
    const { space: launch } = await runtime.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    await join(runtime, launch, bob, "editor", ana);
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      in: launch,
      text: "plan",
    }, { actor: ana });
    await runtime.idle();
    // As the migration leaves them: for Ana; for no one. No text: where it went, not a sentence.
    for (const [id, held] of [["h1:held", { for: "ana" }], ["u1:held", {}]] as const) {
      await runtime.call("test.seed", {
        message: {
          _id: id,
          thread,
          in: launch,
          from: "lead",
          to: [],
          held,
          at: new Date().toISOString(),
        },
      });
    }
    const shown = await session(runtime, bob, [`/open ${thread}`, "/history"]);
    assertStringIncludes(shown, "A reply only ana could see was moved to their Personal space.");
    assertStringIncludes(shown, "A reply only some here could see was held back.");
  } finally {
    await runtime.close();
  }
});

test("/move says who'll see it there and what it drew on, and moves it only with yes", async () => {
  const runtime = await open();
  try {
    const { space: launch } = await runtime.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    await join(runtime, launch, bob, "editor", ana);
    const { space: finance } = await runtime.call<{ space: string }>("space.create", {
      name: "Finance",
    }, { actor: ana });
    const { space: mine } = await runtime.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      in: mine,
      text: "budget?",
    }, { actor: ana });
    await runtime.idle();
    await runtime.call("test.seed", {
      message: {
        _id: "m-drew",
        thread,
        in: mine,
        from: "lead",
        to: ["ana"],
        text: "10k",
        drew: [finance],
        at: new Date().toISOString(),
      },
    });
    const asked = await session(runtime, ana, [`/open ${thread}`, "/move Launch"]);
    assertStringIncludes(
      asked,
      "Everyone in Launch (2) will see this whole conversation. It drew on Finance.",
    );
    assertStringIncludes(asked, "/move Launch yes moves it.");
    const still = await runtime.query<Thread[]>("thread.recent", { in: launch }, { actor: ana });
    assertEquals(still.map((t) => t._id), []);
    const moved = await session(runtime, ana, [`/open ${thread}`, "/move Launch yes"]);
    assertStringIncludes(moved, "Moved to Launch: its members see this conversation now.");
    const there = await runtime.query<Thread[]>("thread.recent", { in: launch }, { actor: bob });
    assertEquals(there.map((t) => t._id), [thread]);
  } finally {
    await runtime.close();
  }
});
