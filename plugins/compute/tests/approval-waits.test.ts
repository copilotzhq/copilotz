/**
 * A yes an agent's turn waits for: the call that needs it asks its person and
 * the turn pauses, as it does for the messages it sends; once answered (on the
 * card, a reply to the agent's question), the same turn goes on, the call
 * running as itself, after the answer. So an agent another one asked answers
 * it, whatever it needed a yes for; several asks in one step wait together and
 * resume once; a yes in this conversation answers what else it covers; and an
 * answer can't come before the question is written.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { type Approval, chat, type Message, type Step, tool } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { computers, type Desk } from "../mod.ts";
import { WORK } from "../computers/shared/workloads.ts";
import { test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** What a step of a scripted agent does: say something, message agents, run commands, hold. */
type Move = { text?: string; send?: Record<string, unknown>[]; run?: string[]; hold?: boolean };

/**
 * Agents as scripts: north asks east what ana says ("ask east to run df"),
 * then says what east answered; east runs what it's asked ("run df and ls"),
 * then says what its tool answered.
 */
const scripts: Record<string, (messages: LlmMessage[]) => Move> = {
  north: (messages) => {
    const last = messages.at(-1)!;
    // "…twice…": two messages at once; "…here": in the conversation, else a side thread.
    const asked = text(last).match(/ask east (twice )?to (.+?)( here)?$/);
    if (asked) {
      const one = { to: "east", text: asked[2], in: asked[3] ? "thread" : "subthread" };
      return { send: asked[1] ? [one, one] : [one] };
    }
    return { text: `north heard: ${text(last)}` };
  },
  east: (messages) => {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      const results = messages.slice(messages.findLastIndex((m) => m.role === "assistant") + 1);
      return { text: `tool said: ${results.map(text).join(" | ")}` };
    }
    const asked = /^north: run (.+)$/;
    const from = [...messages].reverse().find((m) => m.role === "user" && asked.test(text(m)));
    const command = text(from!).match(asked)![1];
    const hold = command.endsWith(" and hold");
    return { run: command.replace(/ and hold$/, "").split(" and "), hold };
  },
};

async function setup(
  fn: (s: {
    rt: Awaited<ReturnType<typeof createRuntime>>;
    space: string;
    calls: Record<string, number>;
    gate: { release(): void };
    pending(): Promise<Approval[]>;
    ran(): string[];
    history(thread: string): Promise<Message[]>;
    answer(approval: Approval, answer: string): Promise<unknown>;
  }) => Promise<void>,
) {
  const topic = `approval-waits.${crypto.randomUUID()}`;
  const calls: Record<string, number> = { north: 0, east: 0 };
  let release!: () => void;
  let held = new Promise<void>((r) => release = r);
  const gate = {
    release: () => {
      release();
      held = new Promise<void>((r) => release = r);
    },
  };
  const script: LlmAdapter = {
    async *generate({ connection, messages }) {
      const agent = connection.model;
      calls[agent]++;
      const move = scripts[agent](messages);
      if (move.text) yield { type: "text", text: move.text };
      for (const [i, input] of (move.send ?? []).entries()) {
        yield {
          type: "tool_call",
          call: { id: `s${calls[agent]}.${i}`, name: "send_message", input },
        };
      }
      for (const [i, command] of (move.run ?? []).entries()) {
        yield {
          type: "tool_call",
          call: { id: `t${calls[agent]}.${i}`, name: "terminal", input: { command } },
        };
      }
      if (move.hold) {
        yield { type: "tool_call", call: { id: `h${calls[agent]}`, name: "hold", input: {} } };
      }
    },
  };
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      provider: { script: { adapter: "script" } },
      agents: {
        north: {
          instructions: "Lead.",
          model: "script/north",
          default: true,
          tools: ["send_message"],
        },
        east: { instructions: "Hands.", model: "script/east", tools: ["terminal", "hold"] },
      },
      tools: { hold: tool({ description: "Waits.", run: () => held.then(() => "held") }) },
    },
    adapters: { llm: { script } },
  });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, app],
    transports: [{ type: "in-process", config: { topic } }],
  });
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    // East answers there too, beside north.
    await rt.call("member.set", { space, member: { kind: "agent", id: "east" }, role: "editor" }, {
      actor: ana,
    });
    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    const computer = fakeComputer(topic, `code:${code}`);
    await computer.worker.ready;
    for (let i = 0; i < 300; i++) {
      if ((await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana }))[0]?.online) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await fn({
      rt,
      space,
      calls,
      gate,
      pending: () => rt.query<Approval[]>("approval.pending", {}, { actor: ana }),
      ran: () =>
        computer.asked.filter((a) => a.work === WORK.terminal).map((a) =>
          String((a.input as { stdin?: string }).stdin)
        ),
      history: (thread) => rt.query<Message[]>("message.history", { thread }, { actor: ana }),
      answer: async (approval, answer) => {
        await rt.call("chat.approve", { approval: approval._id, answer }, { actor: ana });
        await rt.idle();
      },
    });
    await computer.worker.stop();
  } finally {
    gate.release();
    await rt.close();
  }
}

const ask = async (s: Parameters<Parameters<typeof setup>[0]>[0], said: string) => {
  const { thread } = await s.rt.call<{ thread: string }>("chat.send", {
    text: said,
    in: s.space,
  }, { actor: ana });
  await s.rt.idle();
  return thread;
};

test("north asks east, east waits for ana's yes, and east's answer goes back to north", async () => {
  await setup(async (s) => {
    const thread = await ask(s, "ask east to run df");

    // East asked in the side thread, and both wait: nothing ran, nobody answered.
    const [asked] = await s.pending();
    assertEquals([asked.agent, asked.detail], ["east", "df"]);
    // A computer's answers, as ever: once, this conversation, always, or no; a yes beyond once
    // lets that kind of work on that computer.
    assertEquals(asked.answers, ["once", "thread", "always", "deny"]);
    assertStringIncludes(asked.covers!, "run commands on ");
    assert(asked.call && asked.question, "its own request, with its question");
    assertEquals(s.ran(), []);
    const side = await s.history(asked.thread);
    const question = side.find((m) => m._id === asked.question)!;
    assertEquals([question.from, question.to], ["east", ["ana"]]);
    assertStringIncludes(question.text!, "May I run this on your computer?");
    assertEquals([s.calls.north, s.calls.east], [1, 1]);

    // Her yes is a reply to it: the same turn goes on, the command runs once, after it.
    await s.answer(asked, "once");
    assertEquals(s.ran(), ["df"]);
    assertEquals(await s.pending(), []);
    const after = await s.history(asked.thread);
    const yes = after.find((m) => m.from === "ana" && m.replyTo === asked.question)!;
    assertEquals(yes.text, "Yes, this once: df");
    const again = after.find((m) =>
      m.from === "east" &&
      (m.toolCalls as Step[] | undefined)?.some((c) => c.id.endsWith(":answered"))
    )!;
    assert(again.at > yes.at, "it ran after the yes");
    assertStringIncludes((again.toolCalls as Step[])[0].output, "ran df");

    // East's answer is to north, who asked it; north goes on and answers ana. East never told ana.
    const told = after.find((m) => m.from === "east" && !m.private && m.to.includes("north"))!;
    assertStringIncludes(told.text!, "tool said: ");
    assertStringIncludes(told.text!, "ran df");
    assert(!after.some((m) => m.from === "east" && m.to.includes("ana") && m._id !== question._id));
    const main = await s.history(thread);
    const last = main.at(-1)!;
    assertEquals([last.from, last.to], ["north", ["ana"]]);
    assertStringIncludes(last.text!, "north heard: east");
    // One model call each to start, one each to go on: the yes started no turn of its own.
    assertEquals([s.calls.north, s.calls.east], [2, 2]);
  });
});

test("several asks in one step wait together, and the turn goes on once, as each was answered", async () => {
  await setup(async (s) => {
    await ask(s, "ask east to run df and ls and rm -rf tmp");
    const asked = await s.pending();
    assertEquals(asked.map((a) => a.detail).sort(), ["df", "ls", "rm -rf tmp"]);
    const by = (detail: string) => asked.find((a) => a.detail === detail)!;

    // Each answer checks off its own: nothing runs, and east isn't asked again, until the last.
    await s.answer(by("df"), "once");
    await s.answer(by("rm -rf tmp"), "deny");
    assertEquals([s.ran(), s.calls.east], [[], 1]);
    assertEquals((await s.pending()).map((a) => a.detail), ["ls"]);
    await s.answer(by("ls"), "once");

    // Then it goes on once: what was allowed ran, what wasn't says no.
    assertEquals(s.ran().sort(), ["df", "ls"]);
    assertEquals(s.calls.east, 2);
    const side = await s.history(by("df").thread);
    const said = side.find((m) => m.from === "east" && m.to.includes("north"))!;
    assertStringIncludes(said.text!, "ran df");
    assertStringIncludes(said.text!, "ran ls");
    assertStringIncludes(said.text!, "No: ana said no to run this on their computer: rm -rf tmp");
    assertEquals(s.calls.north, 2);
  });
});

test("a yes in this conversation answers the asks it covers: one answer, and the turn goes on", async () => {
  await setup(async (s) => {
    await ask(s, "ask east to run df and ls");
    const asked = await s.pending();
    assertEquals(asked.length, 2);
    await s.answer(asked[0], "thread");
    assertEquals(s.ran().sort(), ["df", "ls"]);
    assertEquals(await s.pending(), []);
    const side = await s.history(asked[0].thread);
    // Each said in the conversation, as hers.
    assertEquals(
      side.filter((m) => m.from === "ana" && m.replyTo).map((m) => m.text).sort(),
      ["Yes, for this conversation: df", "Yes, for this conversation: ls"],
    );
    assertEquals([s.calls.east, s.calls.north], [2, 2]);
  });
});

test("two of east's turns asking the same thing: each its own ask, one yes for both", async () => {
  await setup(async (s) => {
    await ask(s, "ask east twice to run df here");
    const asked = await s.pending();
    assertEquals(asked.map((a) => a.detail), ["df", "df"]);
    assert(asked[0].call !== asked[1].call, "each call its own");
    await s.answer(asked[0], "thread");
    assertEquals(s.ran(), ["df", "df"]);
    assertEquals(await s.pending(), []);
    // Both answered north, who went on once, with both.
    assertEquals([s.calls.east, s.calls.north], [4, 2]);
  });
});

test("a reply typed to the question isn't a yes: the call doesn't run, and the turn goes on", async () => {
  await setup(async (s) => {
    await ask(s, "ask east to run df");
    const [asked] = await s.pending();
    await s.rt.call("chat.send", {
      thread: asked.thread,
      to: ["east"],
      text: "not now",
      replyTo: asked.question,
    }, { actor: ana });
    await s.rt.idle();
    assertEquals(s.ran(), []);
    assertEquals(await s.pending(), []);
    const side = await s.history(asked.thread);
    const said = side.find((m) => m.from === "east" && m.to.includes("north"))!;
    assertStringIncludes(said.text!, 'Not run: ana answered "not now"');
    assertEquals([s.calls.east, s.calls.north], [2, 2]);
  });
});

test("an answer can't come before the question is written: a moment later, it goes", async () => {
  await setup(async (s) => {
    await s.rt.call("chat.send", { text: "ask east to run df and hold", in: s.space }, {
      actor: ana,
    });
    // East's step is still running (it holds): its ask is there, its question not yet.
    let asked: Approval | undefined;
    for (let i = 0; i < 300 && !asked; i++) {
      [asked] = await s.pending();
      if (!asked) await new Promise((r) => setTimeout(r, 10));
    }
    assert(asked, "it asked");
    const early = await assertRejects(() =>
      s.rt.call("chat.approve", { approval: asked!._id, answer: "once" }, { actor: ana })
    );
    assertEquals((early as { code?: string }).code, "busy");
    assertEquals((await s.pending()).length, 1);

    // Its step written, the answer goes, and the turn goes on.
    s.gate.release();
    await s.rt.idle();
    await s.answer(asked, "once");
    assertEquals(s.ran(), ["df"]);
    assertEquals([s.calls.east, s.calls.north], [2, 2]);
  });
});

test("a computer forgotten while a turn waits on it: the turn is told no, and goes on", async () => {
  await setup(async (s) => {
    await ask(s, "ask east to run df");
    const [asked] = await s.pending();
    await s.rt.call("computer.forget", { computer: asked.computer }, { actor: ana });
    await s.rt.idle();
    assertEquals(s.ran(), []);
    assertEquals(await s.pending(), []);
    const side = await s.history(asked.thread);
    assert(
      side.some((m) => m.from === "ana" && m.replyTo === asked.question && m.text === "No: df"),
    );
    const said = side.find((m) => m.from === "east" && m.to.includes("north"))!;
    assertStringIncludes(said.text!, "tool said: ");
    assertEquals([s.calls.east, s.calls.north], [2, 2]);
  });
});
