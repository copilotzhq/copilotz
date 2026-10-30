/**
 * Two people at one runtime's terminal: what each sees and may do follows
 * the spaces they reach. Ana's own conversation stays hers; one in a space
 * she invites Bob to, he reads; as a viewer he can't write there.
 */
import { assert, assertStringIncludes } from "@std/assert";
import { Writable } from "node:stream";
import {
  type Actor,
  createRuntime,
  defineCollection,
  definePlugin,
  type Runtime,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Thread, tool } from "../../agents/chat/mod.ts";
import { chatTerminal } from "../../agents/chat/terminal.ts";
import { team } from "../../agents/team/mod.ts";
import { terminalPlugin } from "../../interfaces/terminal/mod.ts";
import { terminalShell } from "../../interfaces/terminal/terminal.ts";
import { plain, terminal } from "../../../hosts/terminal/mod.ts";
import { access } from "../mod.ts";
import { accessTerminal } from "../spaces/terminal.ts";
import { test } from "../../../testing/mod.ts";

/** What was said last, past what contexts add each turn. */
const lastOf = (messages: LlmMessage[]) =>
  messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")));

const echo: LlmAdapter = {
  async *generate({ messages }) {
    const last = lastOf(messages);
    yield { type: "text", text: `ok: ${last && "text" in last ? last.text : ""}` };
  },
};

test("each person's terminal shows what they reach, and refuses what they can't do", async () => {
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
      terminalPlugin,
      app,
      terminalShell,
      chatTerminal,
      accessTerminal,
    ],
  });
  const session = async (me: string, lines: string[]) => {
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
    await terminal({
      runtime,
      me,
      actor,
      space,
      stdout,
      input: (async function* () {
        yield* lines;
      })(),
    });
    return plain(out);
  };
  try {
    // Bob signed in with his email; Ana invites it, and he accepts.
    await runtime.call("person.set", { person: "bob", email: "bob@example.com" });
    const ana = await session("ana", [
      "my diary",
      "/space Launch",
      "/invite bob viewer",
      "/invite bob@example.com viewer",
      "plan the launch",
    ]);
    const bob = await session("bob", [
      "/invitations",
      "/accept 1",
      "/threads",
      "/open 1",
      "/history",
      "can I help?",
    ]);
    assertStringIncludes(ana, "That isn't an email address.");
    assertStringIncludes(ana, "Invited bob@example.com; they join once they accept.");
    assertStringIncludes(bob, "[1] Launch (viewer, from ana)");
    assertStringIncludes(bob, "You're in, and work there now.");
    assertStringIncludes(bob, "plan the launch");
    assert(!bob.includes("my diary"), bob);
    assertStringIncludes(bob, "[1] ana → lead › plan the launch");
    // A viewer reads; writing there is refused, and nothing is sent.
    assertStringIncludes(bob, "✗");
    assertStringIncludes(bob, "out of your reach");
    assert(!bob.includes("bob → lead › can I help?"), bob);
    // Ana moves her diary into Launch, and Bob sees it there.
    const moved = await session("ana", ["/threads", "/open 2", "/move Launch"]);
    assertStringIncludes(moved, "Moved to Launch: its members see this conversation now.");
    assertStringIncludes(await session("bob", ["/threads"]), "my diary");
  } finally {
    await runtime.close();
  }
});

/**
 * A scripted model for notes: "note: x" writes a note where the conversation
 * is; "read <space>" reads that space's notes and answers with them.
 */
const scripted: LlmAdapter = {
  async *generate({ messages }) {
    const last = lastOf(messages)!;
    const said = "text" in last ? last.text ?? "" : "";
    if (last.role === "tool") return yield { type: "text", text: `Notes: ${said}` };
    const note = /note: (.+)$/.exec(said)?.[1];
    if (note) {
      return yield {
        type: "tool_call",
        call: { id: "w", name: "write_note", input: { text: note } },
      };
    }
    const space = /read (\w+)$/.exec(said)?.[1];
    if (space) {
      return yield { type: "tool_call", call: { id: "r", name: "read_notes", input: { space } } };
    }
    yield { type: "text", text: "ok" };
  },
};

test("an answer drawn from Finance stays with those who see Finance, until Ana shares it", async () => {
  const notes = definePlugin({
    name: "notes",
    collections: {
      note: defineCollection({
        schema: {
          type: "object",
          properties: { in: { type: "string" }, text: { type: "string" } },
        },
      }),
    },
    resources: {
      shared: { thread: {}, message: { labels: true }, note: {} },
      provider: { s: { adapter: "s" } },
      agents: {
        lead: {
          instructions: "Hi.",
          model: "s/lead",
          default: true,
          tools: ["write_note", "read_notes"],
        },
      },
      tools: {
        write_note: tool({
          description: "Write a note here.",
          input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          run: async ({ text }, ctx) => {
            const t = await ctx.db.collection<Thread>("thread").findOne({ _id: ctx.thread });
            await ctx.db.collection("note").insertOne({ in: t!.in, text });
            return "Noted.";
          },
        }),
        read_notes: tool({
          description: "Read a space's notes, by name.",
          input: { type: "object", properties: { space: { type: "string" } }, required: ["space"] },
          run: async ({ space }, ctx) => {
            const spaces = await ctx.db.collection("space").query<{ _id: string; name: string }[]>(
              "reached",
              {},
            );
            const id = spaces.find((p) => p.name.toLowerCase() === space.toLowerCase())?._id;
            const found = await ctx.db.collection<{ text: string }>("note").find({ in: id });
            return found.map((n) => n.text).join("; ") || "none";
          },
        }),
      },
    },
    adapters: { llm: { s: scripted } },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      terminalPlugin,
      notes,
      terminalShell,
      chatTerminal,
      accessTerminal,
    ],
  });
  try {
    await runtime.call("person.set", { person: "bob", email: "bob@example.com" });
    await session(runtime, "ana", [
      "/space Finance",
      "note: budget is 10k",
      "/space Launch",
      "/invite bob@example.com viewer",
      "read finance",
    ]);
    const before = await session(runtime, "bob", [
      "/invitations",
      "/accept 1",
      "/threads",
      "/open 1",
      "/history",
    ]);
    assertStringIncludes(before, "ana → lead › read finance");
    assert(!before.includes("budget is 10k"), before);
    const shared = await session(runtime, "ana", ["/history", "/share"]);
    assertStringIncludes(shared, "uses ");
    assertStringIncludes(shared, "Shared: everyone here sees what came from");
    const after = await session(runtime, "bob", ["/history"]);
    assertStringIncludes(after, "lead → ana › Notes: budget is 10k");
  } finally {
    await runtime.close();
  }
});

test("an agent asks a space's managers to let its person in; a manager grants it", async () => {
  const asks: LlmAdapter = {
    async *generate({ messages }) {
      const last = lastOf(messages)!;
      if (last.role === "tool") {
        return yield { type: "text", text: "text" in last ? last.text ?? "" : "" };
      }
      yield {
        type: "tool_call",
        call: {
          id: "q",
          name: "request_access",
          input: { space: "Finance", reason: "to see the budget" },
        },
      };
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      provider: { a: { adapter: "a" } },
      agents: { lead: { instructions: "Hi.", model: "a/lead", default: true } },
    },
    adapters: { llm: { a: asks } },
  });
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
    await session(runtime, "ana", ["/space Finance"]);
    const asked = await session(runtime, "bob", ["I need the Finance budget", "/spaces"]);
    assertStringIncludes(asked, "Asked Finance's managers to let bob in");
    assert(!asked.includes("Finance ·"), asked);
    const granted = await session(runtime, "ana", ["/requests", "/grant 1"]);
    assertStringIncludes(granted, "bob → ");
    assertStringIncludes(granted, "(lead: to see the budget)");
    assertStringIncludes(granted, "bob is in.");
    assertStringIncludes(await session(runtime, "bob", ["/spaces"]), "Finance");
  } finally {
    await runtime.close();
  }
});

test("one terminal, two people: /as hands it to someone else, in their own space", async () => {
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      provider: { e: { adapter: "e" } },
      agents: { lead: { instructions: "Hi.", model: "e/lead", default: true } },
    },
    adapters: { llm: { e: echo } },
  });
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
  const become = async (name: string) => {
    const actor: Actor = { kind: "person", id: name };
    const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor });
    return { actor, space };
  };
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
  try {
    await runtime.call("person.set", { person: "bob", email: "bob@example.com" });
    await terminal({
      runtime,
      me: "ana",
      ...await become("ana"),
      become,
      stdout,
      input: (async function* () {
        yield* [
          "my diary",
          "/space Launch",
          "/invite bob@example.com viewer",
          "plan it",
          "/as bob",
          "/invitations",
          "/accept 1",
          "/threads",
        ];
      })(),
    });
    const [ana, bob] = plain(out).split("ana › /as bob");
    assertStringIncludes(ana, "ana → lead › my diary");
    assertStringIncludes(bob, "bob › /threads");
    assertStringIncludes(bob, "plan it");
    assert(!bob.includes("my diary"), bob);
  } finally {
    await runtime.close();
  }
});

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
