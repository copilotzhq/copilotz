/**
 * Archiving at the terminal: `/archive` puts the open conversation away (or
 * one listed, by number, or named by id), `/threads` leaves it out and
 * `/threads archived` lists it (with its staff notes), `/open` still finds
 * it, or its notes, by number or id, and `/restore` brings it back. What a
 * list showed is what archiving one of it checks: something said since, and
 * it stays.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Writable } from "node:stream";
import { type Actor, createRuntime, definePlugin, type Runtime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Thread } from "../chat/mod.ts";
import { chatTerminal } from "../chat/terminal.ts";
import { terminalPlugin } from "../../interfaces/terminal/mod.ts";
import { terminalShell } from "../../interfaces/terminal/terminal.ts";
import { plain, terminal } from "../../../hosts/terminal/mod.ts";
import { access } from "../../access/mod.ts";
import { accessTerminal } from "../../access/spaces/terminal.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

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

/**
 * Ana's terminal, given what she types: what it printed. A function among the
 * lines runs between them: someone else doing something meanwhile.
 */
async function session(runtime: Runtime, lines: (string | (() => Promise<unknown>))[]) {
  const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: ana });
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
    me: ana.id,
    actor: ana,
    space,
    stdout,
    input: (async function* () {
      for (const line of lines) {
        if (typeof line === "string") yield line;
        else await line();
      }
    })(),
  });
  return plain(out);
}

const listed = (runtime: Runtime, archived = false) =>
  runtime.query<Thread[]>("thread.recent", archived ? { archived: true } : {}, { actor: ana });

test("/archive puts a conversation away, /threads archived lists it, /restore brings it back", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      terminalPlugin,
      app,
      terminalShell,
      chatTerminal,
      accessTerminal,
    ],
  });
  try {
    const shown = await session(runtime, [
      "the plan for the quarter",
      "/new",
      "the launch party",
      "/archive",
      "/threads",
    ]);
    const [plan] = await listed(runtime);
    const [party] = await listed(runtime, true);
    assert(plan && party, "one listed, one archived");
    assertStringIncludes(shown, `Archived ${party._id.slice(0, 8)}`);
    // /threads lists the plan, not the party.
    const threads = shown.slice(shown.lastIndexOf("/threads"));
    assertStringIncludes(threads, plan._id.slice(0, 8));
    assert(!threads.includes(party._id.slice(0, 8)), threads);

    const again = await session(runtime, [
      "/threads archived",
      "/open 1",
      "/restore",
      "/threads",
      "/archive 1",
      `/open ${party._id.slice(0, 8)}`,
      "/restore",
    ]);
    const archived = again.slice(again.indexOf("/threads archived"), again.indexOf("/open 1"));
    assertStringIncludes(archived, party._id.slice(0, 8));
    assert(!archived.includes(plan._id.slice(0, 8)), archived);
    assertStringIncludes(again, `Continuing ${party._id.slice(0, 8)}.`);
    assertStringIncludes(again, `Restored ${party._id.slice(0, 8)}`);
    // The newest first: the party, restored, is 1 again; archived by number, then found by id.
    assertStringIncludes(again, `Archived ${party._id.slice(0, 8)}`);
    assertEquals(again.split(`Continuing ${party._id.slice(0, 8)}.`).length, 3);
    assertEquals(again.split(`Restored ${party._id.slice(0, 8)}`).length, 3);
    assertEquals((await listed(runtime)).map((t) => t._id).sort(), [party._id, plan._id].sort());
    assertEquals(await listed(runtime, true), []);
  } finally {
    await runtime.close();
  }
});

const runtimeOf = () =>
  createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      terminalPlugin,
      app,
      terminalShell,
      chatTerminal,
      accessTerminal,
    ],
  });

// Review L3: an archived chat's notes were in no list, so /open <notes-id> found nothing.
test("an archived chat's notes are listed with it, and open by their id", async () => {
  const runtime = await runtimeOf();
  try {
    const { space: shop } = await runtime.call<{ space: string }>("space.create", {
      name: "Shop",
    }, { actor: ana });
    await runtime.call("contact.start", { id: "c-carla-01", in: shop, via: "web", name: "Carla" });
    const { thread: carlas } = await runtime.call<{ thread: string }>("contact.chat", {
      contact: "c-carla-01",
      in: shop,
    });
    const { thread: notes } = await runtime.call<{ thread: string }>("chat.notes", {
      thread: carlas,
    }, { actor: ana });
    await runtime.call("chat.send", { thread: notes, text: "a regular", to: [] }, { actor: ana });
    await runtime.call("chat.archive", { thread: carlas, archived: true }, { actor: ana });
    assertEquals((await listed(runtime, true)).map((t) => t._id).sort(), [carlas, notes].sort());
    await session(runtime, [`/open ${notes}`]);
    const { open } = await runtime.query<{ open?: { item: { _id: string } } }>("shell.mine", {
      person: ana.id,
    }, { actor: ana });
    assertEquals(open?.item._id, notes);
  } finally {
    await runtime.close();
  }
});

// Review L4: /archive said nothing of what it showed, so what came after a list went away unseen.
test("/archive <n> checks what /threads showed of it: a message since, and it stays", async () => {
  const runtime = await runtimeOf();
  try {
    await session(runtime, ["the plan for the quarter"]);
    const [plan] = await listed(runtime);
    const shown = await session(runtime, [
      "/threads",
      () =>
        runtime.call("chat.send", { thread: plan._id, text: "and the budget", to: [] }, {
          actor: ana,
        }),
      "/archive 1",
      "/threads",
      "/archive 1",
    ]);
    assertStringIncludes(shown, "Something new was said in it");
    assertEquals((await listed(runtime, true)).map((t) => t._id), [plan._id]);
  } finally {
    await runtime.close();
  }
});
