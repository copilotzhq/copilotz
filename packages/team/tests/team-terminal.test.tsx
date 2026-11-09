/**
 * Agents people make, at the terminal: a manager makes one where they work
 * (`/agent`), has it answer there, makes it answer new chats, and takes out
 * another.
 */
import { assert, assertStringIncludes } from "@std/assert";
import { Writable } from "node:stream";
import { type Actor, createRuntime, definePlugin, type Runtime } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import models, { type LlmAdapter, type LlmMessage } from "copilotz/plugins/models";
import { chat } from "copilotz/plugins/agents";
import { chatTerminal } from "copilotz/plugins/agents/terminal";
import { team } from "../team/mod.ts";
import { terminalPlugin } from "copilotz/plugins/interfaces";
import { terminalShell } from "copilotz/plugins/interfaces/terminal";
import { plain, terminal } from "copilotz/terminal";
import { access } from "copilotz/plugins/access";
import { accessTerminal } from "copilotz/plugins/access/terminal";
import { test } from "copilotz/testing";

/** What was said last, past what contexts add each turn. */
const lastOf = (messages: LlmMessage[]) =>
  messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")));

const echo: LlmAdapter = {
  async *generate({ messages }) {
    const last = lastOf(messages);
    yield { type: "text", text: `ok: ${last && "text" in last ? last.text : ""}` };
  },
};

test("in a terminal, a manager makes an agent where they work, and has it answer there", async () => {
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      provider: { echo: { adapter: "echo" } },
      agents: { lead: { instructions: "Hi.", model: "echo/lead", default: true } },
    },
    adapters: { llm: { echo } },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      team,
      terminalPlugin,
      app,
      terminalShell,
      chatTerminal,
      accessTerminal,
    ],
  });
  try {
    const out = await session(runtime, "ana", [
      "/space Launch",
      "/agents",
      "/agent Maya: writes launch copy",
      "/agents",
      "@maya hello",
      "/default maya",
      "/remove agent:lead",
      "/agents",
    ]);
    assertStringIncludes(out, "● @lead");
    assertStringIncludes(out, "Maya works here now: @maya.");
    assertStringIncludes(out, "@maya Maya — writes launch copy");
    assertStringIncludes(out, "maya › ok: ana: @maya hello");
    assertStringIncludes(out, "@maya answers new chats here.");
    assert(out.trimEnd().endsWith("/default <name> answers new chats."), out);
    assertStringIncludes(out.slice(out.lastIndexOf("/agents")), "● @maya");
  } finally {
    await runtime.close();
  }
});

/** One person's terminal over `runtime`, running `lines`: what it printed. */
async function session(runtime: Runtime, me: string, lines: string[]) {
  const actor: Actor = { kind: "person", id: me };
  const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor });
  let out = "";
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        out += chunk.toString();
        done();
      },
    }),
    { columns: 120, isTTY: false },
  );
  const state = await runtime.query<{ space?: string }>("shell.mine", { person: me });
  await terminal({
    runtime,
    me,
    actor,
    ...(state.space ? {} : { space }),
    stdout,
    input: (async function* () {
      yield* lines;
    })(),
  });
  return plain(out);
}
