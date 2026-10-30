/**
 * The computer program and the computers plugin together, over the web
 * host's socket: Ana connects her machine with a code (named as she ran it);
 * her agent's commands and writes wait for her yes, then run in her personal
 * space's folder; what the computer can't do (a path out of the folder) the
 * agent hears, and her panel fails saying why; when it stops, it's offline.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type ToolContext } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { type Approval, type Computer, computers, type Desk } from "../mod.ts";
import { tools } from "../computers/resources/tools.ts";
import { startComputer } from "../computers/program/computer.ts";
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
        tools: ["terminal", "write_file", "read_file", "start_job", "list_jobs"],
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

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 500 && !await check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(await check(), what);
}

test("the program connects to the plugin; agents work on it once their person says yes", async () => {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, app],
    transports: [{ type: "websocket", config: { path: "/oxian" } }],
  });
  const listener = await host(rt.hypervisor);
  const root = join(tempDir(), "Copilotz");
  let computer: Awaited<ReturnType<typeof startComputer>> | undefined;
  try {
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: space,
    }, { actor: ana });
    await rt.idle();
    const tool = (name: string, input: Record<string, unknown>) =>
      rt.call<unknown>("test.tool", { tool: name, thread, input }, { actor: ana });
    const answer = async (answer: string) => {
      const [asked] = await rt.query<Approval[]>("approval.pending", {}, { actor: ana });
      await rt.call("computer.approve", { approval: asked._id, answer }, { actor: ana });
    };

    // She connects it, as `computer connect <url> --code <code> --name laptop` does.
    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    computer = await startComputer({
      url: `http://127.0.0.1:${new URL(String(listener.url)).port}`,
      root,
      statePath: join(tempDir(), "computer.json"),
      code,
      name: "laptop",
      chromium: null,
      log: () => {},
    });
    await computer.ready;
    const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
    await until(async () => (await mine())[0]?.online === true, "it came");
    const [laptop] = await mine();
    assertEquals(laptop.name, "laptop");

    // A command waits for her; in this conversation, yes: it runs in her space's folder.
    assertStringIncludes(String(await tool("terminal", { stdin: "pwd" })), "Waiting for ana");
    await answer("thread");
    // In the computer's shell: PowerShell on Windows.
    const stdin = process.platform === "win32"
      ? 'Set-Content -NoNewline made.txt "hi`n"; (Get-Location).Path'
      : "echo hi > made.txt && pwd";
    const ran = await tool("terminal", { stdin }) as { stdout: string; exitCode: number };
    assertEquals(ran.exitCode, 0);
    assert(/[\\/]personal$/.test(ran.stdout.trim()), ran.stdout);
    const made = join(root, "personal", "made.txt");
    assert(existsSync(made), `${made} isn't there: ${JSON.stringify(ran)}`);
    assertEquals(await readFile(made, "utf8"), "hi\n");

    // Writes, always: then they just happen.
    await tool("write_file", { path: "notes/a.md", content: "# A" });
    await answer("always");
    assertEquals(await tool("write_file", { path: "notes/a.md", content: "# A" }), {
      path: "notes/a.md",
      size: 3,
    });
    assertEquals(
      (await tool("read_file", { path: "notes/a.md" }) as { content: string }).content,
      "# A",
    );
    // Out of the folder: the agent hears why.
    assertEquals(
      ((await tool("read_file", { path: "../x" })) as { error: { code: string } }).error.code,
      "invalid_path",
    );

    // A job, once she's said yes to jobs; it's the agent's.
    await tool("start_job", { command: "sleep 30", name: "nap" });
    await answer("always");
    await tool("start_job", { command: "sleep 30", name: "nap" });
    const [job] = await tool("list_jobs", {}) as { name: string; who: string; running: boolean }[];
    assertEquals([job.name, job.who, job.running], ["nap", "agent:assistant", true]);

    // Her panel: her files there, and a refusal that says why.
    const [desk] = await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana });
    const listed = await rt.call<{ name: string }[]>("computer.work", {
      desk: desk._id,
      work: "files.list",
      input: {},
    }, { actor: ana });
    assertEquals(listed.map((e) => e.name).sort(), ["made.txt", "notes"]);
    const refused = await rt.call("computer.work", {
      desk: desk._id,
      work: "files.read",
      input: { path: "../../etc/passwd" },
    }, { actor: ana }).then(() => undefined, (error) => error as { code?: string });
    assertEquals(refused?.code, "invalid_path");

    // It stops (its jobs with it): offline.
    await computer.stop();
    await until(async () => (await mine())[0]?.online === false, "it went");
  } finally {
    await computer?.stop();
    await listener.shutdown();
    await rt.close();
  }
});
