/**
 * People by name: each person's profile is kept from what sign-in verified
 * (their name, else their email's name), anyone in the org reads names
 * through `profile.names`, and wherever an id would show (an agent's prompt,
 * a note written before names were known, a space's members) the name does.
 * A sign-in's id is never shown as a name.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../stores/sql/sqlite/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, type Prompt } from "../../agents/chat/mod.ts";
import { memory } from "../../agents/memory/mod.ts";
import { line, peopleOf } from "../../agents/memory/shared/scope.ts";
import { access, identity, idsIn, nameOf, namesOf, withNames } from "../mod.ts";
import { tempFile, test } from "../../../testing/mod.ts";

const ID = "google:113900649446232449762";
const ana: Actor = { kind: "person", id: ID };

test("a person shows by name, never by a sign-in's id; old text gets names for ids", () => {
  const names = { [ID]: "Ana Lima" };
  assertEquals(nameOf(ID, names), "Ana Lima");
  assertEquals(nameOf(`person:${ID}`, names), "Ana Lima");
  assertEquals(nameOf("agent:north"), "north");
  // Unknown: a plain id reads as itself; a sign-in's id says nothing.
  assertEquals(nameOf("ana"), "ana");
  assertEquals(nameOf("google:2240"), "someone");
  // Whole ids only.
  assertEquals(
    withNames(`${ID}'s cloud computer runs Linux; ${ID}0 isn't them.`, names),
    `Ana Lima's cloud computer runs Linux; ${ID}0 isn't them.`,
  );
  assertEquals(idsIn(`${ID} is testing with email:bob@x.com`), [ID, "email:bob@x.com"]);
  // Two of one name stay apart.
  assertEquals(namesOf([{ _id: "a:1234", name: "Ana" }, { _id: "b:5678", name: "Ana" }]), {
    "a:1234": "Ana (1234)",
    "b:5678": "Ana (5678)",
  });
  // A memory as an agent reads it, and the people it names.
  const note = { _id: "m1", text: `${ID} is testing.`, about: `person:${ID}`, by: "memory" };
  assertEquals(peopleOf(note), [ID, ID]);
  assertEquals(line(note as never, "lead", names), "- Ana Lima is testing. [m1]");
});

test("profiles follow sign-in, and anyone in the org reads names", async () => {
  const runtime = await createRuntime({ store: memoryStore(), plugins: [...access] });
  try {
    await runtime.call("person.set", { person: ID, name: "Ana Lima", email: "ana@example.com" });
    await runtime.call("person.set", { person: "github:7", email: "bob.s@example.com" });
    await runtime.idle();
    const names = (ids: string[]) =>
      runtime.query<Record<string, string>>("profile.names", { ids }, { actor: ana });
    assertEquals(await names([ID, "person:github:7", "nobody:1"]), {
      [ID]: "Ana Lima",
      "github:7": "bob.s",
    });
    // A new name follows.
    await runtime.call("person.set", { person: ID, name: "Ana L." });
    await runtime.idle();
    assertEquals(await names([ID]), { [ID]: "Ana L." });
    // No email in it, ever.
    assertEquals(JSON.stringify(await names([ID, "github:7"])).includes("@"), false);
  } finally {
    await runtime.close();
  }
});

test("someone known before profiles gets one when they come back", async () => {
  const path = tempFile(".sqlite");
  const before = await createRuntime({ store: await sqliteStore({ path }), plugins: [identity] });
  await before.call("person.set", { person: ID, name: "Ana Lima" });
  await before.close();
  const runtime = await createRuntime({ store: await sqliteStore({ path }), plugins: [...access] });
  try {
    const names = () =>
      runtime.query<Record<string, string>>("profile.names", { ids: [ID] }, { actor: ana });
    assertEquals(await names(), {});
    await runtime.call("space.personal", {}, { actor: ana });
    assertEquals(await names(), { [ID]: "Ana Lima" });
  } finally {
    await runtime.close();
  }
});

/** "remember! x" remembers x as core; anything else, "ok". */
const scripted: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
    const said = "text" in last ? last.text ?? "" : "";
    if (last.role === "tool") return yield { type: "text", text: "done" };
    const what = /remember! (.+)$/.exec(said);
    if (what) {
      return yield {
        type: "tool_call",
        call: { id: "m", name: "remember", input: { text: what[1], core: true } },
      };
    }
    yield { type: "text", text: "ok" };
  },
};

test("an agent's prompt names people, and notes that say ids read with names", async () => {
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {}, memory: {} },
      memory: { embedder: "hash/words" },
      provider: { s: { adapter: "s" } },
      agents: { lead: { instructions: "Hi.", model: "s/lead", default: true } },
    },
    adapters: { llm: { s: scripted } },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, memory, ...access, app],
  });
  try {
    await runtime.call("person.set", { person: ID, name: "Ana Lima" });
    const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: ana });
    // A note as one written before names were known: it says the id.
    await runtime.call("chat.send", {
      text: `remember! ${ID}'s cloud computer runs Linux`,
      in: space,
    }, {
      actor: ana,
    });
    await runtime.idle();
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      text: "what do you know?",
      in: space,
    }, { actor: ana });
    await runtime.idle();
    const prompt = await runtime.query<Prompt>("thread.prompt", { thread, agent: "lead" });
    const said = JSON.stringify(prompt);
    assertStringIncludes(said, "Ana Lima: what do you know?");
    assertStringIncludes(said, "Ana Lima's cloud computer runs Linux");
    assertStringIncludes(said, "Ana Lima's Personal space");
    assert(!said.includes(ID), "the prompt never says the id");
  } finally {
    await runtime.close();
  }
});
