/**
 * Computers at the terminal: Ana gets a code with `/computer connect` (and
 * the command to run, with the app's address); once her computer is on, her
 * agent's command waits for her, shown just above where she types with how
 * to answer, and `/approve thread` lets it run, in the conversation.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Writable } from "node:stream";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import { chatTerminal } from "../../agents/chat/terminal.ts";
import { terminalPlugin } from "../../interfaces/terminal/mod.ts";
import { terminalShell } from "../../interfaces/terminal/terminal.ts";
import { plain, terminal } from "../../../hosts/terminal/mod.ts";
import { access } from "../../access/mod.ts";
import { type Approval, type Computer, computers } from "../mod.ts";
import { computersTerminal } from "../computers/terminal.ts";
import { WORK } from "../computers/shared/workloads.ts";
import { test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";

/** Asked to run something, it runs `ls`; told what came of it, it says so. */
const scripted: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
    const said = "text" in last ? last.text ?? "" : "";
    if (last.role === "tool") return yield { type: "text", text: `Got: ${said}` };
    if (/run ls$|Yes, /.test(said)) {
      return yield {
        type: "tool_call",
        call: { id: crypto.randomUUID(), name: "terminal", input: { stdin: "ls" } },
      };
    }
    yield { type: "text", text: "ok" };
  },
};

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 300 && !await check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(await check(), what);
}

test("a person connects a computer and answers their agent at the terminal", async () => {
  const topic = `computers-terminal.${crypto.randomUUID()}`;
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {} },
      provider: { s: { adapter: "s" } },
      agents: {
        lead: { instructions: "Hi.", model: "s/lead", default: true, tools: ["terminal"] },
      },
      computers: { url: "http://127.0.0.1:8790" },
    },
    adapters: { llm: { s: scripted } },
  });
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      computers,
      terminalPlugin,
      app,
      terminalShell,
      chatTerminal,
      computersTerminal,
    ],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const ana: Actor = { kind: "person", id: "ana" };
  let out = "";
  let computer: ReturnType<typeof fakeComputer> | undefined;
  const notice = async () => {
    const shown = runtime.observe("terminal", "approvals", { person: "ana" }, { actor: ana });
    const { value } = await shown.ready as { value?: string };
    shown.close();
    return plain(value ?? "");
  };
  let asking = "";
  try {
    const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor: ana });
    const stdout = Object.assign(
      new Writable({
        write(chunk, _encoding, done) {
          out += chunk.toString();
          done();
        },
      }),
      { columns: 400, isTTY: false },
    );
    const mine = () => runtime.query<Computer[]>("computer.mine", {}, { actor: ana });
    await terminal({
      runtime,
      me: "ana",
      actor: ana,
      space,
      stdout,
      input: (async function* () {
        yield "/computers";
        yield "/computer connect";
        // She runs the command it printed, on her computer.
        await until(() => /--code (\w{4}-\w{4})/.test(plain(out)), "a code");
        const [, code] = /--code (\w{4}-\w{4})/.exec(plain(out))!;
        computer = fakeComputer(topic, `code:${code}`);
        await computer.worker.ready;
        await until(async () => (await mine())[0]?.online === true, "it came");
        yield "/computers";
        yield "/computer rename 1 laptop";
        yield "run ls";
        // Above where she types: what it wants, and how to answer.
        asking = await notice();
        yield "/approvals";
        yield "/approve thread";
        await until(
          () => computer!.asked.some((a) => a.work === WORK.terminal),
          "the command ran",
        );
        await runtime.idle();
        yield "/approvals";
      })(),
    });
    const seen = plain(out);
    assertStringIncludes(
      seen,
      "None yet; /computer connect connects this machine or another to this space.",
    );
    assertStringIncludes(seen, "deno task computer connect http://127.0.0.1:8790 --code ");
    assertStringIncludes(seen, "Their folders go under ~/Copilotz there");
    assertStringIncludes(seen, "[1] testbox ● online · testos · yours · default");
    assertStringIncludes(seen, "Renamed it laptop.");
    assertStringIncludes(asking, "? lead wants to run ls");
    assertStringIncludes(asking, "/approve once · /approve thread (this conversation)");
    assertEquals(await notice(), "");
    assertStringIncludes(seen, "[1] lead wants to run ls");
    assertStringIncludes(seen, "Answered; the agent carries on.");
    assertStringIncludes(seen, "ana → lead › Yes, in this conversation: ls");
    assertStringIncludes(seen, 'lead › Got: {"state":"idle","commandId":"c1","stdout":"ran ls"');
    assertStringIncludes(seen, "Nothing waits on you.");
    const left = await runtime.query<Approval[]>("approval.pending", {}, { actor: ana });
    assert(left.length === 0, JSON.stringify(left));
  } finally {
    await computer?.worker.stop().catch(() => {});
    await runtime.close();
  }
});
