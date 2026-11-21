/**
 * A job an agent starts in a chat tells it when it ends: as its person, in
 * that chat, with how it ended and the end of its output, and the agent
 * takes a turn. Not when it stopped the job itself, nor when it said not to;
 * when its person stops it from the panel, it's told it was stopped; and a
 * computer that went offline meanwhile, once back, says the job is gone.
 * The real computer program, over the web host's socket.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import process from "node:process";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type ToolContext } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import type { Approval, Message } from "../../agents/chat/mod.ts";
import { type Computer, computers, type Desk } from "../mod.ts";
import { tools } from "../computers/resources/tools.ts";
import { startComputer } from "../computers/program/computer.ts";
import type { Job } from "../computers/shared/workloads.ts";
import { host, tempDir, test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

const app = definePlugin({
  name: "app",
  resources: {
    shared: { thread: {}, message: {} },
    agents: {
      assistant: {
        instructions: "Hi.",
        model: "fake/echo",
        default: true,
        tools: ["start_job", "stop_job", "list_jobs"],
      },
    },
  },
  actions: {
    // A tool, as an agent's turn would run it (`turn`: with a turn to ask in, and be told in).
    "test.tool": defineAction({
      input: {
        type: "object",
        properties: {
          tool: { type: "string" },
          thread: { type: "string" },
          input: { type: "object" },
          turn: { type: "boolean" },
        },
      },
      allow: () => true,
      run: async (ctx, input) =>
        tools[input.tool!].run(input.input ?? {}, {
          ...await ctx.as().db.collection<{ in?: string }>("thread")
            .findOne({ _id: input.thread! })
            .then((t) => t?.in ? ctx.as({ ...ctx.actor!, in: t.in }) : ctx),
          agent: "assistant",
          thread: input.thread!,
          trigger: "test",
          ...(input.turn ? { ask: () => "asked" } : {}),
        } as ToolContext),
    }),
    // What the chat holds, and what's watched, for the test to look at.
    "test.records": defineAction({
      input: { type: "object", properties: { collection: { type: "string" } } },
      run: (ctx, input) => ctx.as().db.collection(input.collection!).find({}),
    }),
  },
});

async function until(check: () => Promise<boolean>, what: string, tries = 1_000) {
  for (let i = 0; i < tries && !await check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(await check(), what);
}

// bash's commands; the wait itself is the same on Windows.
test({
  name: "a job tells its agent in the chat when it ends, as its person, and the agent answers",
  ignore: process.platform === "win32",
  fn: async () => {
    const rt = await createRuntime({
      store: memoryStore(),
      plugins: [models, chat, ...access, computers, app],
      transports: [{ type: "websocket", config: { path: "/oxian" } }],
    });
    const listener = await host(rt.hypervisor);
    const options = {
      url: `http://127.0.0.1:${new URL(String(listener.url)).port}`,
      root: join(tempDir(), "Copilotz"),
      statePath: join(tempDir(), "computer.json"),
      chromium: null,
      log: () => {},
    };
    let computer: Awaited<ReturnType<typeof startComputer>> | undefined;
    try {
      const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
      const { thread } = await rt.call<{ thread: string }>("chat.send", {
        text: "hello",
        in: space,
      }, { actor: ana });
      await rt.idle();
      const tool = <R = unknown>(name: string, input: Record<string, unknown>, turn = true) =>
        rt.call<R>("test.tool", { tool: name, thread, input, turn }, { actor: ana });
      const records = <T>(collection: string) => rt.call<T[]>("test.records", { collection });
      const told = async (name: string) =>
        (await records<Message>("message")).filter((m) =>
          m.thread === thread && m.via?.kind === "job" && m.via.name === name
        );

      const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
      computer = await startComputer({ ...options, code });
      await computer.ready;
      const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
      await until(async () => (await mine())[0]?.online === true, "it came");
      // Jobs, always: asked once, outside a turn.
      await tool("start_job", { command: "true" }, false);
      const [asked] = await rt.query<Approval[]>("approval.pending", {}, { actor: ana });
      await rt.call("chat.approve", { approval: asked._id, answer: "always" }, { actor: ana });

      // A build: its answer says it'll be told; when it ends, it is, as Ana, and it answers.
      const build = await tool<Job & { note?: string }>("start_job", {
        command: "sleep 0.3; echo built; echo warned >&2; exit 3",
        name: "build",
      });
      assertStringIncludes(build.note ?? "", "You'll be told in this chat when it ends");
      await until(async () => (await told("build")).length === 1, "it was told");
      const [notice] = await told("build");
      assertEquals([notice.from, notice.to], ["ana", ["assistant"]]);
      assertStringIncludes(notice.text!, `Job "build" (${build.id}) ended after`);
      assertStringIncludes(notice.text!, "with exit code 3.");
      assertStringIncludes(notice.text!, "Its output ended with:\n```\nbuilt\n```");
      assertStringIncludes(notice.text!, "Its errors ended with:\n```\nwarned\n```");
      // Its turn: the agent answers it.
      await until(
        async () =>
          (await records<Message>("message")).some((m) =>
            m.from === "assistant" && m.replyTo === notice._id
          ),
        "the agent answered",
      );

      // One it stops itself, and one it said not to be told of: neither tells it.
      const nap = await tool<Job>("start_job", { command: "sleep 30", name: "nap" });
      const quiet = await tool<Job & { note?: string }>("start_job", {
        command: "exit 0",
        name: "quiet",
        notify: false,
      });
      assertEquals(quiet.note, undefined);
      assertEquals((await tool<Job>("stop_job", { id: nap.id })).running, false);
      // A job ending after them is told, so theirs would have been by now.
      await tool("start_job", { command: "sleep 0.2", name: "after" });
      await until(async () => (await told("after")).length === 1, "the later one was told");
      assertEquals([(await told("nap")).length, (await told("quiet")).length], [0, 0]);

      // Ana stops one from her panel: it's told it was stopped.
      const server = await tool<Job>("start_job", { command: "sleep 30", name: "server" });
      const [desk] = await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana });
      await rt.call("computer.work", {
        desk: desk._id,
        work: "jobs.stop",
        input: { id: server.id },
        as: "agent:assistant",
      }, { actor: ana });
      await until(async () => (await told("server")).length === 1, "the stop was told");
      assertStringIncludes(
        (await told("server"))[0].text!,
        `Job "server" (${server.id}) was stopped`,
      );

      // The computer stops while a job runs (its jobs with it); back, the job's gone: told so.
      const long = await tool<Job>("start_job", { command: "sleep 30", name: "long" });
      await computer.stop();
      await until(async () => (await mine())[0]?.online === false, "it went");
      assertEquals((await told("long")).length, 0, "not while it's away");
      computer = await startComputer(options);
      await computer.ready;
      await until(async () => (await told("long")).length === 1, "told once it was back");
      assertStringIncludes(
        (await told("long"))[0].text!,
        `Job "long" (${long.id}) is no longer on the computer`,
      );
      // Nothing's watched now.
      assertEquals(await records("jobWatch"), []);
    } finally {
      await computer?.stop();
      await listener.shutdown();
      await rt.close();
    }
  },
});
