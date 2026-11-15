/**
 * Meta's 24 hours: a number writes to a phone freely only in the 24 hours
 * after it last wrote, and past them only a template message reaches it.
 * The app declares its templates; people who may write in a chat, agents
 * working for them and the app's code send one there, checked before
 * anything is said, said in the chat as its body and sent as the template,
 * once. Anything else that finds the 24 hours past is refused, plainly, or
 * goes as the number's fallback template, once: whether the app knew (when
 * the phone last wrote) or Meta said so, at once or later.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Resources,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../../models/mod.ts";
import { type Approval, chat, type Message, tool } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { whatsapp } from "../mod.ts";
import { split, toWhatsApp } from "../shared/text.ts";
import { sign } from "../shared/signature.ts";
import {
  ana,
  ANA_PHONE,
  bob,
  echo,
  fakeGraph,
  link,
  logged,
  reads,
  type Setup,
  setup,
  statuses,
  threadsOf,
  TOKEN,
} from "./setup.ts";

const CARLA = "5511911112222";

/** The templates Meta approved for the app's numbers. */
const whatsappTemplates = {
  reminder: {
    name: "trip_reminder",
    language: "pt_BR",
    body: "Olá {{1}}, sua viagem para {{2}} é amanhã.",
  },
  update: {
    name: "order_update",
    language: "en_US",
    body: "Hi {{customer}}, order {{order}} is {{status}}.",
  },
  retomar: {
    name: "retomar_conversa",
    language: "pt_BR",
    body: "Olá {{1}}! A equipe respondeu: {{2}}",
  },
};

/**
 * An agent's tool that reminds a customer of their trip: a template, its
 * call's id the cause. And the templates said in chats, as the system reads them.
 */
const reminders = definePlugin({
  name: "reminders",
  actions: {
    "test.templates": defineAction({
      input: { type: "object" },
      run: (ctx) => ctx.as().db.collection("whatsapp_template").find({}),
    }),
  },
  resources: {
    whatsappTemplates,
    tools: {
      remind: tool({
        offer: true,
        description: "Reminds a customer of their trip, on WhatsApp",
        input: {
          type: "object",
          properties: { thread: { type: "string" }, name: { type: "string" } },
          required: ["thread", "name"],
        },
        run: (input: { thread: string; name: string }, ctx) =>
          ctx.call("whatsapp.template", {
            thread: input.thread,
            template: "reminder",
            params: [input.name, "Santos"],
            id: ctx.callId,
          }),
      }),
    },
  },
});

/** Opens the number to anyone, as Ana (who manages Launch), answered at once. */
const open = (s: Setup, more: Record<string, unknown> = {}) =>
  s.runtime.call("whatsapp.set", { number: s.number, open: true, quiet: 0, ...more }, {
    actor: ana,
  });

/** Carla writes to the open number: her chat, and the contact she is (as messages name her). */
async function carlaWrites(s: Setup, text = "hi") {
  await s.deliver([{ text: { body: text } }], { from: CARLA, name: "Carla" });
  const chat = (await threadsOf(s.runtime, s.launch)).find((t) => t.title === "Carla")!;
  const history = await s.runtime.query<Message[]>("message.history", { thread: chat._id }, {
    actor: ana,
  });
  const from = history.find((m) => m.from.startsWith("contact:"))!.from;
  return { chat: chat._id, to: from };
}

/** What's in a chat, as Ana reads it: who said what, to whom. */
const history = (s: Setup, thread: string) =>
  s.runtime.query<Message[]>("message.history", { thread }, { actor: ana });

/** A run with the app's templates declared. */
const run = (fn: (s: Setup) => Promise<void>, llm?: LlmAdapter) =>
  setup(fn, { plugins: [reminders], ...(llm ? { llm } : {}) });

/** The processor failures a run left on the record. */
const failures = (events: string) =>
  (JSON.parse(events) as {
    type: string;
    data: { processor: string; attempts: number; error: { code: string; message: string } };
  }[]).filter((e) => e.type === "processor.failed").map((e) => e.data);

test("a template from the desk goes to the phone as Meta takes it, and is said in the chat, once", async () => {
  await run(async (s) => {
    await open(s);
    const { chat, to } = await carlaWrites(s);
    const before = s.graph.requests.length;
    const sent = await s.runtime.call<{ message: string }>("whatsapp.template", {
      thread: chat,
      template: "reminder",
      params: ["Carla", "Santos"],
      id: "trip-9",
    }, { actor: ana });
    await s.runtime.idle();
    // To Meta: the template by its name and language, its body's parameters in order.
    assertEquals(s.graph.sent(CARLA).at(-1), {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: CARLA,
      type: "template",
      template: {
        name: "trip_reminder",
        language: { code: "pt_BR" },
        components: [{
          type: "body",
          parameters: [{ type: "text", text: "Carla" }, { type: "text", text: "Santos" }],
        }],
      },
    });
    // In the chat: its body, filled, said by the chat's agent to Carla.
    const said = (await history(s, chat)).find((m) => m._id === sent.message)!;
    assertEquals([said.from, said.to, said.text], [
      "lead",
      [to],
      "Olá Carla, sua viagem para Santos é amanhã.",
    ]);
    // The same cause sends nothing again, nor does a restart.
    assertEquals(
      await s.runtime.call("whatsapp.template", {
        thread: chat,
        template: "reminder",
        params: ["Carla", "Santos"],
        id: "trip-9",
      }, { actor: ana }),
      sent,
    );
    await s.restart();
    await s.runtime.idle();
    assertEquals(s.graph.requests.length - before, 1);
    // Carla answers it, quoting it: her answer replies to it, and its agent answers her.
    const wamid = s.graph.lastId();
    await s.deliver([{ text: { body: "obrigada" }, context: { id: wamid } }], {
      from: CARLA,
      name: "Carla",
    });
    const thanks = (await history(s, chat)).find((m) => m.text === "obrigada")!;
    assertEquals([thanks.replyTo, thanks.to], [sent.message, ["lead"]]);
    assertEquals(s.graph.texts(CARLA).at(-1), "heard *Carla: obrigada*");
    // A quick reply of its tapped: what it meant (the payload a button's component gave it).
    await s.deliver([{
      type: "button",
      button: { text: "Confirmar", payload: "confirm:trip-9" },
      context: { id: wamid },
    }], { from: CARLA, name: "Carla" });
    const tapped = (await history(s, chat)).find((m) => m.tap)!;
    assertEquals([tapped.text, tapped.tap?.id, tapped.replyTo], [
      "Confirmar",
      "confirm:trip-9",
      sent.message,
    ]);
  });
});

test("named parameters and Meta's own components go as given; wrong ones are refused before anything is said", async () => {
  await run(async (s) => {
    await open(s);
    const { chat } = await carlaWrites(s);
    const button = {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: "A-12" }],
    };
    await s.runtime.call("whatsapp.template", {
      thread: chat,
      template: "update",
      // On one line, as Meta takes a parameter.
      params: { customer: "Carla", order: "A-12", status: "on\n\tits     way" },
      components: [button],
    }, { actor: ana });
    await s.runtime.idle();
    assertEquals(s.graph.templates(CARLA).at(-1), {
      name: "order_update",
      language: { code: "en_US" },
      components: [{
        type: "body",
        parameters: [
          { type: "text", parameter_name: "customer", text: "Carla" },
          { type: "text", parameter_name: "order", text: "A-12" },
          { type: "text", parameter_name: "status", text: "on its way" },
        ],
      }, button],
    });
    assertEquals((await history(s, chat)).at(-1)?.text, "Hi Carla, order A-12 is on its way.");
    // Refused, saying why, before anything is said or sent.
    const before = [s.graph.requests.length, (await history(s, chat)).length];
    const refused = async (input: Record<string, unknown>, code: string, words: string) => {
      const error = await assertRejects(() =>
        s.runtime.call("whatsapp.template", { thread: chat, ...input }, { actor: ana })
      ) as Error & { code: string };
      assertEquals(error.code, code);
      assert(error.message.includes(words), error.message);
    };
    await refused({ template: "reminder", params: ["Carla"] }, "invalid", "takes 2 parameters");
    await refused({ template: "reminder", params: ["Carla", " "] }, "invalid", "({{1}}, {{2}})");
    await refused({ template: "reminder", params: ["Carla", "Santos", "x"] }, "invalid", "takes 2");
    await refused({ template: "update", params: { customer: "Carla" } }, "invalid", "{{order}}");
    await refused({ template: "nope" }, "not_found", 'No WhatsApp template "nope"');
    await refused(
      {
        template: "reminder",
        params: ["Carla", "Santos"],
        components: [{ type: "BODY", parameters: [] }],
      },
      "invalid",
      "go in `params`",
    );
    await s.runtime.idle();
    assertEquals([s.graph.requests.length, (await history(s, chat)).length], before);
  });
});

test("people who write in the chat send one, agents working for them, and the app's code; nobody else", async () => {
  /** Asked to remind Carla, the agent calls its tool for the chat named; then says it did. */
  const remindful: LlmAdapter = {
    async *generate(request) {
      // What was said last, past what contexts add each turn.
      const last = request.messages.findLast((m) =>
        !("text" in m && m.text?.startsWith("<context"))
      )!;
      const words = "text" in last ? last.text ?? "" : "";
      const asked = /remind (\S+)/.exec(words);
      if (last.role === "tool") return void (yield { type: "text", text: "Reminded." });
      if (!asked) return void (yield* echo.generate(request));
      yield {
        type: "tool_call",
        call: { id: "r1", name: "remind", input: { thread: asked[1], name: "Carla" } },
      };
    },
  };
  await run(async (s) => {
    await open(s);
    const { chat, to } = await carlaWrites(s);
    // An agent, working for Ana in Launch, through its tool: from her chat, which Carla can't
    // read, it writes in Carla's only with Ana's yes. Until then, nothing goes.
    await s.runtime.call("chat.send", { in: s.launch, text: `remind ${chat}`, to: ["lead"] }, {
      actor: ana,
    });
    await s.runtime.idle();
    assertEquals(s.graph.templates(CARLA).length, 0);
    const [asked] = await s.runtime.query<Approval[]>("approval.pending", {}, { actor: ana });
    assertEquals(asked.work, "share");
    await s.runtime.call("chat.approve", { approval: asked._id, answer: "once" }, { actor: ana });
    await s.runtime.idle();
    assertEquals(s.graph.templates(CARLA).length, 1);
    assertEquals(
      (await history(s, chat)).at(-1)?.text,
      "Olá Carla, sua viagem para Santos é amanhã.",
    );
    // The app's own code.
    await s.runtime.call("whatsapp.template", {
      thread: chat,
      template: "reminder",
      params: ["Carla", "Santos"],
    });
    await s.runtime.idle();
    assertEquals(s.graph.templates(CARLA).length, 2);
    // Carla herself, a contact: no.
    const carla: Actor = { kind: "contact", id: to.slice("contact:".length) };
    await assertRejects(() =>
      s.runtime.call("whatsapp.template", {
        thread: chat,
        template: "reminder",
        params: ["a", "b"],
      }, {
        actor: carla,
      })
    );
    // Bob, outside Launch: there's no such chat to him. In it, but only to read: he can't.
    const send = () =>
      s.runtime.call("whatsapp.template", {
        thread: chat,
        template: "reminder",
        params: ["a", "b"],
      }, {
        actor: bob,
      });
    assertEquals((await assertRejects(send) as { code: string }).code, "not_found");
    await s.runtime.call("person.set", { person: "bob", email: "bob@example.com" });
    const { invitation } = await s.runtime.call<{ invitation: string }>("invitation.send", {
      space: s.launch,
      email: "bob@example.com",
      role: "viewer",
    }, { actor: ana });
    await s.runtime.call("invitation.accept", { invitation }, { actor: bob });
    assertEquals((await assertRejects(send) as { code: string }).code, "forbidden");
    await s.runtime.idle();
    assertEquals(s.graph.templates(CARLA).length, 2);
  }, remindful);
});

test("a linked person's own conversation takes templates too, from the app's code", async () => {
  await run(async (s) => {
    await link(s);
    await s.deliver([{ text: { body: "plan the launch" } }]);
    const [mine] = (await threadsOf(s.runtime, s.personal)).filter((t) =>
      t._id.startsWith("whatsapp")
    );
    await s.runtime.call("whatsapp.template", {
      thread: mine._id,
      template: "update",
      params: { customer: "Ana", order: "B-7", status: "ready" },
    });
    await s.runtime.idle();
    assertEquals(s.graph.templates(ANA_PHONE).map((t) => t.name), ["order_update"]);
    assertEquals((await history(s, mine._id)).at(-1)?.to, ["ana"]);
  });
});

test("past the 24 hours since the customer wrote, the desk's message is refused, plainly, before Meta is asked", async () => {
  await run(async (s) => {
    await open(s);
    const { chat, to } = await carlaWrites(s);
    await s.runtime.call("test.wrote", { hours: 25 });
    const before = s.graph.requests.length;
    const events = await logged(
      s.runtime,
      () =>
        s.runtime.call("chat.send", { thread: chat, text: "Still there?", to: [to] }, {
          actor: ana,
        }),
    );
    assertEquals(s.graph.requests.length, before);
    const [failed] = failures(events);
    assertEquals([failed.processor, failed.attempts, failed.error.code], [
      "whatsapp.reply",
      1,
      "window_closed",
    ]);
    assert(failed.error.message.includes("24 hours"), failed.error.message);
    // A template still goes.
    await s.runtime.call("whatsapp.template", {
      thread: chat,
      template: "reminder",
      params: ["Carla", "Santos"],
    }, { actor: ana });
    await s.runtime.idle();
    assertEquals(s.graph.templates(CARLA).length, 1);
    // Carla writes again: the 24 hours start over, and the desk's words go.
    await s.deliver([{ text: { body: "sim" } }], { from: CARLA, name: "Carla" });
    await s.runtime.call("chat.send", { thread: chat, text: "Great!", to: [to] }, { actor: ana });
    await s.runtime.idle();
    assertEquals(s.graph.texts(CARLA).at(-1), "Great!");
  });
});

test("with a fallback, what finds the 24 hours past goes as that template, once, with the name and the words", async () => {
  await run(async (s) => {
    await open(s, { fallback: { template: "retomar", params: ["{name}", "{text}"] } });
    const { chat, to } = await carlaWrites(s);
    await s.runtime.call("test.wrote", { hours: 30 });
    const before = s.graph.requests.length;
    await s.runtime.call("chat.send", {
      thread: chat,
      text: "Your **refund**\nwas approved.",
      to: [to],
    }, { actor: ana });
    await s.runtime.idle();
    // In its place: the fallback, her WhatsApp name and the message's words (as WhatsApp shows them).
    assertEquals(s.graph.sent(CARLA).slice(-1).map((m) => m.type), ["template"]);
    assertEquals(s.graph.templates(CARLA).at(-1), {
      name: "retomar_conversa",
      language: { code: "pt_BR" },
      components: [{
        type: "body",
        parameters: [
          { type: "text", text: "Carla" },
          { type: "text", text: "Your *refund* was approved." },
        ],
      }],
    });
    // Once: a restart sends nothing again.
    await s.restart();
    await s.runtime.idle();
    assertEquals(s.graph.requests.length - before, 1);
    // A long message: its words cut to the room the body leaves them.
    await s.runtime.call("chat.send", { thread: chat, text: "word ".repeat(400), to: [to] }, {
      actor: ana,
    });
    await s.runtime.idle();
    const [, words] = (s.graph.templates(CARLA).at(-1)!.components as {
      parameters: { text: string }[];
    }[])[0].parameters;
    const body = whatsappTemplates.retomar.body.replace("{{1}}", "Carla").replace(
      "{{2}}",
      words.text,
    );
    assert(words.text.endsWith("…") && body.length <= 1024, `${body.length}`);
    // Its managers set it to a template the app declares, its parameters as its body takes them.
    const set = (fallback: unknown) => open(s, { fallback });
    assertEquals(
      (await assertRejects(() => set({ template: "nope" })) as { code: string }).code,
      "not_found",
    );
    assertEquals(
      (await assertRejects(() => set({ template: "retomar", params: ["{name}"] })) as {
        code: string;
      }).code,
      "invalid",
    );
    // None: refused again.
    await set(null);
    const events = await logged(
      s.runtime,
      () => s.runtime.call("chat.send", { thread: chat, text: "Hello?", to: [to] }, { actor: ana }),
    );
    assertEquals(failures(events).map((f) => f.error.code), ["window_closed"]);
  });
});

test("Meta's word wins: refused at once, or later, the fallback goes in the message's place, once", async () => {
  await run(async (s) => {
    await open(s, { fallback: { template: "retomar", params: ["{name}", "{text}"] } });
    const { chat, to } = await carlaWrites(s);
    // A phone the app hasn't heard since it knew to keep when (one from before): Meta says.
    await s.runtime.call("test.wrote", {});
    s.graph.refuse((body) => body.type === "text", 131047);
    await s.runtime.call("chat.send", { thread: chat, text: "Are you there?", to: [to] }, {
      actor: ana,
    });
    await s.runtime.idle();
    assertEquals(s.graph.templates(CARLA).length, 1);
    s.graph.refuse(undefined);
    // Taken, then said undelivered for it (each of a long message's parts): its fallback, once.
    const long = "**1.** " + "A sentence about the plan, with some detail. ".repeat(60);
    const text = `${long}\n\n${long}`;
    assertEquals(split(toWhatsApp(text)).length, 2);
    await s.runtime.call("chat.send", { thread: chat, text, to: [to] }, { actor: ana });
    await s.runtime.idle();
    const last = Number(s.graph.lastId().split(".").at(-1));
    const ids = [`wamid.out.${last - 1}`, `wamid.out.${last}`];
    const window = [{ code: 131047, title: "Re-engagement message" }];
    await statuses(
      s,
      ids.map((id) => ({ id, status: "failed", recipient_id: CARLA, errors: window })),
    );
    assertEquals(s.graph.templates(CARLA).length, 2);
    const words = (s.graph.templates(CARLA).at(-1)!.components as {
      parameters: { text: string }[];
    }[])[0].parameters[1].text;
    assert(words.startsWith("*1.* A sentence"), words);
  });
});

test("a template Meta refuses fails once, saying so, on the record", async () => {
  await run(async (s) => {
    await open(s);
    const { chat } = await carlaWrites(s);
    s.graph.refuse((body) => body.type === "template", 132001);
    const events = await logged(s.runtime, async () => {
      await s.runtime.call("whatsapp.template", {
        thread: chat,
        template: "reminder",
        params: ["Carla", "Santos"],
      }, { actor: ana });
    });
    const [failed] = failures(events);
    assertEquals([failed.attempts, failed.error.code], [1, "template_refused"]);
    assert(failed.error.message.includes('"trip_reminder"'), failed.error.message);
  });
});

test("erasing a contact erases the templates said to it", async () => {
  await run(async (s) => {
    await open(s);
    const { chat, to } = await carlaWrites(s);
    await s.runtime.call("whatsapp.template", {
      thread: chat,
      template: "reminder",
      params: ["Carla", "Santos"],
    }, { actor: ana });
    await s.runtime.idle();
    assertEquals((await s.runtime.call<unknown[]>("test.templates", {})).length, 1);
    await s.runtime.call("contact.forget", {
      contact: to.slice("contact:".length),
      chats: true,
    }, { actor: ana });
    await s.runtime.idle();
    const kept = await s.runtime.call<unknown[]>("test.templates", {});
    assertEquals(kept, []);
  });
});

test("templates and a declared number's fallback are checked as the app starts", async () => {
  const start = (resources: Resources) =>
    createRuntime({
      store: memoryStore(),
      // It calls nothing outside as it starts.
      fetch: (() => Promise.reject(new Error("no calls out"))) as typeof fetch,
      plugins: [models, chat, ...access, whatsapp, definePlugin({ name: "app", resources })],
    });
  const number = {
    in: "line",
    phoneId: "222333444",
    token: TOKEN,
    secret: "the-line-apps-own-secret-0123",
    verify: "the-line-verify-token",
  };
  const refused = async (resources: Resources, words: string) => {
    const error = await assertRejects(() => start(resources)) as Error;
    assert(error.message.includes(words), error.message);
  };
  await refused(
    { whatsappTemplates: { a: { name: "a", language: "en", body: "Hi {{2}}" } } },
    "whatsappTemplates.a numbers its parameters from {{1}}, missing none",
  );
  await refused(
    { whatsappTemplates: { a: { name: "a", language: "en", body: "Hi {{1}} {{name}}" } } },
    "names its parameters or numbers them, not both",
  );
  await refused({ whatsappTemplates: { a: { name: "a", body: "Hi" } } }, "needs its language");
  await refused(
    { whatsapp: { azul: { ...number, fallback: { template: "nope" } } } },
    'whatsapp.azul.fallback: No WhatsApp template "nope"',
  );
  const runtime = await start({
    whatsappTemplates,
    whatsapp: {
      azul: { ...number, fallback: { template: "retomar", params: ["{name}", "{text}"] } },
    },
  });
  await runtime.close();
});

test("a declared number's fallback goes as its settings say, kept on its number", async () => {
  const graph = await fakeGraph();
  const store = memoryStore();
  const SECRET = "the-line-apps-own-secret-0123";
  const PHONE = "222333444";
  const app = definePlugin({
    name: "line-app",
    resources: {
      provider: { e: { adapter: "e" } },
      agents: { booking: { instructions: "Sell tickets.", model: "e/booking" } },
      spaces: { line: { name: "Viação Azul", agents: ["booking"] } },
      whatsappTemplates,
      whatsapp: {
        azul: {
          in: "line",
          phoneId: PHONE,
          token: TOKEN,
          secret: SECRET,
          verify: "the-line-verify-token",
          agent: "booking",
          quiet: 0,
          fallback: { template: "retomar", params: { 1: "{name}", 2: "{text}" } },
        },
      },
    },
    adapters: { llm: { e: echo } },
  });
  const runtime = await createRuntime({
    store,
    fetch: graph.fetch,
    plugins: [models, chat, ...access, whatsapp, reads, app],
  });
  try {
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: PHONE },
            contacts: [{ wa_id: CARLA, profile: { name: "Carla" } }],
            messages: [{ id: "wamid.1", from: CARLA, type: "text", text: { body: "oi" } }],
          },
        }],
      }],
    });
    await runtime.fetch(
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
    assertEquals(graph.texts(CARLA), ["heard *Carla: oi*"]);
    // Kept as its settings say, once, however its fallback's keys come back.
    const [number] = await store.find("whatsapp_number", {});
    assertEquals(number.fallback, { template: "retomar", params: { 1: "{name}", 2: "{text}" } });
    const [carla] = await store.find("thread", {}) as { _id: string }[];
    await runtime.call("test.wrote", { hours: 48 });
    await runtime.call("chat.say", {
      id: "paid",
      thread: carla._id,
      from: "booking",
      text: "Pago!",
    });
    await runtime.idle();
    assertEquals(graph.templates(CARLA).map((t) => t.components), [[{
      type: "body",
      parameters: [{ type: "text", text: "Carla" }, { type: "text", text: "Pago!" }],
    }]]);
  } finally {
    await runtime.close();
    await graph.close();
  }
});
