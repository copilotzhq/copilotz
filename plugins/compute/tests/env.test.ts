/**
 * A space's environment: its managers set variables and secrets; members
 * read names and variables' values, never a secret's (sealed at rest); the
 * space's jobs and shells, a person's and an agent's, run with what its
 * computers get, and what's given over it; agents know the names.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type Prompt, type ToolContext } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { type Computer, computers, type Desk, type EnvVar } from "../mod.ts";
import { tools } from "../computers/resources/tools.ts";
import { WORK } from "../computers/shared/workloads.ts";
import { test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const KEY = "a long secret that seals the app's secrets at rest";

const app = definePlugin({
  name: "app",
  resources: {
    shared: { thread: {}, message: {} },
    computers: { approve: [], key: KEY },
    agents: {
      assistant: {
        instructions: "Hi.",
        model: "fake/echo",
        default: true,
        tools: ["terminal", "start_job"],
      },
    },
  },
  actions: {
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
    // What's kept, as the system reads it (the sealed value too).
    "test.read": defineAction({
      input: { type: "object", properties: { collection: { type: "string" } } },
      run: (ctx, input) => ctx.as().db.collection(input.collection!).find({}),
    }),
  },
});

async function setup(
  fn: (rt: Awaited<ReturnType<typeof createRuntime>>, topic: string) => Promise<void>,
) {
  const topic = `env-test.${crypto.randomUUID()}`;
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

const code = (error: unknown) => (error as { code?: string }).code;

test("a space's environment: its managers set it; a secret is sealed and never read; members see the rest", async () => {
  await setup(async (rt) => {
    const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: ana,
    });
    await join(rt, space, bob, "editor", ana);
    await rt.call("env.set", { in: space, name: "API_URL", value: "https://api.test" }, {
      actor: ana,
    });
    const secret = await rt.call<Record<string, unknown>>("env.set", {
      in: space,
      name: "API_KEY",
      value: "sk-live-0123456789abcdef",
      secret: true,
      computers: false,
    }, { actor: ana });
    // What it answers shows nothing of the secret but its last characters.
    assertEquals([secret.name, secret.value, secret.hint, "sealed" in secret], [
      "API_KEY",
      undefined,
      "••••cdef",
      false,
    ]);

    // Bob works here, but doesn't manage it.
    assertEquals(
      await rt.call("env.set", { in: space, name: "X", value: "1" }, { actor: bob }).then(
        () => "set",
        code,
      ),
      "forbidden",
    );
    assertEquals(
      await rt.call("env.unset", { in: space, name: "API_URL" }, { actor: bob }).then(
        () => "unset",
        code,
      ),
      "forbidden",
    );
    // A name the shell can use, only.
    assertEquals(
      await rt.call("env.set", { in: space, name: "api-url", value: "1" }, { actor: ana }).then(
        () => "set",
        code,
      ),
      "invalid",
    );

    // Members read names, and variables' values.
    const seen = await rt.query<EnvVar[]>("envVar.here", { in: space }, { actor: bob });
    assertEquals(seen.map((v) => [v.name, v.value, v.secret, v.computers, "sealed" in v]), [
      ["API_KEY", undefined, true, false, false],
      ["API_URL", "https://api.test", false, true, false],
    ]);
    // Others don't.
    assertEquals(
      await rt.query("envVar.here", { in: space }, { actor: { kind: "person", id: "cy" } }),
      [],
    );

    // At rest, sealed: what's kept isn't the value.
    const kept = (await rt.call<EnvVar[]>("test.read", { collection: "envVar" }))
      .find((v) => v.name === "API_KEY")!;
    assert(kept.sealed?.startsWith("v1."), "sealed");
    assert(!kept.sealed!.includes("sk-live"), "not in the clear");

    // The system opens it: what an app gets, and what computers get.
    assertEquals(await rt.call("env.values", { in: space }), {
      API_KEY: "sk-live-0123456789abcdef",
      API_URL: "https://api.test",
    });
    assertEquals(await rt.call("env.values", { in: space, computers: true }), {
      API_URL: "https://api.test",
    });
    // Changed without its value, it keeps it; a secret's value isn't sent back to keep.
    await rt.call("env.set", { in: space, name: "API_KEY", computers: true }, { actor: ana });
    assertEquals(await rt.call("env.values", { in: space, computers: true }), {
      API_KEY: "sk-live-0123456789abcdef",
      API_URL: "https://api.test",
    });
    await rt.call("env.unset", { in: space, name: "API_URL" }, { actor: ana });
    assertEquals(Object.keys(await rt.call<object>("env.values", { in: space })), ["API_KEY"]);
  });
});

test("jobs and shells run with the space's environment, and what's given over it; agents know the names", async () => {
  await setup(async (rt, topic) => {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    await rt.call("env.set", { in: space, name: "API_URL", value: "https://api.test" }, {
      actor: ana,
    });
    await rt.call("env.set", {
      in: space,
      name: "API_KEY",
      value: "sk-live-0123456789abcdef",
      secret: true,
    }, { actor: ana });
    await rt.call("env.set", {
      in: space,
      name: "DEPLOY_TOKEN",
      value: "for-apps-only-0123456789",
      secret: true,
      computers: false,
    }, { actor: ana });
    const { code: enroll } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    const computer = fakeComputer(topic, `code:${enroll}`);
    await computer.worker.ready;
    try {
      await until(
        async () => (await rt.query<Computer[]>("computer.mine", {}, { actor: ana }))[0]?.online,
        "it came",
      );
      const [desk] = await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana });
      const asked = (work: string) => computer.asked.filter((a) => a.work === work).at(-1)!.input;

      // A person's job, from the panel: the space's, and theirs over it.
      await rt.call("computer.work", {
        desk: desk._id,
        work: "jobs.start",
        input: { command: "npm run dev", env: { API_URL: "http://localhost:9", DEBUG: "1" } },
      }, { actor: ana });
      assertEquals(asked(WORK.jobsStart).env, {
        API_URL: "http://localhost:9",
        API_KEY: "sk-live-0123456789abcdef",
        DEBUG: "1",
      });

      // An agent's: its job, and its shell.
      const { thread } = await rt.call<{ thread: string }>("chat.send", { text: "hi", in: space }, {
        actor: ana,
      });
      await rt.idle();
      const tool = (name: string, input: Record<string, unknown>) =>
        rt.call("test.tool", { tool: name, thread, input }, { actor: ana });
      await tool("start_job", { command: "node server.js", env: { PORT: "4000" } });
      assertEquals(asked(WORK.jobsStart).env, {
        API_URL: "https://api.test",
        API_KEY: "sk-live-0123456789abcdef",
        PORT: "4000",
      });
      await tool("terminal", { stdin: "echo $API_URL" });
      assertEquals(asked(WORK.terminal).env, {
        API_URL: "https://api.test",
        API_KEY: "sk-live-0123456789abcdef",
      });
      // A bad name given fails the call, saying so.
      assertStringIncludes(
        String(await tool("start_job", { command: "x", env: { "no good": "1" } })),
        "isn't an environment variable",
      );

      // The agent knows the names its shell has, never a value.
      const prompt = await rt.query<Prompt>("thread.prompt", { thread, agent: "assistant" }, {
        actor: ana,
      });
      const context = prompt.turn.find((t) => t.startsWith('<context name="computer">')) ?? "";
      assertStringIncludes(context, "this space's environment: API_KEY (a secret), API_URL");
      assert(!context.includes("sk-live"), "no secret's value");
      assert(!context.includes("DEPLOY_TOKEN"), "only what computers get");
    } finally {
      await computer.worker.stop();
    }
  });
});
