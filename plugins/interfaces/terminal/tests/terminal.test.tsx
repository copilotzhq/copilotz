/**
 * The terminal: the `shell` View draws the screen from data (where you are,
 * the open conversation, what commands printed), through each plugin's
 * terminal Views; commands change where you are through an Action; what's
 * done prints once, in order, into the scrollback.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { Writable } from "node:stream";
import { Text } from "ink";
import { createRuntime, definePlugin, type Plugin } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../models/mod.ts";
import { chat } from "../../../agents/chat/mod.ts";
import { chatTerminal } from "../../../agents/chat/terminal.ts";
import { terminalPlugin } from "../mod.ts";
import { terminalShell } from "../terminal.ts";
import { command, plain, terminal } from "../../../../hosts/terminal/mod.ts";
import { test } from "../../../../testing/mod.ts";

const words: LlmAdapter = {
  async *generate() {
    for (const word of ["Hello", " there", "."]) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      yield { type: "text", text: word };
    }
  },
};

async function run(lines: string[], more: Plugin[] = []) {
  const app = definePlugin({
    name: "app",
    resources: {
      provider: { words: { adapter: "words" } },
      agents: { lead: { instructions: "Hi.", model: "words/lead", default: true } },
      commands: {
        "/raw": command({
          description: "Shows a record through the default View",
          run: (_, term) => term.show("anything", { name: "box", size: 3 }),
        }),
      },
    },
    adapters: { llm: { words } },
  });
  const store = memoryStore();
  const runtime = await createRuntime({
    store,
    plugins: [models, chat, terminalPlugin, app, terminalShell, chatTerminal, ...more],
  });
  let out = "";
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        out += chunk.toString();
        done();
      },
    }),
    { columns: 100, isTTY: false },
  );
  async function* input() {
    for (const line of lines) yield line;
  }
  try {
    await terminal({ runtime, me: "ana", banner: "my app", input: input(), stdout });
    return { printed: plain(out), store };
  } finally {
    await runtime.close();
  }
}

test("the screen prints the conversation from data, once, in order", async () => {
  const { printed, store } = await run(["hi", "/history", "/raw", "/nope", "/new"]);
  const lines = printed.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  assertEquals(lines.slice(0, 3), ["my app", "ana → lead › hi", "lead › Hello there."]);
  // The reply printed once as it was written, then again in /history.
  assertEquals(printed.split("Hello there.").length, 3);
  assertStringIncludes(printed, "ana › /history\n [1] ana → lead › hi\n [2] lead › Hello there.");
  // No View of its own: the default one, field by field.
  assertStringIncludes(printed, "name: box\nsize: 3");
  assertStringIncludes(printed, "Unknown command; /help lists them.");
  // Where you are is data: the conversation was open; /new closed it.
  assertEquals(await store.find("shell", {}), [{ _id: "ana" }]);
});

test("a plugin's terminal View replaces another's: here, who wrote a message", async () => {
  const loud = definePlugin({
    name: "loud",
    views: {
      author: { terminal: (m: { from: string }) => <Text>{`${m.from.toUpperCase()}: `}</Text> },
    },
  });
  const { printed } = await run(["hi"], [loud]);
  assertStringIncludes(printed, "ANA: hi\nLEAD: Hello there.");
});
