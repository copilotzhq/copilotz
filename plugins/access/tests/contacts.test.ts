/**
 * Contacts: people outside the org, each in a chat shared with them alone.
 * A contact reaches its chat, what's said and filed in it, and nothing else;
 * the agent working for it reaches exactly that chat, though it works in the
 * whole space; the space's people reach every contact's chat, and taking a
 * contact out cuts them off at once. Every Action and query that admits
 * people stays shut to contacts, but the few opened to them.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  peopleOrContacts,
  principalOf,
  type Runtime,
  type ViewContext,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmRequest } from "../../models/mod.ts";
import {
  chat,
  history,
  memory,
  type Message,
  routines,
  skills,
  type Thread,
  tool,
} from "../../agents/mod.ts";
import { access, accounts, contactOf, googleSignIn } from "../mod.ts";
import { api, terminalPlugin, whatsapp } from "../../interfaces/mod.ts";
import { apps, cloud, computers } from "../../compute/mod.ts";
import { usage } from "../../billing/mod.ts";
import { openTo, test } from "../../../testing/mod.ts";
import { attached } from "../../agents/tests/fixtures/files.ts";
import { tools as spacesTools } from "../spaces/resources/tools.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

/** What agents were sent, and what a tool saw, for each test to look at. */
const sent: LlmRequest[] = [];
let peeked: { threads: string[]; messages: string[]; actor?: Actor } | undefined;
/** A space to hand work to, once a test has one. */
let financeId: string | undefined;

/** Answers what it was told; asked to peek, looks around first. */
const echo: LlmAdapter = {
  async *generate(request) {
    sent.push(request);
    // What was said last, past what contexts add each turn.
    const last = request.messages.findLast((m) =>
      !("text" in m && m.text?.startsWith("<context"))
    )!;
    if (last.role === "tool") return void (yield { type: "text", text: "looked" });
    const text = "text" in last ? last.text ?? "" : "";
    if (text.includes("peek")) {
      return void (yield { type: "tool_call", call: { id: "p", name: "peek", input: {} } });
    }
    // Asked to hand it to another space: it does, and waits for that space's answer.
    if (text.includes("ask finance") && financeId) {
      return void (yield {
        type: "tool_call",
        call: {
          id: "h",
          name: "send_message",
          input: { space: financeId, text: "What's our margin on Santos trips?" },
        },
      });
    }
    yield { type: "text", text: `heard ${text}` };
  },
};

const peek = tool({
  description: "Looks at what it can read",
  input: { type: "object", properties: {} },
  run: async (_input, ctx) => {
    const threads = await ctx.db.collection<Thread>("thread").find({});
    const messages = await ctx.db.collection<Message>("message").find({});
    peeked = {
      threads: threads.map((t) => t._id).sort(),
      messages: [...new Set(messages.map((m) => m.thread))].sort(),
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    };
    return "seen";
  },
});

/** What someone reads of a collection, as a View; and writes as them, as an Action does. */
const probe = definePlugin({
  name: "probe",
  views: Object.fromEntries(
    ["thread", "message", "file", "contact", "space", "member", "memory", "person", "credential"]
      .map((c) => [
        c,
        (filter: Record<string, unknown> | undefined, ctx: ViewContext) =>
          ctx.db.collection(c).find(filter ?? {}).value ?? [],
      ]),
  ),
  actions: {
    "test.write": defineAction({
      input: { type: "object" },
      allow: peopleOrContacts,
      run: async (
        ctx,
        input: {
          thread?: string;
          in?: string;
          update?: boolean;
          move?: string;
          private?: boolean;
          toolCalls?: unknown[];
        },
      ) => {
        if (input.update || input.move) {
          const changed = await ctx.db.collection("message").updateMany({}, {
            $set: input.move ? { in: input.move } : { text: "changed" },
          });
          return changed.acknowledged ? changed.modifiedCount : 0;
        }
        await ctx.db.collection("message").insertOne({
          _id: crypto.randomUUID(),
          thread: input.thread,
          ...(input.in ? { in: input.in } : {}),
          from: "x",
          to: [],
          text: "slipped in",
          ...(input.private ? { private: true } : {}),
          ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
          at: new Date().toISOString(),
        });
        return 1;
      },
    }),
    // A memory of a space, as the system keeps one.
    "test.remember": defineAction({
      input: { type: "object" },
      run: (ctx, input: { in: string }) =>
        ctx.db.collection("memory").insertOne({
          _id: crypto.randomUUID(),
          in: input.in,
          text: "Our margin is 12%",
          about: "everyone",
          by: "lead",
          at: new Date().toISOString(),
        }),
    }),
    // Who answers in a space, asked as the caller (chat asks this way).
    "test.roster": defineAction({
      input: { type: "object" },
      allow: peopleOrContacts,
      run: (ctx, input: { space: string }) => ctx.call("space.roster", { space: input.space }),
    }),
  },
});

/** A tool that's never for a contact's chat, even named. */
const ledger = tool({
  description: "The shop's books",
  input: { type: "object", properties: {} },
  offer: (_agent, _thread, ctx) => principalOf(ctx.actor)?.kind !== "contact",
  run: () => "books",
});

const app = definePlugin({
  name: "app",
  resources: {
    provider: { e: { adapter: "e" } },
    tools: { peek, ledger },
    agents: {
      lead: {
        instructions: "Sell tickets.",
        model: "e/lead",
        default: true,
        tools: ["peek", "ledger", "send_message"],
      },
      ops: { instructions: "Run things.", model: "e/ops" },
    },
  },
  adapters: { llm: { e: echo } },
});

type Setup = {
  runtime: Runtime;
  shop: string;
  /** Ana's own chat in the shop. */
  staff: string;
  /** Two customers, each with a chat in the shop. */
  carla: Actor;
  dani: Actor;
  carlas: string;
  danis: string;
  read<T>(collection: string, actor: Actor, filter?: Record<string, unknown>): Promise<T[]>;
};

async function setup(fn: (s: Setup) => Promise<void>) {
  sent.length = 0;
  peeked = undefined;
  financeId = undefined;
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, memory, ...access, probe, app],
  });
  try {
    const { space: shop } = await runtime.call<{ space: string }>("space.create", {
      name: "Shop",
    }, { actor: ana });
    const { thread: staff } = await runtime.call<{ thread: string }>("chat.send", {
      in: shop,
      text: "our margins",
    }, { actor: ana });
    const customer = async (id: string, name: string) => {
      await runtime.call("contact.start", { id, in: shop, via: "whatsapp", name });
      const { thread } = await runtime.call<{ thread: string }>("contact.chat", {
        contact: id,
        in: shop,
      });
      return thread;
    };
    const carlas = await customer("c-carla-01", "Carla");
    const danis = await customer("c-dani-002", "Dani");
    await runtime.idle();
    await fn({
      runtime,
      shop,
      staff,
      carla: { kind: "contact", id: "c-carla-01" },
      dani: { kind: "contact", id: "c-dani-002" },
      carlas,
      danis,
      read: async <T>(collection: string, actor: Actor, filter: Record<string, unknown> = {}) => {
        const seen = runtime.observe<T[]>(collection, filter, { actor });
        const output = await seen.ready;
        seen.close();
        return output.status === "ready" ? output.value : [];
      },
    });
  } finally {
    await runtime.close();
  }
}

const said = async (runtime: Runtime, thread: string) =>
  (await runtime.query<Message[]>("message.history", { thread }, { actor: ana }))
    .filter((m) => !m.private).map((m) => [m.from, m.text]);

test("a contact reaches its own chat, what's said and filed in it, and nothing else", async () => {
  await setup(async ({ runtime, shop, staff, carla, carlas, danis, read }) => {
    await runtime.call("chat.send", {
      thread: carlas,
      text: "a ticket to Santos",
      files: await attached(runtime, [{
        name: "id.txt",
        type: "text/plain",
        data: btoa("RG 12.345"),
      }], {
        actor: carla,
      }),
    }, { actor: carla });
    await runtime.idle();
    // Its message is from it, and the agent's answer goes back to it.
    assertEquals(await said(runtime, carlas), [
      ["contact:c-carla-01", "a ticket to Santos"],
      ["lead", "heard Carla: a ticket to Santos\n[file id.txt]\nRG 12.345\n[end of id.txt]"],
    ]);
    const [, answer] = await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    });
    assertEquals([answer.to, answer.sources], [["contact:c-carla-01"], undefined]);

    // What it reads: its chat, and its own record; nothing of the space, nor of others'.
    const ids = async (collection: string) =>
      (await read<{ _id: string; thread?: string }>(collection, carla)).map((d) =>
        d.thread ?? d._id
      );
    assertEquals(await ids("thread"), [carlas]);
    assertEquals([...new Set(await ids("message"))], [carlas]);
    assertEquals(await ids("file"), [carlas]);
    assertEquals(await ids("contact"), ["c-carla-01"]);
    assertEquals(await read("space", carla), []);
    assertEquals(await read("member", carla), []);

    // Writing anywhere else is refused: another's chat, the staff's, a new one in the space.
    for (const thread of [danis, staff]) {
      assert(
        ["forbidden", "duplicate_key"].includes(
          await code(runtime.call("chat.send", { thread, text: "hi" }, { actor: carla })),
        ),
      );
    }
    assertEquals(
      await code(runtime.call("chat.send", { in: shop, text: "hi" }, { actor: carla })),
      "forbidden",
    );
    assertEquals(
      await code(runtime.call("test.write", { thread: danis }, { actor: carla })),
      "forbidden",
    );
    assertEquals(
      await runtime.call("test.write", { thread: carlas, in: shop }, { actor: carla }),
      1,
    );
    // Its chat's part only where its chat lives: never written into another space, nor moved there.
    const { space: other } = await runtime.call<{ space: string }>("space.create", {
      name: "Other",
    }, { actor: ana });
    for (const somewhere of [other, undefined]) {
      assertEquals(
        await code(runtime.call("test.write", { thread: carlas, in: somewhere }, { actor: carla })),
        "forbidden",
      );
    }
    assertEquals(
      await code(runtime.call("test.write", { move: other }, { actor: carla })),
      "forbidden",
    );
    // An update reaches only its own chat's messages.
    const before = (await said(runtime, staff)).length;
    assertEquals(await runtime.call("test.write", { update: true }, { actor: carla }), 3);
    assertEquals((await said(runtime, staff)).length, before);
    assert((await said(runtime, staff)).every(([, text]) => text !== "changed"));
    assert((await said(runtime, danis)).every(([, text]) => text !== "changed"));
  });
});

test("the agent working for a contact reaches exactly its chat, though it works in the whole space", async () => {
  await setup(async ({ runtime, carla, carlas }) => {
    await runtime.call("chat.send", { thread: carlas, text: "peek around" }, { actor: carla });
    await runtime.idle();
    assertEquals(peeked?.threads, [carlas]);
    assertEquals(peeked?.messages, [carlas]);
    const actor = peeked!.actor!;
    assertEquals([actor.kind, actor.id, (actor.for as Actor).kind], ["agent", "lead", "contact"]);
    // It's told whom it talks with, by name, and offered nothing that keeps what's said here.
    const request = sent.at(-1)!;
    assert(request.instructions?.includes("You're talking with Carla, a customer, writing on "));
    assert(request.instructions?.includes("People here: Carla."));
    assert(!request.instructions?.includes("memory"), request.instructions);
    // A tool that decides where it's offered isn't, here, though the agent names it.
    assertEquals(request.tools?.map((t) => t.name), ["peek", "send_message"]);
  });
});

test("a contact reads what's said in its chat, never its agent's private steps; the agent does", async () => {
  await setup(async ({ runtime, carla, carlas, read }) => {
    // The agent looks around first (a tool call: its private step), then answers.
    await runtime.call("chat.send", { thread: carlas, text: "peek please" }, { actor: carla });
    await runtime.idle();
    const all = await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    });
    const [step] = all.filter((m) => m.private);
    const [call] = step.toolCalls as { name: string; output: string }[];
    assertEquals([call.name, call.output], ["peek", "seen"]);
    // The contact reads what was said, and none of the step: not among the rest, nor asked for.
    const hers = await read<Message>("message", carla);
    assertEquals(hers.map((m) => [m.from, m.text]), [
      ["contact:c-carla-01", "peek please"],
      ["lead", "looked"],
    ]);
    assert(hers.every((m) => !m.private && m.toolCalls === undefined));
    for (
      const filter of [{ _id: step._id }, { private: true }, { thread: carlas, private: true }]
    ) {
      assertEquals(await read("message", carla, filter), [], JSON.stringify(filter));
    }
    assertEquals((await read("message", ana, { _id: step._id })).length, 1);
    // Nor does it write one: a private message, or one with tool calls, would be out of its reach.
    for (const what of [{ private: true }, { toolCalls: [] }]) {
      assertEquals(
        await code(
          runtime.call("test.write", { thread: carlas, in: step.in, ...what }, { actor: carla }),
        ),
        "forbidden",
        JSON.stringify(what),
      );
    }
    // The agent working for it reads its own step: asked again, it goes on from it.
    await runtime.call("chat.send", { thread: carlas, text: "and now?" }, { actor: carla });
    await runtime.idle();
    const told = sent.at(-1)!.messages;
    assert(told.some((m) => m.role === "tool"), "its step is in its history");
  });
});

test("the space's people reach every contact's chat; taking a contact out cuts it off at once", async () => {
  await setup(async ({ runtime, shop, carla, carlas, danis, read }) => {
    await runtime.call("chat.send", { thread: carlas, text: "hello" }, { actor: carla });
    await runtime.idle();
    const chats = await runtime.query<Thread[]>("thread.recent", { in: shop }, { actor: ana });
    assert([carlas, danis].every((id) => chats.some((t) => t._id === id)));
    // By name, where a page shows who wrote.
    const names = await runtime.query<Record<string, string>>("contact.names", {
      ids: ["contact:c-carla-01", "contact:c-dani-002", "contact:nobody"],
    }, { actor: ana });
    assertEquals(names, { "contact:c-carla-01": "Carla", "contact:c-dani-002": "Dani" });
    // Someone outside the space reads none of it.
    assertEquals(await read("contact", bob), []);
    assertEquals(await runtime.query("thread.recent", { in: shop }, { actor: bob }), []);

    // Watching its chat, then taken out of it: what it sees goes.
    const seen = runtime.observe<Thread[]>("thread", {}, { actor: carla });
    assertEquals(((await seen.ready) as { value: Thread[] }).value.map((t) => t._id), [carlas]);
    await runtime.call("member.remove", {
      space: carlas,
      on: "thread",
      member: carla,
    }, { actor: ana });
    await runtime.idle();
    assertEquals((seen.get() as { value: Thread[] }).value, []);
    seen.close();
    assertEquals(
      await code(runtime.call("chat.send", { thread: carlas, text: "still?" }, { actor: carla })),
      "forbidden",
    );
  });
});

test("who answers in a space is told to a contact there, never its people; elsewhere, nobody", async () => {
  await setup(async ({ runtime, shop, carla }) => {
    assertEquals(await runtime.call("test.roster", { space: shop }, { actor: carla }), {
      agents: ["lead"],
      default: "lead",
    });
    const { space: other } = await runtime.call<{ space: string }>("space.create", {
      name: "Other",
    }, { actor: bob });
    assertEquals(await runtime.call("test.roster", { space: other }, { actor: carla }), {
      agents: [],
    });
  });
});

test("a contact joins documents only, and never manages them", async () => {
  await setup(async ({ runtime, shop, staff, carla }) => {
    assertEquals(
      await code(runtime.call("member.set", { space: shop, member: carla, role: "viewer" }, {
        actor: ana,
      })),
      "invalid",
    );
    assertEquals(
      await code(
        runtime.call("member.set", { space: staff, on: "thread", member: carla, role: "manager" }, {
          actor: ana,
        }),
      ),
      "invalid",
    );
  });
});

test("an Action only people may call refuses a contact", async () => {
  await setup(async ({ runtime, shop, carla, carlas }) => {
    for (
      const [action, input] of [
        ["space.create", { name: "Mine" }],
        ["space.personal", {}],
        ["member.set", { space: carlas, on: "thread", member: carla, role: "viewer" }],
        ["chat.stop", { thread: carlas }],
        ["chat.open", { in: shop }],
      ] as const
    ) {
      assertEquals(await code(runtime.call(action, input, { actor: carla })), "forbidden", action);
    }
    await assertRejects(() =>
      runtime.query("message.history", { thread: carlas }, { actor: carla })
    );
    await assertRejects(() =>
      runtime.query("message.questions", { person: carla.id }, { actor: carla })
    );
  });
});

test("every Action, query and event stays shut to contacts, but those opened to them", () => {
  // Each plugin on its own, asked as a contact would about itself. (Each product package checks
  // its own the same way.)
  const contact: Actor = { kind: "contact", id: "c-someone" };
  const open = openTo(contact, [
    models,
    chat,
    history,
    memory,
    skills,
    routines,
    ...access,
    googleSignIn,
    accounts,
    api,
    terminalPlugin,
    whatsapp,
    computers,
    apps,
    cloud,
    usage,
  ]);
  // `file.about` is a file as its reader reaches it: a contact, its own chat's; `chat.attach`
  // uploads a file its message then sends. Meta's webhook is WhatsApp's route, which calls
  // `whatsapp.receive` as trusted code: no Action of it is open.
  assertEquals(open, ["chat.attach", "chat.send", "file.about"]);
});

test("an agent says a fixed message to a contact's chat without a turn, once", async () => {
  await setup(async ({ runtime, carla, dani, carlas }) => {
    await runtime.call("chat.send", { thread: carlas, text: "paid" }, { actor: carla });
    await runtime.idle();
    const calls = sent.length;
    for (let i = 0; i < 2; i++) {
      await runtime.call("chat.say", {
        id: "pix-123:confirmed",
        thread: carlas,
        from: "lead",
        text: "Payment confirmed!",
      });
    }
    await runtime.idle();
    assertEquals(sent.length, calls);
    const history = await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    });
    const confirmed = history.filter((m) => m.text === "Payment confirmed!");
    assertEquals(confirmed.map((m) => [m._id, m.from, m.to]), [
      [`${carlas}:say:pix-123:confirmed`, "lead", ["contact:c-carla-01"]],
    ]);
    // With a file: one of the chat's, which its contact reads and no other contact does.
    const { files } = await runtime.call<{ files: string[] }>("chat.say", {
      id: "pix-123:receipt",
      thread: carlas,
      from: "lead",
      files: [{ name: "receipt.pdf", type: "application/pdf", data: btoa("%PDF-1.4 receipt") }],
    });
    const receipt = (id: string, actor: Actor) =>
      runtime.query<{ name: string } | null>("file.about", { id }, { actor });
    assertEquals((await receipt(files[0], carla))?.name, "receipt.pdf");
    assertEquals(await receipt(files[0], dani), null);
    // Said only by an agent that answers in the chat.
    assertEquals(
      await code(runtime.call("chat.say", { id: "y", thread: carlas, from: "ops", text: "hi" })),
      "not_here",
    );
    // Whose work it is, from an event's actor: the contact's, through the agent working for them.
    assertEquals(contactOf({ kind: "agent", id: "lead", for: carla }), carla.id);
    assertEquals(contactOf(ana), undefined);
    // Never to an agent: that's a message to send it.
    assertEquals(
      await code(
        runtime.call("chat.say", { id: "x", thread: carlas, from: "lead", text: "x", to: ["ops"] }),
      ),
      "invalid",
    );
  });
});

test("what staff's agents read stays with staff: in a contact's chat, it's theirs alone", async () => {
  await setup(async ({ runtime, carla, carlas, staff, read }) => {
    const last = async () =>
      (await runtime.query<Message[]>("message.history", { thread: carlas }, { actor: ana }))
        .findLast((m) => m.from === "lead")!;
    // Ana's agent in Carla's chat, reading only the chat: Carla reads its answer.
    await runtime.call("chat.send", { thread: carlas, text: "hello" }, { actor: ana });
    await runtime.idle();
    const hello = await last();
    assertEquals(hello.sources, undefined);
    assert((await read<Message>("message", carla)).some((m) => m._id === hello._id));
    // Its agent is told who else is in the chat, and its tools are the staff's.
    const request = sent.at(-1)!;
    assert(request.instructions?.includes("Also in it, from outside the org: Carla."));
    assertEquals(request.tools?.map((t) => t.name).sort(), [
      "forget",
      "ledger",
      "peek",
      "recall",
      "remember",
      "request_access",
      "send_message",
    ]);
    // Looking around the shop: its answer draws on it, and Carla doesn't read it.
    await runtime.call("chat.send", { thread: carlas, text: "peek around" }, { actor: ana });
    await runtime.idle();
    const answer = await last();
    assert(answer.sources?.length, "labelled with the shop");
    assert(!(await read<Message>("message", carla)).some((m) => m._id === answer._id));
    // A reply to a message of another chat replies to nothing.
    const [elsewhere] = await runtime.query<Message[]>("message.history", { thread: staff }, {
      actor: ana,
    });
    const { message } = await runtime.call<{ message: string }>("chat.send", {
      thread: carlas,
      text: "about that",
      replyTo: elsewhere._id,
    }, { actor: ana });
    await runtime.idle();
    const mine = (await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    })).find((m) => m._id === message)!;
    assertEquals(mine.replyTo, undefined);
  });
});

test("a contact talks with whom its chat is with: naming another agent there changes nothing", async () => {
  await setup(async ({ runtime, shop, carla, carlas }) => {
    await runtime.call("member.set", {
      space: shop,
      member: { kind: "agent", id: "ops" },
      role: "editor",
    }, { actor: ana });
    const { message } = await runtime.call<{ message: string }>("chat.send", {
      thread: carlas,
      text: "@ops open the books",
      to: ["ops"],
    }, { actor: carla });
    await runtime.idle();
    const history = await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    });
    assertEquals(history.find((m) => m._id === message)?.to, ["lead"]);
    assert(!history.some((m) => m.from === "ops"));
  });
});

test("a document shared on its own is never a space; memories and people stay out of reach", async () => {
  await setup(async ({ runtime, shop, staff, carla, dani, read }) => {
    // Bob sees Ana's chat on its own: he may read that chat, not a space of its key.
    await runtime.call("member.set", { space: staff, on: "thread", member: bob, role: "viewer" }, {
      actor: ana,
    });
    const can = (space: string) =>
      runtime.call<{ can: boolean }>("space.can", { space, verb: "read" }, { actor: bob })
        .then((r) => r.can);
    assertEquals(await can(`thread:${staff}`), false);
    assertEquals(await can(shop), false);
    // A memory of the shop, and a person whose id is a contact's: neither reaches a contact.
    await runtime.call("test.remember", { in: shop });
    await runtime.call("person.set", { person: dani.id, email: "dani@example.com" });
    assertEquals(await read("memory", carla), []);
    assertEquals(await read("person", dani), []);
    assertEquals(await read("credential", dani), []);
    // Asking for access, for a contact, asks for nothing.
    const asked = await (spacesTools.request_access.run as (i: unknown, c: unknown) => unknown)(
      { space: "Shop", reason: "let me in" },
      { actor: { kind: "agent", id: "lead", for: carla } },
    );
    assert(String(asked).startsWith("Not here"), String(asked));
  });
});

test("work handed to another space from a contact's chat comes back theirs alone", async () => {
  await setup(async ({ runtime, carla, carlas, read }) => {
    const { space } = await runtime.call<{ space: string }>("space.create", { name: "Finance" }, {
      actor: ana,
    });
    financeId = space;
    // Ana's agent, in Carla's chat, hands it to Finance; Finance's answer comes back there.
    await runtime.call("chat.send", { thread: carlas, text: "ask finance" }, { actor: ana });
    await runtime.idle();
    const history = await runtime.query<Message[]>("message.history", { thread: carlas }, {
      actor: ana,
    });
    const back = history.find((m) => m.via?.kind === "delegated")!;
    assertEquals(back.sources, [space]);
    // Carla never reads it; Ana, who reaches Finance, does.
    assert(!(await read<Message>("message", carla)).some((m) => m._id === back._id));
    assert((await read<Message>("message", ana)).some((m) => m._id === back._id));
  });
});

test("a collection's name is only its own: nothing objects inherit is a shared collection", async () => {
  await setup(async ({ runtime, carlas }) => {
    for (const on of ["constructor", "__proto__", "toString"]) {
      assertEquals(
        await code(
          runtime.call("member.set", { space: carlas, on, member: bob, role: "viewer" }, {
            actor: ana,
          }),
        ),
        "forbidden",
        on,
      );
    }
  });
});
