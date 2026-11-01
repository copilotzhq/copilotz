/**
 * What one actor may never do through another path: pass a document for a
 * space, leave the space a key is limited to, or work as the agent that asked.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Store,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, tool } from "../../agents/chat/mod.ts";
import { access } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const eve: Actor = { kind: "person", id: "eve" };
const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

let asked = false;
let saw: Actor | undefined;
const script: LlmAdapter = {
  async *generate({ messages, connection }) {
    if (messages.at(-1)!.role === "tool") return void (yield { type: "text", text: "done" });
    if (connection.model === "a" && !asked) {
      asked = true;
      yield {
        type: "tool_call",
        call: { id: "c1", name: "send_message", input: { to: "b", text: "please look" } },
      };
    } else if (connection.model === "b" && !saw) {
      yield { type: "tool_call", call: { id: "c2", name: "whoami", input: {} } };
    } else yield { type: "text", text: "ok" };
  },
};
const whoami = tool({
  description: "who",
  input: { type: "object", properties: {} },
  run: (_i, ctx) => {
    saw = ctx.actor;
    return "noted";
  },
});
const app = definePlugin({
  name: "app",
  adapters: { llm: { s: script } },
  actions: {
    // A request to join, as an agent's `request_access` leaves it.
    "test.ask": defineAction({
      input: {
        type: "object",
        properties: { space: { type: "string" }, member: { type: "string" } },
        required: ["space", "member"],
      },
      run: (ctx, input) =>
        ctx.as().db.collection("request").insertOne({
          _id: `${input.space}|${input.member}`,
          space: input.space,
          member: input.member,
          by: "x",
          reason: "please",
          at: new Date().toISOString(),
        }),
    }),
  },
  resources: {
    shared: { thread: {}, message: { labels: true } },
    provider: { s: { adapter: "s" } },
    tools: { whoami },
    agents: {
      x: { instructions: "x", model: "s/x", default: true },
      a: { instructions: "a", model: "s/a", tools: ["send_message"] },
      b: { instructions: "b", model: "s/b", tools: ["whoami"] },
    },
  },
});

async function setup(
  fn: (rt: Awaited<ReturnType<typeof createRuntime>>, store: Store) => Promise<void>,
) {
  const store = memoryStore();
  const rt = await createRuntime({
    store,
    plugins: [models, chat, ...access, app],
  });
  try {
    await fn(rt, store);
  } finally {
    await rt.close();
  }
}

const canIn = (rt: Awaited<ReturnType<typeof createRuntime>>, space: string, who: Actor) =>
  rt.call<{ can: boolean }>("space.can", { space, verb: "manage" }, { actor: who }).then((r) =>
    r.can
  );

test("a document never passes for a space with the same id", async () => {
  await setup(async (rt, store) => {
    const { space: launch } = await rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    const { space: mine } = await rt.call<{ space: string }>("space.personal", {}, { actor: eve });

    // Her own chat, named as the space, gives her nothing there.
    await rt.call("chat.send", { thread: launch, in: mine, text: "hi" }, { actor: eve });
    await rt.idle();
    await rt.call("member.set", { space: launch, on: "thread", member: eve, role: "manager" }, {
      actor: eve,
    });
    assertEquals(await canIn(rt, launch, eve), false);
    assertEquals(
      await code(rt.call("member.set", { space: launch, member: eve, role: "manager" }, {
        actor: eve,
      })),
      "forbidden",
    );
    assertEquals(
      await code(rt.call("member.remove", { space: launch, member: ana }, { actor: eve })),
      "forbidden",
    );
    // Nor did it touch anyone's edge, or show among the space's members.
    assertEquals(await canIn(rt, launch, ana), true);
    assert(!(await store.find("member", { space: launch })).some((m) => m.member === "person:eve"));

    // What isn't a shared collection can't be named at all.
    assertEquals(
      await code(
        rt.call("member.set", { space: "x", on: "credential", member: eve, role: "viewer" }, {
          actor: eve,
        }),
      ),
      "forbidden",
    );
    // No agent manages a document either.
    assertEquals(
      await code(rt.call("member.set", {
        space: launch,
        on: "thread",
        member: { kind: "agent", id: "x" },
        role: "manager",
      }, { actor: eve })),
      "invalid",
    );
  });
});

test("a key limited to a space does nothing in another its person reaches", async () => {
  await setup(async (rt) => {
    const { space: one } = await rt.call<{ space: string }>("space.create", { name: "One" }, {
      actor: ana,
    });
    const { space: two } = await rt.call<{ space: string }>("space.create", { name: "Two" }, {
      actor: ana,
    });
    const key: Actor = { kind: "person", id: "ana", key: "k1", within: one };
    assertEquals(await canIn(rt, one, key), true);
    assertEquals(await canIn(rt, two, key), false);
    assertEquals(
      await code(rt.call("space.rename", { space: two, name: "No" }, { actor: key })),
      "forbidden",
    );
    assertEquals(
      await code(rt.call("space.rename", { space: one, name: "Yes" }, { actor: key })),
      "done",
    );
    assertEquals(
      await code(
        rt.call("member.set", { space: two, member: { kind: "agent", id: "a" }, role: "editor" }, {
          actor: key,
        }),
      ),
      "forbidden",
    );
    // An agent working for that key is limited with it.
    const agent: Actor = { kind: "agent", id: "x", for: key };
    await rt.call(
      "member.set",
      { space: two, member: { kind: "agent", id: "x" }, role: "editor" },
      {
        actor: ana,
      },
    );
    assertEquals(await canIn(rt, two, agent), false);
    // Her own, without the key, still reaches both.
    assertEquals(await canIn(rt, two, ana), true);
  });
});

test("an agent asked by another works as itself, for the same person", async () => {
  asked = false;
  saw = undefined;
  await setup(async (rt) => {
    const cy: Actor = { kind: "person", id: "cy" };
    const { space } = await rt.call<{ space: string }>("space.create", { name: "Lab" }, {
      actor: cy,
    });
    for (const id of ["a", "b"]) {
      await rt.call("member.set", { space, member: { kind: "agent", id }, role: "editor" }, {
        actor: cy,
      });
    }
    await rt.call("chat.send", { text: "go", in: space, to: ["a"] }, { actor: cy });
    await rt.idle();
    assert(saw, "b's tool ran");
    assertEquals([saw.kind, saw.id, (saw.for as Actor).id, saw.at], ["agent", "b", "cy", space]);
  });
});

test("a document shared on its own still reaches its members, and its manager's", async () => {
  await setup(async (rt) => {
    const bob: Actor = { kind: "person", id: "bob" };
    const { space } = await rt.call<{ space: string }>("space.create", { name: "L" }, {
      actor: ana,
    });
    const { thread } = await rt.call<{ thread: string }>("chat.send", { in: space, text: "plan" }, {
      actor: ana,
    });
    await rt.idle();
    assertEquals(
      await rt.query<unknown[]>("thread.recent", { in: space }, { actor: bob }).then((t) =>
        t.length
      ),
      0,
    );
    await rt.call("member.set", { space: thread, on: "thread", member: bob, role: "viewer" }, {
      actor: ana,
    });
    const shared = await rt.query<{ _id: string }[]>("thread.recent", {}, { actor: bob });
    assert(shared.some((t) => t._id === thread));
    await rt.call("member.remove", { space: thread, on: "thread", member: bob }, { actor: ana });
    assertEquals(
      await rt.query<unknown[]>("thread.recent", {}, { actor: bob }),
      [],
    );
  });
});

test("a role is given the same way however it's given", async () => {
  await setup(async (rt) => {
    const { space } = await rt.call<{ space: string }>("space.create", { name: "L" }, {
      actor: ana,
    });
    assertEquals(
      await code(rt.call("member.set", {
        space,
        member: { kind: "agent", id: "x" },
        role: "nonsense",
      }, { actor: ana })),
      "invalid",
    );
    // A request granted: no role that doesn't exist, and no agent managing.
    const request = async (member: string) => {
      await rt.call("test.ask", { space, member });
      return `${space}|${member}`;
    };
    const agent = await request("agent:x");
    assertEquals(
      await code(rt.call("request.grant", { id: agent, role: "manager" }, { actor: ana })),
      "invalid",
    );
    const bob = await request("person:bob");
    assertEquals(
      await code(rt.call("request.grant", { id: bob, role: "nonsense" }, { actor: ana })),
      "invalid",
    );
    assertEquals(
      await code(rt.call("request.grant", { id: bob, role: "editor" }, { actor: ana })),
      "done",
    );
    // Asking again can't take the last manager's role away.
    const again = await request("person:ana");
    assertEquals(
      await code(rt.call("request.grant", { id: again, role: "viewer" }, { actor: ana })),
      "forbidden",
    );
  });
});

test("a space put away is read and managed, not written in, until it's brought back", async () => {
  await setup(async (rt) => {
    const { space } = await rt.call<{ space: string }>("space.create", { name: "L" }, {
      actor: ana,
    });
    await rt.call("space.archive", { space, archived: true }, { actor: ana });
    const can = (verb: string) =>
      rt.call<{ can: boolean }>("space.can", { space, verb }, { actor: ana }).then((r) => r.can);
    assertEquals([await can("read"), await can("write"), await can("manage")], [true, false, true]);
    assertEquals(
      await code(rt.call("chat.send", { in: space, text: "hi" }, { actor: ana })),
      "forbidden",
    );
    await rt.call("space.archive", { space, archived: false }, { actor: ana });
    assertEquals(await can("write"), true);
    assertEquals(
      await code(rt.call("chat.send", { in: space, text: "hi" }, { actor: ana })),
      "done",
    );
    await rt.idle();
  });
});
