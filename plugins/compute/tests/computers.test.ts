/**
 * Computers: a person connects theirs with a one-time code; their agents work
 * on it, in a folder for the conversation's space and a shell of their own;
 * running a command waits for the person's yes. Nobody else's agents reach
 * it, and nobody else sees it.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type Message, type Prompt, type ToolContext } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { type Approval, type Computer, computers, type Desk } from "../mod.ts";
import { tools } from "../computers/resources/tools.ts";
import { WORK } from "../computers/shared/workloads.ts";
import { test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

const app = definePlugin({
  name: "app",
  resources: {
    shared: { thread: {}, message: {} },
    agents: {
      assistant: {
        instructions: "Hi.",
        model: "fake/echo",
        default: true,
        tools: ["terminal", "write_file", "web_search"],
      },
    },
  },
  actions: {
    // A tool, as an agent's turn would run it.
    "test.tool": defineAction({
      input: {
        type: "object",
        properties: {
          tool: { type: "string" },
          thread: { type: "string" },
          input: { type: "object" },
        },
      },
      allow: () => true,
      run: (ctx, input) =>
        tools[input.tool!].run(input.input ?? {}, {
          ...ctx,
          agent: "assistant",
          thread: input.thread!,
          trigger: "test",
        } as ToolContext),
    }),
  },
});

async function setup(
  fn: (
    rt: Awaited<ReturnType<typeof createRuntime>>,
    topic: string,
  ) => Promise<void>,
) {
  const topic = `computers-test.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, app],
    transports: [{ type: "in-process", config: { topic } }],
  });
  try {
    await fn(rt, topic);
  } finally {
    await rt.close();
  }
}

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 300 && !await check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(await check(), what);
}

test("a person connects their computer with a code; it's told its secret, and comes back with it", async () => {
  await setup(async (rt, topic) => {
    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    assertEquals(code.length, 9);
    const computer = fakeComputer(topic, `code:${code}`);
    await computer.worker.ready;
    const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
    await until(async () => (await mine())[0]?.online === true, "it came");
    const [connected] = await mine();
    assertEquals([connected.name, connected.owner, connected.secret], [
      "testbox",
      "ana",
      undefined,
    ]);
    assert(computer.credential().startsWith(`${connected._id}.`), "it was told its secret");
    // Nobody else sees it.
    assertEquals(await rt.query("computer.mine", {}, { actor: bob }), []);
    // It goes, and comes back with its secret; the code is spent.
    await computer.worker.stop();
    await until(async () => (await mine())[0]?.online === false, "it went");
    const again = fakeComputer(topic, computer.credential());
    await again.worker.ready;
    await until(async () => (await mine())[0]?.online === true, "it came back");
    assertEquals((await mine()).length, 1);
    await again.worker.stop();
    const reused = fakeComputer(topic, `code:${code}`);
    let refused = false;
    await reused.worker.ready.catch(() => refused = true);
    assert(refused, "a code works once");
    await reused.worker.stop().catch(() => {});
  });
});

test("a computer that lost its secret before keeping it comes back with its code, as itself", async () => {
  await setup(async (rt, topic) => {
    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
    const first = fakeComputer(topic, `code:${code}`, { lose: true });
    await first.worker.ready;
    await until(
      () => Promise.resolve(first.asked.some((a) => a.work === WORK.enrolled)),
      "it was told",
    );
    await first.worker.stop();
    // The same code again: the same computer, told its secret this time.
    const again = fakeComputer(topic, `code:${code}`);
    await again.worker.ready;
    await until(async () => (await mine())[0]?.online === true, "it came back");
    const [one, ...more] = await mine();
    assertEquals(more, []);
    assert(again.credential().startsWith(`${one._id}.`), "told its secret");
    await again.worker.stop();
    // Now the code is spent.
    const late = fakeComputer(topic, `code:${code}`);
    let refused = false;
    await late.worker.ready.catch(() => refused = true);
    assert(refused, "spent once it has its secret");
    await late.worker.stop().catch(() => {});
  });
});

test("an agent works on its space's computer, in the space's folder, once its person says yes", async () => {
  await setup(async (rt, topic) => {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: space,
    }, { actor: ana });
    await rt.idle();
    const tool = (name: string, input: Record<string, unknown>, actor = ana) =>
      rt.call<unknown>("test.tool", { tool: name, thread, input }, { actor });

    // What the agent knows of it each turn.
    const knows = async () =>
      (await rt.query<Prompt>("thread.prompt", { thread, agent: "assistant" }, { actor: ana }))
        .turn.map((c) => c.text).find((text) => text.startsWith('<context name="computer">')) ?? "";

    // No computer here yet.
    assertStringIncludes(
      String(await tool("terminal", { stdin: "ls" })),
      "There's no computer in this space",
    );
    assertStringIncludes(await knows(), "This space has no computer");

    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    const computer = fakeComputer(topic, `code:${code}`);
    await computer.worker.ready;
    await until(
      async () => (await rt.query<Computer[]>("computer.mine", {}, { actor: ana }))[0]?.online,
      "it came",
    );

    assertStringIncludes(
      await knows(),
      "You work on this space's computer, testbox (ana's own, testos)",
    );
    assertStringIncludes(await knows(), "answered with /approve");

    // A command waits for ana's yes; nothing ran.
    assertStringIncludes(String(await tool("terminal", { stdin: "ls" })), "Waiting for ana's yes");
    assertEquals(computer.asked.filter((a) => a.work === WORK.terminal), []);
    const [asked] = await rt.query<Approval[]>("approval.pending", {}, { actor: ana });
    assertEquals([asked.agent, asked.work, asked.detail], ["assistant", "terminal", "ls"]);
    assertEquals(await rt.query("approval.pending", {}, { actor: bob }), []);

    // Yes, in this conversation: her answer is in it, and the command runs, in her space's folder.
    await rt.call("computer.approve", { approval: asked._id, answer: "thread" }, { actor: ana });
    await rt.idle();
    const said = await rt.query<Message[]>("message.history", { thread }, { actor: ana });
    assert(said.some((m) => m.from === "ana" && m.text === "Yes, in this conversation: ls"));
    assertEquals(await tool("terminal", { stdin: "ls" }), {
      state: "idle",
      commandId: "c1",
      stdout: "ran ls",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      cwd: ".",
    });
    const ran = computer.asked.find((a) => a.work === WORK.terminal)!;
    assertEquals(ran.input.scope, { space: space, folder: "personal", who: "agent:assistant" });
    // Another command in this conversation needs no new yes.
    assertEquals(
      (await tool("terminal", { stdin: "pwd" }) as { stdout: string }).stdout,
      "ran pwd",
    );

    // Yes once: used up.
    await tool("write_file", { path: "a.txt", content: "hi" });
    const [write] = await rt.query<Approval[]>("approval.pending", {}, { actor: ana });
    await rt.call("computer.approve", { approval: write._id, answer: "once" }, { actor: ana });
    assertEquals(await tool("write_file", { path: "a.txt", content: "hi" }), { size: 2 });
    assertStringIncludes(
      String(await tool("write_file", { path: "a.txt", content: "hi" })),
      "Waiting for ana",
    );

    // Searching needs no yes.
    assertEquals(await tool("web_search", { query: "deno" }), [
      { title: "Deno", url: "https://deno.com", snippet: "A runtime" },
    ]);

    // An agent working for Bob, in Ana's conversation, doesn't reach her computer.
    assertStringIncludes(
      String(await tool("terminal", { stdin: "ls" }, bob)),
      "isn't one of yours",
    );

    // Ana's own work from the panel: her shell, in the space's folder.
    const [mine] = await rt.query<Computer[]>("computer.mine", {}, { actor: ana });
    const [desk] = await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana });
    assertEquals([desk.computer, desk.folder, desk.answers, desk.default], [
      mine._id,
      "personal",
      "asker",
      true,
    ]);
    await rt.call("computer.work", { desk: desk._id, work: "files.list", input: {} }, {
      actor: ana,
    });
    const listed = computer.asked.find((a) => a.work === WORK.filesList)!;
    assertEquals(listed.input.scope, { space: space, folder: "personal", who: "person:ana" });
    // Bob can't use it: it isn't in a space of his.
    const refused = await rt.call("computer.work", {
      desk: desk._id,
      work: "files.list",
      input: {},
    }, { actor: bob }).then(() => false, () => true);
    assert(refused, "not bob's");

    // It goes: agents are told it isn't there.
    await computer.worker.stop();
    await until(
      async () => !(await rt.query<Computer[]>("computer.mine", {}, { actor: ana }))[0]?.online,
      "it went",
    );
    assertStringIncludes(String(await tool("web_search", { query: "x" })), "testbox, is offline");
    assertStringIncludes(await knows(), "This space's computer, testbox, is offline");

    // Forgotten: what waited on it goes with it.
    assert((await rt.query<Approval[]>("approval.pending", {}, { actor: ana })).length > 0);
    await rt.call("computer.forget", { computer: mine._id }, { actor: ana });
    assertEquals(await rt.query("computer.mine", {}, { actor: ana }), []);
    assertEquals(await rt.query("approval.pending", {}, { actor: ana }), []);
  });
});

test("a computer shared into a space: its members' agents use it, and they answer for them", async () => {
  await setup(async (rt, topic) => {
    const cy: Actor = { kind: "person", id: "cy" };
    // Ana connects her computer (to her Personal space), and shares it into Launch.
    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    const computer = fakeComputer(topic, `code:${code}`);
    await computer.worker.ready;
    const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
    await until(async () => (await mine())[0]?.online === true, "it came");
    const [laptop] = await mine();
    const { space: launch } = await rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    await join(rt, launch, bob, "editor", ana);
    await join(rt, launch, { kind: "person", id: "cy" }, "viewer", ana);
    await rt.call("computer.share", { computer: laptop._id, in: launch }, { actor: ana });
    const [desk] = await rt.query<Desk[]>("desk.here", { in: launch }, { actor: bob });
    assertEquals([desk.name, desk.owner, desk.folder, desk.online], [
      "testbox",
      "ana",
      "launch",
      true,
    ]);

    // Bob's conversation there: his agent uses it, and asks him.
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: launch,
    }, { actor: bob });
    await rt.idle();
    const tool = (name: string, input: Record<string, unknown>) =>
      rt.call<unknown>("test.tool", { tool: name, thread, input }, { actor: bob });
    assertStringIncludes(String(await tool("terminal", { stdin: "ls" })), "Waiting for bob's yes");
    assertEquals(await rt.query("approval.pending", {}, { actor: ana }), []);
    const [asked] = await rt.query<Approval[]>("approval.pending", {}, { actor: bob });
    assertEquals([asked.owner, asked.for, asked.name], ["bob", "bob", "testbox"]);
    await rt.call("computer.approve", { approval: asked._id, answer: "thread" }, { actor: bob });
    await tool("terminal", { stdin: "ls" });
    const ran = computer.asked.find((a) => a.work === WORK.terminal)!;
    assertEquals(ran.input.scope, { space: launch, folder: "launch", who: "agent:assistant" });

    // Bob works there himself, in Launch's folder; Cy, a viewer, can't.
    await rt.call("computer.work", { desk: desk._id, work: "files.list", input: {} }, {
      actor: bob,
    });
    const listed = computer.asked.find((a) => a.work === WORK.filesList)!;
    assertEquals(listed.input.scope, { space: launch, folder: "launch", who: "person:bob" });
    const viewer = await rt.call("computer.work", { desk: desk._id, work: "files.list" }, {
      actor: cy,
    }).then(() => "ran", (error) => (error as { code?: string }).code);
    assertEquals(viewer, "forbidden");

    // It's still Ana's: Bob can't rename, forget or take it out of Launch.
    assertEquals(
      await rt.call("computer.rename", { computer: laptop._id, name: "mine" }, { actor: bob }),
      { renamed: false },
    );
    const unshared = await rt.call("computer.unshare", { desk: desk._id }, { actor: bob })
      .then(() => "done", (error) => (error as { code?: string }).code);
    assertEquals(unshared, "forbidden");

    // Ana keeps the yes to herself: Bob's agent now waits for her.
    await rt.call("computer.share", { computer: laptop._id, in: launch, answers: "owner" }, {
      actor: ana,
    });
    assertStringIncludes(
      String(await tool("write_file", { path: "a.md", content: "hi" })),
      "Waiting for ana's yes to change this file on ana's computer",
    );
    const [write] = await rt.query<Approval[]>("approval.pending", {}, { actor: ana });
    assertEquals([write.owner, write.for, write.detail, write.preview], [
      "ana",
      "bob",
      "write a.md",
      "hi",
    ]);
    assertEquals(await rt.query("approval.pending", {}, { actor: bob }), []);

    // Out of Launch: its agents have no computer there, and what waited on it goes.
    await rt.call("computer.unshare", { desk: desk._id }, { actor: ana });
    assertStringIncludes(
      String(await tool("terminal", { stdin: "ls" })),
      "There's no computer in this space",
    );
    assertEquals(await rt.query("approval.pending", {}, { actor: ana }), []);
    // Still in Ana's Personal space.
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const [home] = await rt.query<Desk[]>("desk.here", { in: personal }, { actor: ana });
    assertEquals(home.computer, laptop._id);
    // Moved to Design: there now, its folder named after it; not in her personal space.
    const { space: design } = await rt.call<{ space: string }>("space.create", { name: "Design" }, {
      actor: ana,
    });
    const taken = await rt.call("computer.move", { desk: home._id, to: design }, { actor: bob })
      .then(() => "done", (error) => (error as { code?: string }).code);
    assertEquals(taken, "invalid");
    await rt.call("computer.move", { desk: home._id, to: design }, { actor: ana });
    assertEquals(await rt.query("desk.here", { in: personal }, { actor: ana }), []);
    const [there] = await rt.query<Desk[]>("desk.here", { in: design }, { actor: ana });
    assertEquals([there.computer, there.folder, there.default], [laptop._id, "design", true]);
    await computer.worker.stop();
  });
});

test("a computer the app makes asking nothing (a cloud computer): its agents work on it at once", async () => {
  await setup(async (rt, topic) => {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: space,
    }, { actor: ana });
    await rt.idle();
    const { id } = await rt.call<{ id: string }>("computer.provision", {
      owner: "ana",
      name: "cloudbox",
      approve: [],
    });
    const { code } = await rt.call<{ code: string }>("computer.enrollment", { computer: id });
    const computer = fakeComputer(topic, `code:${code}`);
    await computer.worker.ready;
    await until(
      async () => (await rt.query<Computer[]>("computer.mine", {}, { actor: ana }))[0]?.online,
      "it came",
    );
    const [desk] = await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana });
    assertEquals(desk.approve, []);

    // The agent isn't told to wait for a yes, and its command runs at once.
    const prompt = await rt.query<Prompt>("thread.prompt", { thread, agent: "assistant" }, {
      actor: ana,
    });
    const knows = prompt.turn.map((c) =>
      c.text
    ).find((text) => text.startsWith('<context name="computer">')) ?? "";
    assertStringIncludes(knows, "You work on this space's computer, cloudbox");
    assert(!knows.includes("answered with /approve"), "nothing to approve");
    const ran = await rt.call<{ stdout?: string }>("test.tool", {
      tool: "terminal",
      thread,
      input: { stdin: "ls" },
    }, { actor: ana });
    assertEquals(ran.stdout, "ran ls");
    assertEquals(await rt.query("approval.pending", {}, { actor: ana }), []);

    await computer.worker.stop();
  });
});
