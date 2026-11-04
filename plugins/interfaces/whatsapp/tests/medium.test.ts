/**
 * WhatsApp as a medium, against a fake Graph API: an answer and what a
 * feature shows after it go as one message when there's room; each addition
 * once per chat per key, in order, never after a failed turn; a carousel
 * Meta refuses sends its fallback; a retried delivery sends nothing twice;
 * taps come back with their ids; "typing…" stays up while an agent works;
 * an app's own `message` View replaces the plugin's.
 */
import { assert, assertEquals } from "@std/assert";
import { definePlugin, type ViewContext } from "../../../../runtime/mod.ts";
import type { LlmAdapter, LlmMessage } from "../../../models/mod.ts";
import { type Addition, type Message, tool } from "../../../agents/chat/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { buttons, carousel, text, type WaPart } from "../contract.ts";
import { ana, PHONE_ID, said, SECRET, type Setup, setup, threadsOf } from "./setup.ts";
import { sign } from "../shared/signature.ts";

const CARLA = "5511911112222";

/** What each model call was sent, latest last. */
const asked: LlmMessage[][] = [];

/** Answers what it was told; asked to fail, fails; asked to work, takes a slow step first. */
const sales: LlmAdapter = {
  async *generate({ messages }) {
    asked.push(messages);
    const last = messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
    if (last.role === "tool") return void (yield { type: "text", text: "done working" });
    const words = "text" in last ? last.text ?? "" : "";
    if (words.includes("fail")) throw Object.assign(new Error("model down"), { final: true });
    if (words.includes("work")) {
      return void (yield { type: "tool_call", call: { id: "w", name: "slow", input: {} } });
    }
    yield { type: "text", text: `heard ${words}` };
  },
};

const said_ = (m: Message) => m.text ?? "";
const pix = { id: "pay:pix", title: "PIX" };
const cards = [
  {
    image: { link: "https://cards.example/1.png" },
    body: "10:30",
    buttons: [{ id: "trip:1", title: "10:30" }],
  },
  {
    image: { link: "https://cards.example/2.png" },
    body: "12:00",
    buttons: [{ id: "trip:2", title: "12:00" }],
  },
];

/** A booking feature's additions: trips after an answer about them, then how to pay. */
const booking = definePlugin({
  name: "booking",
  resources: {
    additions: {
      pay: { order: 20 },
      trips: { order: 10 },
      seats: { order: 30 },
      peek: { order: 40 },
    },
    tools: {
      // A step that takes a while: long enough that WhatsApp would hide "typing…".
      slow: tool({
        offer: true,
        description: "Works for a while",
        input: { type: "object", properties: {} },
        run: async (_input, ctx) => {
          await ctx.call("test.typed", { seconds: 30 });
          return "worked";
        },
      }),
    },
  },
  views: {
    "addition:trips": {
      whatsapp: ({ answer }: { answer: Message }): Addition<WaPart> | undefined =>
        said_(answer).includes("trips")
          ? {
            key: "trips:santos",
            parts: [carousel("Some trips to Santos", cards)],
            fallback: [text("1. 10:30\n2. 12:00")],
            note: "2 trips to Santos as a carousel",
          }
          : undefined,
    },
    // A seat map, as the picture over the buttons that choose one.
    "addition:seats": {
      whatsapp: ({ answer }: { answer: Message }) =>
        said_(answer).includes("seat")
          ? {
            key: "seats:1",
            parts: [
              buttons("Window or aisle?", [{ id: "seat:12A", title: "12A, window" }, {
                id: "seat:12B",
                title: "12B, aisle",
              }], { header: { link: "https://cards.example/seats.png" } }),
            ],
          }
          : undefined,
    },
    // What the chats it reads say, as whom the answer goes to may read them.
    "addition:peek": {
      whatsapp: ({ answer }: { answer: Message }, ctx: ViewContext) => {
        if (!said_(answer).includes("peek")) return undefined;
        const chats = ctx.db.collection("thread").find({}).value;
        return chats
          ? { key: `peek:${answer._id}`, parts: [text(`${chats.length} chat`)] }
          : undefined;
      },
    },
    "addition:pay": {
      whatsapp: ({ answer }: { answer: Message }) =>
        said_(answer).includes("pay")
          ? {
            key: "pay",
            parts: [buttons("Pay how?", [pix, { id: "pay:card", title: "Card" }])],
            note: "PIX or card, as buttons",
          }
          : undefined,
    },
  },
});

const open = (s: Setup) =>
  s.runtime.call("whatsapp.set", { number: s.number, open: true, quiet: 0 }, { actor: ana });
const write = (s: Setup, body: string, more: Record<string, unknown> = {}) =>
  s.deliver([{ text: { body }, ...more }], { from: CARLA, name: "Carla" });
/** What the customer's chat has, as the app's people read it. */
const chatOf = async (s: Setup) =>
  (await threadsOf(s.runtime, s.launch)).find((t) => t.title === "Carla")!;
const run = (fn: (s: Setup) => Promise<void>) => setup(fn, { plugins: [booking], llm: sales });

test("an answer and its buttons go as one message, the answer as the body; once per chat", async () => {
  await run(async (s) => {
    await open(s);
    await write(s, "I'd like to pay");
    const [sent] = s.graph.sent(CARLA);
    assertEquals(s.graph.sent(CARLA).length, 1);
    const interactive = sent.interactive as Record<string, any>;
    assertEquals(interactive.type, "button");
    // The answer is the whole body: the buttons' own question isn't asked again.
    assertEquals(interactive.body.text, "heard Carla: I'd like to pay");
    assertEquals(interactive.action.buttons.map((b: any) => b.reply.id), ["pay:pix", "pay:card"]);
    // Shown once: the next answer about paying goes as text alone, and the model knows.
    await write(s, "can I pay later?");
    assertEquals(s.graph.sent(CARLA).length, 2);
    assertEquals(s.graph.sent(CARLA)[1].type, "text");
    const told = JSON.stringify(asked.at(-1));
    assert(told.includes("[then shown: PIX or card, as buttons]"), told);
  });
});

test("a seat map over its buttons, with the answer: one message", async () => {
  await run(async (s) => {
    await open(s);
    await write(s, "which seat is free?");
    const sent = s.graph.sent(CARLA);
    assertEquals(sent.length, 1);
    const interactive = sent[0].interactive as Record<string, any>;
    assertEquals(interactive.header, {
      type: "image",
      image: { link: "https://cards.example/seats.png" },
    });
    assertEquals(interactive.body.text, "heard Carla: which seat is free?");
  });
});

test("a tap comes back with its id and addition, answering the message it was on", async () => {
  await run(async (s) => {
    await open(s);
    await write(s, "I'd like to pay");
    const [buttonsSent] = s.graph.requests.filter((r) => r.body?.type === "interactive");
    const wamid = `wamid.out.${s.graph.sent(CARLA).length}`;
    assert(buttonsSent);
    await s.deliver([{
      type: "interactive",
      interactive: { type: "button_reply", button_reply: pix },
      context: { id: wamid },
    }], { from: CARLA, name: "Carla" });
    const chat = await chatOf(s);
    const history = await s.runtime.query<Message[]>("message.history", { thread: chat._id }, {
      actor: ana,
    });
    const tapped = history.find((m) => m.tap)!;
    const answer = history.find((m) => m.from === "lead")!;
    assertEquals([tapped.text, tapped.tap, tapped.replyTo], [
      "PIX",
      { id: "pay:pix", title: "PIX", key: "pay" },
      answer._id,
    ]);
    assertEquals(s.graph.texts(CARLA).at(-1), "heard Carla: PIX [tapped: pay:pix]");
    // A tap quoting what went to someone else's chat answers nothing here.
    await s.deliver([{
      type: "interactive",
      interactive: { type: "button_reply", button_reply: pix },
      context: { id: wamid },
    }], { from: "14155550123", name: "Dani" });
    const theirs = (await threadsOf(s.runtime, s.launch)).find((t) => t.title === "Dani")!;
    const [stray] = (await s.runtime.query<Message[]>("message.history", { thread: theirs._id }, {
      actor: ana,
    })).filter((m) => m.tap);
    assertEquals([stray.tap, stray.replyTo], [{ id: "pay:pix", title: "PIX" }, undefined]);
    // Typing a button's title is just text.
    await write(s, "PIX");
    const typed = (await s.runtime.query<Message[]>("message.history", { thread: chat._id }, {
      actor: ana,
    })).findLast((m) => m.text === "PIX")!;
    assertEquals(typed.tap, undefined);
  });
});

test("a carousel Meta refuses sends its fallback instead, with the answer, and says so", async () => {
  await run(async (s) => {
    await open(s);
    s.graph.refuse((body) => (body.interactive as { type?: string })?.type === "carousel");
    await write(s, "any trips to Santos?");
    // The carousel was tried; what reached them is the answer with the list, one message.
    assertEquals(s.graph.requests.filter((r) => r.body?.interactive).length, 1);
    assertEquals(s.graph.texts(CARLA), [
      "heard Carla: any trips to Santos?\n\n1. 10:30\n2. 12:00",
    ]);
    await write(s, "and trips back?");
    assertEquals(s.graph.texts(CARLA).length, 2);
    assert(JSON.stringify(asked.at(-1)).includes("2 trips to Santos as a carousel (as text)"));
  });
});

/** Meta's statuses of what was sent, delivered to the webhook as it does, signed. */
async function statuses(s: Setup, items: Record<string, unknown>[]) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: { metadata: { phone_number_id: PHONE_ID }, statuses: items },
      }],
    }],
  });
  await s.serve(
    new Request(`http://localhost/hooks/whatsapp/${s.number}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": await sign(SECRET, new TextEncoder().encode(body)),
      },
      body,
    }),
  );
  await s.runtime.idle();
}

test("a carousel Meta took but couldn't deliver (a picture it failed to fetch) sends its fallback, once", async () => {
  await run(async (s) => {
    await open(s);
    await write(s, "any trips to Santos?");
    const [carousel] = s.graph.sent(CARLA);
    assertEquals((carousel.interactive as { type: string }).type, "carousel");
    const wamid = `wamid.out.${s.graph.requests.filter((r) => r.body?.to === CARLA).length}`;
    const failed = {
      id: wamid,
      status: "failed",
      recipient_id: CARLA,
      errors: [{ code: 131053, title: "Media upload error" }],
    };
    await statuses(s, [{ id: "wamid.other", status: "delivered", recipient_id: CARLA }, failed]);
    // The answer went inside the carousel: it goes again, with the list.
    assertEquals(s.graph.texts(CARLA), ["heard Carla: any trips to Santos?\n\n1. 10:30\n2. 12:00"]);
    // Meta saying it again, or a status of the fallback itself: nothing more.
    await statuses(s, [failed]);
    assertEquals(s.graph.texts(CARLA).length, 1);
  });
});

test("additions go in order, the answer in the first; none after a failed turn", async () => {
  await run(async (s) => {
    await open(s);
    await write(s, "trips, then pay");
    const sent = s.graph.sent(CARLA).map((b) => b.interactive as Record<string, any>);
    assertEquals(sent.map((i) => i.type), ["carousel", "button"]);
    assertEquals(sent[0].body.text, "heard Carla: trips, then pay");
    assertEquals(
      sent[0].action.cards.map((
        c: any,
      ) => [c.header.image.link, c.action.buttons[0].quick_reply.id]),
      [["https://cards.example/1.png", "trip:1"], ["https://cards.example/2.png", "trip:2"]],
    );
    assertEquals(sent[1].body.text, "Pay how?");
    // A failed turn's answer goes as it is, with nothing after it.
    const before = s.graph.sent(CARLA).length;
    await write(s, "please fail, then pay");
    const after = s.graph.sent(CARLA).slice(before);
    assertEquals(after.map((b) => b.type), ["text"]);
    // Told only that, in their terms: never the error.
    assertEquals(
      (after[0].text as { body: string }).body,
      "Sorry, something went wrong on my side. Please send that again in a moment.",
    );
  });
});

test("a delivery tried again sends only what didn't go", async () => {
  await run(async (s) => {
    await open(s);
    s.graph.failOnce((body) => (body.interactive as { type?: string })?.type === "button");
    await write(s, "trips, then pay");
    const tries = (type: string) =>
      s.graph.requests.filter((r) => (r.body?.interactive as { type?: string })?.type === type)
        .length;
    // The carousel went once; the buttons failed, and went when it was tried again.
    assertEquals([tries("carousel"), tries("button")], [1, 2]);
    const chat = await chatOf(s);
    assertEquals((await said(s.runtime, chat._id)).length, 2);
  });
});

test('"typing…" stays up while an agent works, and nothing says "please wait"', async () => {
  await run(async (s) => {
    await open(s);
    await write(s, "hello");
    assertEquals(s.graph.typing(), 1);
    // A step after WhatsApp would have hidden it: shown again.
    await write(s, "please work on it");
    assertEquals(s.graph.typing(), 3);
    assertEquals(s.graph.texts(CARLA), ["heard Carla: hello", "done working"]);
  });
});

test("an app's own message View is how its messages show on WhatsApp", async () => {
  const app = definePlugin({
    name: "styled",
    views: {
      message: {
        whatsapp: (m: Message, _ctx: ViewContext): WaPart[] => [text(`🚌 ${m.text}`)],
      },
    },
  });
  await setup(async (s) => {
    await open(s);
    await write(s, "hi");
    assertEquals(s.graph.texts(CARLA), ["🚌 heard **Carla: hi**"]);
  }, { plugins: [app] });
});

test("what follows an answer is read as whom it goes to, whoever's work the answer was", async () => {
  await run(async (s) => {
    await open(s);
    await s.runtime.call("chat.send", { in: s.launch, text: "the team's own" }, { actor: ana });
    await write(s, "hi");
    const chat = await chatOf(s);
    const carla = (await said(s.runtime, chat._id))[0][0] as string;
    // Trusted code's answer to Carla (the system's work, which reaches every chat).
    await s.runtime.call("test.said", {
      thread: chat._id,
      to: carla,
      text: "a peek",
      answer: true,
    });
    await s.runtime.idle();
    assertEquals(s.graph.texts(CARLA).at(-1), "a peek\n\n1 chat");
  });
});
