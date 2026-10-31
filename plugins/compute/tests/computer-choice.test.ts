/**
 * A space with several computers: an agent's computer tools use the default
 * unless they name another (`computer`: its name, any case, or part of it
 * when only one has it; or its id). An unknown or ambiguous name, or one
 * that's offline, is told with the computers to choose from. The agent's
 * context lists them all, each turn. A job is found on whichever computer
 * runs it, for its preview and its app.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { WorkerWorkHandler } from "@oxian/oxian-js";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type Prompt, type ToolContext } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { type Computer, computers, type Desk } from "../mod.ts";
import { tools } from "../computers/resources/tools.ts";
import { type Job, WORK } from "../computers/shared/workloads.ts";
import { test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };

const app = definePlugin({
  name: "app",
  resources: {
    shared: { thread: {}, message: {} },
    computers: { approve: [], previews: { domain: "preview.test", key: "k" } },
    agents: {
      assistant: {
        instructions: "Hi.",
        model: "fake/echo",
        default: true,
        tools: ["terminal", "list_jobs", "preview"],
      },
    },
  },
  actions: {
    // What another plugin asks for its agent (the apps plugin, publishing), as its turn would.
    "test.allowed": defineAction({
      input: { type: "object" },
      allow: () => true,
      run: (ctx, input) => ctx.call("computer.allowed", input),
    }),
    "test.tool": defineAction({
      input: {
        type: "object",
        properties: { tool: { type: "string" }, thread: { type: "string" }, input: {} },
      },
      allow: () => true,
      run: (ctx, input) =>
        tools[input.tool!].run((input.input ?? {}) as Record<string, unknown>, {
          ...ctx,
          agent: "assistant",
          thread: input.thread!,
          trigger: "test",
        } as ToolContext),
    }),
    "test.records": defineAction({
      input: { type: "object", properties: { collection: { type: "string" } } },
      run: (ctx, input) => ctx.as().db.collection(input.collection!).find({}),
    }),
  },
});

/** Which computers listed their jobs (by hostname). */
const listed: string[] = [];

/** Its jobs, as a computer lists them. */
const jobsOf = (hostname: string, jobs: Partial<Job>[]): Record<string, WorkerWorkHandler> => ({
  [WORK.jobsList]: () => {
    listed.push(hostname);
    return Promise.resolve(new TextEncoder().encode(JSON.stringify(jobs)));
  },
});

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 300 && !await check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(await check(), what);
}

/** Ana's Personal space with her computers (by hostname: the first the default), and a chat. */
async function setup(
  names: { hostname: string; jobs?: Partial<Job>[] }[],
  fn: (s: {
    rt: Awaited<ReturnType<typeof createRuntime>>;
    space: string;
    thread: string;
    machines: ReturnType<typeof fakeComputer>[];
    tool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
    desks: () => Promise<Desk[]>;
  }) => Promise<void>,
) {
  const topic = `computer-choice.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, app],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const machines: ReturnType<typeof fakeComputer>[] = [];
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    for (const [i, { hostname, jobs }] of names.entries()) {
      const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
      const machine = fakeComputer(topic, `code:${code}`, {
        info: { hostname },
        ...(jobs ? { workloads: jobsOf(hostname, jobs) } : {}),
      });
      machines.push(machine);
      await machine.worker.ready;
      await until(
        async () =>
          (await rt.query<Computer[]>("computer.mine", {}, { actor: ana })).filter((c) => c.online)
            .length === i + 1,
        `${hostname} came`,
      );
    }
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: space,
    }, { actor: ana });
    await rt.idle();
    await fn({
      rt,
      space,
      thread,
      machines,
      tool: (name, input) => rt.call("test.tool", { tool: name, thread, input }, { actor: ana }),
      desks: () => rt.query<Desk[]>("desk.here", { in: space }, { actor: ana }),
    });
  } finally {
    for (const machine of machines) await machine.worker.stop().catch(() => {});
    await rt.close();
  }
}

const ran = (answer: unknown) => (answer as { stdout?: string }).stdout;

test("an agent's tools use the default computer, or the one it names: by name, any case, part of it, or its id", async () => {
  await setup([{ hostname: "laptop" }, { hostname: "studio desktop" }], async (s) => {
    const [laptop, desktop] = s.machines;
    const terminalOf = (m: ReturnType<typeof fakeComputer>) =>
      m.asked.filter((a) => a.work === WORK.terminal).map((a) => a.input.stdin);

    assertEquals(ran(await s.tool("terminal", { stdin: "ls" })), "ran ls");
    assertEquals(
      ran(await s.tool("terminal", { stdin: "pwd", computer: "Studio Desktop" })),
      "ran pwd",
    );
    assertEquals(
      ran(await s.tool("terminal", { stdin: "whoami", computer: "desk" })),
      "ran whoami",
    );
    const studio = (await s.desks()).find((d) => d.name === "studio desktop")!;
    assertEquals(ran(await s.tool("terminal", { stdin: "id", computer: studio._id })), "ran id");
    assertEquals(terminalOf(laptop), ["ls"]);
    assertEquals(terminalOf(desktop), ["pwd", "whoami", "id"]);

    // A name it doesn't have: the agent is told what there is.
    const unknown = String(await s.tool("terminal", { stdin: "ls", computer: "server" }));
    assertStringIncludes(unknown, 'There\'s no computer called "server" in this space');
    assertStringIncludes(unknown, "laptop (online), studio desktop (online)");
  });
});

test("two computers of one name: the agent is told their ids, and one of them works", async () => {
  await setup([{ hostname: "box" }, { hostname: "box" }], async (s) => {
    const said = String(await s.tool("terminal", { stdin: "ls", computer: "box" }));
    assertStringIncludes(said, 'More than one of this space\'s computers is called "box"');
    const [, second] = await s.desks();
    assertStringIncludes(said, second._id);
    assertEquals(ran(await s.tool("terminal", { stdin: "ls", computer: second._id })), "ran ls");
  });
});

test("a named computer that's offline: the agent is told so, and which others it can use", async () => {
  await setup([{ hostname: "laptop" }, { hostname: "desktop" }], async (s) => {
    await s.machines[1].worker.stop();
    await until(
      async () => !(await s.desks()).find((d) => d.name === "desktop")!.online,
      "desktop went",
    );
    const said = String(await s.tool("terminal", { stdin: "ls", computer: "desktop" }));
    assertEquals(said, "desktop is offline: ana can start it again. Use another: laptop (online).");
  });
});

test("the agent's context lists the space's computers, the default first, and how to name another", async () => {
  await setup([{ hostname: "laptop" }, { hostname: "desktop" }], async (s) => {
    const prompt = await s.rt.query<Prompt>("thread.prompt", {
      thread: s.thread,
      agent: "assistant",
    }, { actor: ana });
    const context = prompt.turn.map((c) =>
      c.text
    ).find((t) => t.startsWith('<context name="computer">')) ?? "";
    assertStringIncludes(context, "This space has 2 computers");
    assertStringIncludes(context, "each takes `computer` (its name)");
    assertStringIncludes(
      context,
      "- laptop (the default): a machine, ana's own, testos (bash); online; nothing needs a yes.",
    );
    assertStringIncludes(context, "- desktop: a machine, ana's own, testos (bash); online;");
  });
  // One computer: as it was.
  await setup([{ hostname: "laptop" }], async (s) => {
    const prompt = await s.rt.query<Prompt>("thread.prompt", {
      thread: s.thread,
      agent: "assistant",
    }, { actor: ana });
    const context = prompt.turn.map((c) =>
      c.text
    ).find((t) => t.startsWith('<context name="computer">')) ?? "";
    assertStringIncludes(context, "You work on this space's computer, laptop (ana's own");
  });
});

test("a job is found on whichever computer runs it: its preview, and where its app is made from", async () => {
  const site = { id: "j1", name: "site", port: 3000, who: "agent:assistant", running: true };
  await setup(
    [{ hostname: "laptop", jobs: [] }, { hostname: "desktop", jobs: [site] }],
    async (s) => {
      const desktop = (await s.desks()).find((d) => d.name === "desktop")!;
      // Its jobs are listed where they run.
      listed.length = 0;
      await s.tool("list_jobs", { computer: "desktop" });
      assertEquals(listed, ["desktop"]);

      const link = String(await s.tool("preview", { job: "site" }));
      assertStringIncludes(link, "preview.test");
      const [preview] = await s.rt.call<{ computer: string; port: number }[]>("test.records", {
        collection: "preview",
      });
      assertEquals([preview.computer, preview.port], [desktop.computer, 3000]);

      // The apps plugin asks where a job's folder is: the computer running it.
      const where = await s.rt.call<{ computer: string }>("computer.scope", {
        in: s.space,
        who: "agent:assistant",
        job: "site",
      });
      assertEquals(where.computer, desktop.computer);
      // Or the one named.
      const named = await s.rt.call<{ computer: string }>("computer.scope", {
        in: s.space,
        who: "agent:assistant",
        computer: "desktop",
      });
      assertEquals(named.computer, desktop.computer);

      // Publishing it is asked of whoever answers on that computer, its desk the approval's.
      const asked = await s.rt.call("test.allowed", {
        thread: s.thread,
        agent: "assistant",
        kind: "publish",
        detail: "site",
        computer: where.computer,
      }, { actor: ana });
      assertStringIncludes(String(asked), "yes");
      const [approval] = await s.rt.query<{ desk: string; work: string }[]>(
        "approval.pending",
        {},
        { actor: ana },
      );
      assertEquals([approval.work, approval.desk], ["publish", desktop._id]);
    },
  );
});
