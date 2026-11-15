/**
 * What people say on WhatsApp, not only agents: a customer's chat is the
 * desk's too, and its people take it over at any moment. What they say to
 * the customer (or to the whole chat) goes to the phone as an agent's answer
 * does, with its files, once; the app's fixed messages (`chat.say`) too.
 * What's said to agents alone, or kept private, stays in the app, and the
 * customer's own words never come back to them. Past the 24 hours since the
 * customer last wrote, Meta refuses anything but a template: that fails once,
 * plainly, on the record.
 */
import { assert, assertEquals } from "@std/assert";
import type { Actor } from "../../../../runtime/mod.ts";
import type { Message } from "../../../agents/chat/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { split, toWhatsApp } from "../shared/text.ts";
import {
  ana,
  ANA_PHONE,
  bob,
  link,
  logged,
  PARAGRAPH,
  type Setup,
  setup,
  statuses,
  threadsOf,
} from "./setup.ts";

const CARLA = "5511911112222";

const open = (s: Setup) =>
  s.runtime.call("whatsapp.set", { number: s.number, open: true, quiet: 0 }, { actor: ana });

/** Carla writes to the open number: her chat, and the contact she is. */
async function carlaWrites(s: Setup, text = "hi") {
  await s.deliver([{ text: { body: text } }], { from: CARLA, name: "Carla" });
  const chat = (await threadsOf(s.runtime, s.launch)).find((t) => t.title === "Carla")!;
  const history = await s.runtime.query<Message[]>("message.history", { thread: chat._id }, {
    actor: ana,
  });
  const from = history.find((m) => m.from.startsWith("contact:"))!.from;
  const carla: Actor = { kind: "contact", id: from.slice("contact:".length), in: s.launch };
  return { chat: chat._id, carla, to: from };
}

/** Ana, at the desk, says something in a chat. */
async function anaSays(s: Setup, input: Record<string, unknown>, actor = ana) {
  await s.runtime.call("chat.send", input, { actor });
  await s.runtime.idle();
}

test("what a person says to the customer goes to their phone, as an agent's answer does", async () => {
  await setup(async (s) => {
    await open(s);
    const { chat, to } = await carlaWrites(s);
    assertEquals(s.graph.texts(CARLA), ["heard *Carla: hi*"]);
    // Ana takes it over: to Carla, in her words, formatted as WhatsApp does. No agent answers it.
    await anaSays(s, {
      thread: chat,
      text: "I'm **Ana**, from the team: your refund is on its way.",
      to: [to],
    });
    assertEquals(s.graph.texts(CARLA), [
      "heard *Carla: hi*",
      "I'm *Ana*, from the team: your refund is on its way.",
    ]);
    // Carla quotes it: her answer is Ana's (no agent answers it), and never comes back to her.
    await s.deliver([{ text: { body: "thanks!" }, context: { id: s.graph.lastId() } }], {
      from: CARLA,
      name: "Carla",
    });
    const history = await s.runtime.query<Message[]>("message.history", { thread: chat }, {
      actor: ana,
    });
    const thanks = history.find((m) => m.text === "thanks!")!;
    assertEquals([thanks.from, thanks.to], [to, ["ana"]]);
    assertEquals(history.find((m) => m._id === thanks.replyTo)?.from, "ana");
    assertEquals(s.graph.texts(CARLA).length, 2);
    // To her and an agent: it goes too.
    await anaSays(s, { thread: chat, text: "Lead, note it.", to: [to, "lead"] });
    assert(s.graph.texts(CARLA).includes("Lead, note it."));
  });
});

test("said to the whole chat it goes; to the agent alone, or private, it stays in the app", async () => {
  await setup(async (s) => {
    await open(s);
    const { chat, carla, to } = await carlaWrites(s);
    const before = s.graph.texts(CARLA).length;
    // To nobody in particular: everyone in the chat reads it, Carla too.
    await anaSays(s, { thread: chat, text: "Back in five minutes.", to: [] });
    assertEquals(s.graph.texts(CARLA).slice(before), ["Back in five minutes."]);
    // To the agent alone, and its answer to Ana: the desk's, not Carla's.
    await anaSays(s, { thread: chat, text: "what did she book?", to: ["lead"] });
    // Private, though addressed to her: it stays.
    await s.runtime.call("test.said", {
      thread: chat,
      from: "ana",
      to,
      text: "our margin is 12%",
      private: true,
    });
    // Carla's own, to nobody (what she did on a page): never back to her.
    await s.runtime.call("chat.send", { thread: chat, text: "(opened the map)", to: [] }, {
      actor: carla,
    });
    await s.runtime.idle();
    assertEquals(s.graph.texts(CARLA).slice(before), ["Back in five minutes."]);
    // The app's fixed message, to her: it goes, as ever.
    await s.runtime.call("chat.say", {
      id: "refund-1",
      thread: chat,
      from: "lead",
      text: "Refund sent.",
      to: [to],
    });
    await s.runtime.idle();
    assertEquals(s.graph.texts(CARLA).at(-1), "Refund sent.");
  });
});

test("a person's files go too, as WhatsApp shows them, read as the customer may", async () => {
  await setup(async (s) => {
    await open(s);
    const { chat, to } = await carlaWrites(s);
    const { id } = await s.runtime.call<{ id: string }>("chat.attach", {
      name: "ticket.pdf",
      type: "application/pdf",
      data: btoa("%PDF-1.4 ticket"),
    }, { actor: ana });
    await anaSays(s, { thread: chat, text: "Your ticket.", files: [{ id }], to: [to] });
    const sent = s.graph.sent(CARLA).at(-1)!;
    const doc = sent.document as { id: string; filename: string; caption: string };
    assertEquals(sent.type, "document");
    assert(doc.id.startsWith("media.up."), doc.id);
    assertEquals([doc.filename, doc.caption], ["ticket.pdf", "Your ticket."]);
  });
});

test("a person's message goes once: a delivery tried again sends only what didn't go", async () => {
  await setup(async (s) => {
    await open(s);
    const { chat, to } = await carlaWrites(s);
    const long = [1, 2, 3].map((n) => `**${n}.** ${PARAGRAPH}${PARAGRAPH}`).join("\n\n");
    const parts = split(toWhatsApp(long));
    assertEquals(parts.length, 3);
    // Its second part fails once (Meta's outage): tried again, the first doesn't go twice.
    let n = 0;
    s.graph.failOnce((body) => body.type === "text" && ++n === 2);
    const before = s.graph.texts(CARLA).length;
    await anaSays(s, { thread: chat, text: long, to: [to] });
    const tried = [parts[0], parts[1], parts[1], parts[2]];
    assertEquals(s.graph.texts(CARLA).slice(before), tried);
    // A restart (a deploy) sends nothing again.
    await s.restart();
    await s.runtime.idle();
    assertEquals(s.graph.texts(CARLA).slice(before), tried);
  });
});

test("on a linked phone: a teammate's message to its person goes to it; their own never does", async () => {
  await setup(async (s) => {
    await link(s);
    await s.bobJoins();
    await s.deliver([{ text: { body: "/space Launch" } }]);
    await s.deliver([{ text: { body: "plan the launch" } }]);
    const [chat] = (await threadsOf(s.runtime, s.launch)).filter((t) =>
      t._id.startsWith("whatsapp")
    );
    const before = s.graph.texts(ANA_PHONE).length;
    // Bob, in Launch, writes to Ana there: it reaches her phone.
    await anaSays(s, { thread: chat._id, text: "I booked the venue.", to: ["ana"] }, bob);
    // Ana, at her desk, writes in her own WhatsApp conversation: it isn't sent back to her.
    await anaSays(s, { thread: chat._id, text: "noted, thanks", to: [] });
    assertEquals(s.graph.texts(ANA_PHONE).slice(before), ["I booked the venue."]);
  });
});

test("past the 24 hours since the customer wrote, Meta refuses it: it fails once, plainly, on the record", async () => {
  await setup(async (s) => {
    await open(s);
    const { chat, to } = await carlaWrites(s);
    const late = "Are you still there?";
    s.graph.refuse((body) => (body.text as { body?: string })?.body === late, 131047);
    const events = await logged(
      s.runtime,
      () => s.runtime.call("chat.send", { thread: chat, text: late, to: [to] }, { actor: ana }),
    );
    // Tried once (trying again won't open the window), and the dead letter says why.
    const tries = s.graph.requests.filter((r) =>
      (r.body?.text as { body?: string })?.body === late
    );
    assertEquals(tries.length, 1);
    const failed = (JSON.parse(events) as {
      type: string;
      data: { processor: string; attempts: number; error: { code: string; message: string } };
    }[]).find((e) => e.type === "processor.failed" && e.data.processor === "whatsapp.reply")!;
    assertEquals([failed.data.attempts, failed.data.error.code], [1, "window_closed"]);
    assert(failed.data.error.message.includes("24 hours"), failed.data.error.message);
    // The message stays in the app, and what follows in the chat goes on.
    s.graph.refuse(undefined);
    await anaSays(s, { thread: chat, text: "Hello again!", to: [to] });
    assertEquals(s.graph.texts(CARLA).at(-1), "Hello again!");
    // Taken, and later said undelivered for the same reason (as Meta often does): logged with why,
    // and nothing goes again.
    const wamid = s.graph.lastId();
    const errors: unknown[][] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      await statuses(s, [{
        id: wamid,
        status: "failed",
        recipient_id: CARLA,
        errors: [{ code: 131047, title: "Re-engagement message" }],
      }]);
    } finally {
      console.error = log;
    }
    assertEquals(errors.length, 1);
    assert(String(errors[0][0]).includes("24 hours"), String(errors[0][0]));
    assertEquals(s.graph.texts(CARLA).filter((t) => t === "Hello again!").length, 1);
  });
});
