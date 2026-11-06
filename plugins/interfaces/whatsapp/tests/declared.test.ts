/**
 * An app with nothing but a line in its settings: the space it's in (the
 * app's own, declared too), the number, open to anyone, its agent. No person
 * makes or opens any of it. A stranger's message is answered; a restart keeps
 * the same space; nobody takes the line's agent out of it.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { createRuntime, definePlugin, type Runtime } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models from "../../../models/mod.ts";
import { chat, type Thread } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { whatsapp } from "../mod.ts";
import { sign } from "../shared/signature.ts";
import { echo, fakeGraph, TOKEN } from "./setup.ts";

const CARLA = "5511911112222";
const SECRET = "the-line-apps-own-secret-0123";
const PHONE = "222333444";

test("an app with only a declared line answers strangers, in a space of its own that it keeps", async () => {
  const graph = await fakeGraph();
  const store = memoryStore();
  const app = definePlugin({
    name: "line-app",
    resources: {
      provider: { e: { adapter: "e" } },
      agents: { booking: { instructions: "Sell tickets.", model: "e/booking" } },
      spaces: { line: { name: "Viação Azul", agents: ["booking"] } },
      whatsapp: {
        graph: `${graph.url}/v23.0`,
        lines: {
          azul: {
            in: "line",
            phoneId: PHONE,
            token: TOKEN,
            secret: SECRET,
            verify: "the-line-verify-token",
            agent: "booking",
            quiet: 0,
          },
        },
      },
    },
    adapters: { llm: { e: echo } },
  });
  const start = () => createRuntime({ store, plugins: [models, chat, ...access, whatsapp, app] });
  let runtime: Runtime = await start();
  const write = async (body: string, id: string) => {
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: PHONE },
            contacts: [{ wa_id: CARLA, profile: { name: "Carla" } }],
            messages: [{ id, from: CARLA, type: "text", text: { body } }],
          },
        }],
      }],
    });
    const answered = await runtime.fetch(
      new Request("http://localhost/hooks/whatsapp/azul", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": await sign(SECRET, new TextEncoder().encode(payload)),
        },
        body: payload,
      }),
    );
    await runtime.idle();
    return answered.status;
  };
  const spaces = () => store.find("space", {});
  const chats = () => store.find("thread", {}) as Promise<Thread[]>;
  try {
    assertEquals(await write("uma passagem", "wamid.1"), 200);
    assertEquals(graph.texts(CARLA), ["heard *Carla: uma passagem*"]);
    // Its space is the app's: as declared, with its agent answering there.
    assertEquals(
      (await spaces()).map((s) => [s._id, s.name, s.declared, s.agent]),
      [["line", "Viação Azul", true, "booking"]],
    );
    assertEquals((await chats()).map((t) => [t.in, t.agents]), [["line", ["booking"]]]);
    // Restarted: the same space, and the same chat goes on.
    await runtime.close();
    runtime = await start();
    await write("para amanhã", "wamid.2");
    assertEquals(graph.texts(CARLA).at(-1), "heard *Carla: para amanhã*");
    assertEquals((await spaces()).length, 1);
    assertEquals((await chats()).length, 1);
    // Nobody takes its agent out, nor renames it: not even staff, who manage everything.
    const staff = { kind: "person", id: "ops", staff: true };
    const agent = { kind: "agent", id: "booking" };
    await assertRejects(
      () => runtime.call("member.remove", { space: "line", member: agent }, { actor: staff }),
      Error,
      "as the app declares",
    );
    await assertRejects(
      () =>
        runtime.call("member.set", { space: "line", member: agent, role: "viewer" }, {
          actor: staff,
        }),
      Error,
      "as the app declares",
    );
    await assertRejects(
      () => runtime.call("space.rename", { space: "line", name: "Other" }, { actor: staff }),
      Error,
      "the app's own",
    );
  } finally {
    await runtime.close();
    await graph.close();
  }
});

test("a declared space is the app's: nobody makes it first, and one a person made isn't adopted", async () => {
  const graph = await fakeGraph();
  const store = memoryStore();
  const plugin = (spaces: Record<string, unknown>) =>
    definePlugin({
      name: "line-app",
      resources: {
        provider: { e: { adapter: "e" } },
        agents: { booking: { instructions: "Sell tickets.", model: "e/booking" } },
        spaces,
      },
      adapters: { llm: { e: echo } },
    });
  const start = (spaces: Record<string, unknown>) =>
    createRuntime({ store, plugins: [models, chat, ...access, whatsapp, plugin(spaces)] });
  const ops = { kind: "person", id: "ops", staff: true };
  let runtime = await start({ line: { name: "Viação Azul", agents: ["booking"] } });
  try {
    // Before the line's first message, a person can't make its space and manage it.
    await assertRejects(
      () => runtime.call("space.create", { id: "line", name: "mine" }, { actor: ops }),
      Error,
      "the app's own",
    );
    // A space a person made before a release declares its id: refused, never adopted.
    await runtime.call("space.create", { id: "later", name: "mine" }, { actor: ops });
    await runtime.close();
    runtime = await start({ later: { name: "Viação Azul", agents: ["booking"] } });
    await assertRejects(
      () => runtime.call("space.keep", { id: "later" }),
      Error,
      "made by a person",
    );
    const later = await store.findOne("space", { _id: "later" });
    assertEquals([later?.name, later?.declared], ["mine", undefined]);
    // Own names only: "constructor" is no space the app declares.
    assertEquals(await runtime.call("space.keep", { id: "constructor" }), { space: null });
  } finally {
    await runtime.close();
    await graph.close();
  }
});
