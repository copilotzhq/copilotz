/**
 * Agents' model calls on their person's plan (`claude-plan/…`), through its
 * CLI on a computer of theirs: a scripted computer stands in for the
 * program (see program-agents.test.ts for that). A turn's tool call ends a
 * step while the CLI waits; the next step sends the result and goes on with
 * the same answer. The next turn goes on in the same session with only
 * what's new. Someone with no plan signed in goes straight to the next model.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import process from "node:process";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type Message, tool } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { computers, type Desk } from "../mod.ts";
import { type PromptEvent, type PromptInput, WORK } from "../computers/shared/workloads.ts";
import { startComputer } from "../computers/program/computer.ts";
import { host, tempDir, test } from "../../../testing/mod.ts";
import { fakeCli } from "./fake-cli.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };
const cy: Actor = { kind: "person", id: "cy" };
const encoder = new TextEncoder();

const text = (i: number, said: string): PromptEvent => ({
  i,
  type: "update",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: said } },
});

/** What the CLI does with each step it's asked for. */
function cli(asked: PromptInput[]) {
  return (input: PromptInput): PromptEvent[] => {
    asked.push(input);
    if (input.results?.length) {
      // The tool's answer came: the same answer goes on from where it was.
      return [text(3, `Thanks: ${input.results[0].content}`), {
        i: 4,
        type: "done",
        stopReason: "end_turn",
        usage: { input: 100, output: 20 },
      }];
    }
    if (input.session) {
      return [text(0, "Again, from the same session."), {
        i: 1,
        type: "done",
        stopReason: "end_turn",
      }];
    }
    return [
      { i: 0, type: "session", session: "s-1" },
      text(1, "Let me look."),
      { i: 2, type: "call", call: { id: "c-1", name: "lookup", arguments: { who: "on call" } } },
    ];
  };
}

async function setup(
  fn: (s: {
    rt: Awaited<ReturnType<typeof createRuntime>>;
    asked: PromptInput[];
    history: (thread: string, actor: Actor) => Promise<Message[]>;
    send: (said: string, actor: Actor, thread?: string) => Promise<string>;
  }) => Promise<void>,
) {
  const topic = `engines-test.${crypto.randomUUID()}`;
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      agents: {
        north: {
          instructions: "Lead.",
          model: ["claude-plan/claude-haiku-5-5", "fake/echo"],
          default: true,
          tools: ["lookup"],
        },
      },
      tools: {
        lookup: tool({ description: "Looks up who's on call.", run: () => "Ana is on call" }),
      },
    },
  });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, app],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const asked: PromptInput[] = [];
  const answer = cli(asked);
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    const computer = fakeComputer(topic, `code:${code}`, {
      workloads: {
        [WORK.agentsStatus]: () =>
          encoder.encode(JSON.stringify([
            { engine: "claude", installed: true, signedIn: true, account: "ana@example.com" },
          ])),
        [WORK.agentsPrompt]: async ({ input }) => {
          const events = answer(JSON.parse(await new Response(input).text()) as PromptInput);
          return new ReadableStream<Uint8Array>({
            start(controller) {
              for (const event of events) {
                controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
              }
              controller.close();
            },
          });
        },
      },
    });
    await computer.worker.ready;
    for (let i = 0; i < 300; i++) {
      if ((await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana }))[0]?.online) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // Her plan, signed in there: what her settings show, and what calls go by.
    const shown = await rt.call<{ engines: Record<string, { signedIn: boolean }> }[]>(
      "computer.engines",
      {},
      { actor: ana },
    );
    assertEquals(shown[0].engines.claude?.signedIn, true);
    await fn({
      rt,
      asked,
      history: (thread, actor) => rt.query<Message[]>("message.history", { thread }, { actor }),
      send: async (said, actor, thread) => {
        const where = actor === ana
          ? { in: space }
          : await rt.call<{ space: string }>("space.personal", {}, { actor })
            .then(({ space }) => ({ in: space }));
        const sent = await rt.call<{ thread: string }>("chat.send", {
          text: said,
          ...(thread ? { thread } : where),
        }, { actor });
        await rt.idle();
        return sent.thread;
      },
    });
    await computer.worker.stop();
  } finally {
    await rt.close();
  }
}

test("a turn runs on its person's plan: a tool call ends a step, and the next goes on with its answer", async () => {
  await setup(async (s) => {
    const thread = await s.send("who's on call?", ana);
    const said = (await s.history(thread, ana)).filter((m) => m.from === "north");
    assertStringIncludes(said.map((m) => m.text ?? "").join(" "), "Let me look.");
    assertStringIncludes(said.at(-1)!.text!, "Thanks: ");
    assertStringIncludes(said.at(-1)!.text!, "Ana is on call");

    // Asked once afresh, with the agent's own instructions and tools, then again to go on.
    assertEquals(s.asked.length, 2);
    const [first, second] = s.asked;
    assertEquals([first.engine, first.model, first.session], [
      "claude",
      "claude-haiku-5-5",
      undefined,
    ]);
    assertStringIncludes(first.instructions, "Lead.");
    assert(first.tools.some((t) => t.name === "lookup"), "the agent's tools, as MCP's");
    assertStringIncludes(JSON.stringify(first.prompt), "who's on call?");
    assertEquals([second.session, second.id, second.from], ["s-1", first.id, 3]);
    assertEquals(second.results?.map((r) => r.id), ["c-1"]);
    assertStringIncludes(second.results![0].content, "Ana is on call");

    // The next turn goes on in the same session, given only what's new.
    await s.send("and tomorrow?", ana, thread);
    const third = s.asked[2];
    assertEquals(third.session, "s-1");
    assertStringIncludes(JSON.stringify(third.prompt), "and tomorrow?");
    assert(!JSON.stringify(third.prompt).includes("who's on call?"), "only what's new");
    const last = (await s.history(thread, ana)).at(-1)!;
    assertEquals([last.from, last.text], ["north", "Again, from the same session."]);
  });
});

test("someone with no plan signed in goes straight to the next model, and no computer is asked", async () => {
  await setup(async (s) => {
    const thread = await s.send("hello there", cy);
    const last = (await s.history(thread, cy)).at(-1)!;
    assertEquals(last.from, "north");
    assertStringIncludes(last.text ?? "", "hello there");
    assertEquals(s.asked.length, 0);
  });
});

test({
  name:
    "the computer program, end to end: she signs her plan in from the app, and north's turn runs on it, its tool call held",
  // The fake CLI is a shell script.
  ignore: process.platform === "win32",
  fn: async () => {
    const app = definePlugin({
      name: "app",
      resources: {
        shared: { thread: {}, message: {} },
        agents: {
          north: {
            instructions: "Lead.",
            model: ["claude-plan/claude-haiku-5-5", "fake/echo"],
            default: true,
            tools: ["lookup"],
          },
        },
        tools: {
          lookup: tool({ description: "Looks up who's on call.", run: () => "Ana is on call" }),
        },
      },
    });
    const rt = await createRuntime({
      store: memoryStore(),
      plugins: [models, chat, ...access, computers, app],
      transports: [{ type: "websocket", config: { path: "/oxian" } }],
    });
    const listener = await host(rt.hypervisor);
    const dir = tempDir();
    let computer: Awaited<ReturnType<typeof startComputer>> | undefined;
    try {
      const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
      const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
      computer = await startComputer({
        url: `http://127.0.0.1:${new URL(String(listener.url)).port}`,
        root: join(dir, "Copilotz"),
        statePath: join(dir, "computer.json"),
        code,
        name: "laptop",
        chromium: null,
        log: () => {},
        agents: {
          commands: {
            claude: fakeCli(dir, "claude", "./program-agents-claude.ts", join(dir, "claude.log")),
            codex: null,
            antigravity: null,
          },
        },
      });
      await computer.ready;
      const engines = () =>
        rt.call<
          { computer: string; online: boolean; engines: Record<string, { signedIn: boolean }> }[]
        >("computer.engines", {}, { actor: ana });
      for (let i = 0; i < 500 && !(await engines())[0]?.online; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const [laptop] = await engines();
      assertEquals(laptop.engines.claude?.signedIn, false);

      // Signing in from the app: the CLI's own sign-in runs there; the code she pastes goes to it.
      const login = (input?: Record<string, unknown>) =>
        rt.call<{ state: string; signedIn: boolean; url?: string }>("computer.engine.login", {
          computer: laptop.computer,
          engine: "claude",
          ...input,
        }, { actor: ana });
      let state = await login();
      for (let i = 0; i < 100 && !state.url && state.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        state = await login();
      }
      assert(state.url, "it said where to sign in");
      state = await login({ input: "good-code" });
      for (let i = 0; i < 100 && state.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        state = await login();
      }
      assertEquals([state.state, state.signedIn], ["done", true]);
      assertEquals((await engines())[0].engines.claude?.signedIn, true);

      // North's turn, on her plan: the CLI calls north's tool, which the turn runs, and goes on.
      const { thread } = await rt.call<{ thread: string }>("chat.send", {
        text: "call lookup {}",
        in: space,
      }, { actor: ana });
      await rt.idle();
      const last = (await rt.query<Message[]>("message.history", { thread }, { actor: ana }))
        .at(-1)!;
      assertEquals(last.from, "north");
      assertStringIncludes(last.text ?? "", "got ");
      assertStringIncludes(last.text ?? "", "Ana is on call");
    } finally {
      await computer?.stop();
      await rt.close();
      await listener.shutdown();
    }
  },
});
