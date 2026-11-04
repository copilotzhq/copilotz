/**
 * A customer line: a number open to anyone. A stranger who writes is a
 * contact, in a chat of their own in the number's space, answered by its
 * agent; a chat quiet for the number's gap is over; a contact reaches only
 * its own chat; linked phones stay their people's, and a closed number still
 * says how to link.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Actor } from "../../../../runtime/mod.ts";
import type { Message, Thread } from "../../../agents/chat/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { ana, ANA_PHONE, link, said, type Setup, setup, STRANGER, threadsOf } from "./setup.ts";

const CARLA = "5511911112222";

/** Opens the number to anyone, as Ana (who manages Launch). */
const open = (s: Setup, more: Record<string, unknown> = {}) =>
  s.runtime.call("whatsapp.set", { number: s.number, open: true, ...more }, { actor: ana });

/** The contact a chat's customer is, from who wrote there. */
async function contactIn(s: Setup, thread: string): Promise<Actor> {
  const history = await s.runtime.query<Message[]>("message.history", { thread }, { actor: ana });
  const from = history.find((m) => m.from.startsWith("contact:"))!.from;
  return { kind: "contact", id: from.slice("contact:".length) };
}

test("a stranger to an open number is a contact, in a chat of its own, answered by its agent", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, launch } = s;
    assertEquals(await open(s), { open: true, agent: null, gap: 12 });
    const before = graph.requests.length;
    await deliver([{ text: { body: "a ticket to Santos, please" } }], {
      from: CARLA,
      name: "Carla",
    });
    // A chat in the number's space, by their name, answered there and on their phone.
    const [chat] = await threadsOf(runtime, launch);
    assertEquals([chat.title, chat.agents], ["Carla", ["lead"]]);
    const [mine, answer] = await said(runtime, chat._id);
    assert(String(mine[0]).startsWith("contact:c-"), mine[0]);
    assertEquals(mine[1], "a ticket to Santos, please");
    assertEquals(answer, ["lead", "heard **Carla: a ticket to Santos, please**"]);
    assertEquals(graph.texts(CARLA), ["heard *Carla: a ticket to Santos, please*"]);
    // Read, with "typing…", before the answer.
    const read = graph.requests.slice(before).find((r) => r.body?.status === "read");
    assertEquals(read?.body?.typing_indicator, { type: "text" });
    // Its next message goes on in that chat.
    await deliver([{ text: { body: "tomorrow" } }], { from: CARLA, name: "Carla" });
    assertEquals((await threadsOf(runtime, launch)).length, 1);
    assertEquals(graph.texts(CARLA).at(-1), "heard *Carla: tomorrow*");
    // The space's people see them by name.
    const carla = await contactIn(s, chat._id);
    const names = await runtime.query<Record<string, string>>("contact.names", {
      ids: [`contact:${carla.id}`],
    }, { actor: ana });
    assertEquals(names, { [`contact:${carla.id}`]: "Carla" });
  });
});

test("a contact on the line reaches its own chat, and nothing else of the space", async () => {
  await setup(async (s) => {
    const { runtime, deliver, launch, read } = s;
    await open(s);
    await runtime.call("chat.send", { in: launch, text: "the team's own plans" }, { actor: ana });
    await deliver([{ text: { body: "hi" } }], { from: CARLA, name: "Carla" });
    await deliver([{ text: { body: "hello" } }], { from: STRANGER, name: "Dani" });
    const chats = (await threadsOf(runtime, launch)).filter((t) => t.title);
    assertEquals(chats.map((t) => t.title).sort(), ["Carla", "Dani"]);
    for (const chat of chats) {
      const contact = await contactIn(s, chat._id);
      // Its chat, what's said there, its own record; never another's, nor the space's.
      assertEquals((await read<Thread>("thread", contact)).map((t) => t._id), [chat._id]);
      assert((await read<Message>("message", contact)).every((m) => m.thread === chat._id));
      assertEquals((await read<{ _id: string }>("contact", contact)).map((c) => c._id), [
        contact.id,
      ]);
      assertEquals(await read("whatsapp_number", contact), []);
      assertEquals(await read("whatsapp_phone", contact), []);
      assertEquals(await read("whatsapp_thread", contact), []);
      await assertRejects(() => runtime.query("thread.recent", { in: launch }, { actor: contact }));
    }
  });
});

test("a chat quiet for the number's gap is over: the customer's next message starts a new one", async () => {
  await setup(async (s) => {
    const { runtime, deliver, launch } = s;
    await open(s);
    const write = (text: string) => deliver([{ text: { body: text } }], { from: CARLA });
    await write("first");
    const [first] = await threadsOf(runtime, launch);
    // Quiet for 11 hours: still the same chat.
    await runtime.call("test.age", { thread: first._id, hours: 11 });
    await write("still there?");
    assertEquals((await threadsOf(runtime, launch)).length, 1);
    // Quiet past 12: a new one, the same contact.
    await runtime.call("test.age", { thread: first._id, hours: 13 });
    await write("a new trip");
    const chats = await threadsOf(runtime, launch);
    assertEquals(chats.length, 2);
    const fresh = chats.find((t) => t._id !== first._id)!;
    assertEquals(await said(runtime, fresh._id), [
      [(await said(runtime, first._id))[0][0], "a new trip"],
      ["lead", "heard **Someone: a new trip**"],
    ]);
    // A longer gap keeps it going longer.
    assertEquals((await open(s, { gap: 48 }) as { gap: number }).gap, 48);
    await runtime.call("test.age", { thread: fresh._id, hours: 30 });
    await write("back again");
    assertEquals((await threadsOf(runtime, launch)).length, 2);
  });
});

test("who answers a customer: the number's agent, while it answers in the space; else the space's", async () => {
  await setup(async (s) => {
    const { runtime, deliver, launch, number } = s;
    await assertRejects(() => open(s, { agent: "desk" }), Error, "doesn't answer in this space");
    await runtime.call("member.set", {
      space: launch,
      member: { kind: "agent", id: "desk" },
      role: "editor",
    }, { actor: ana });
    assertEquals((await open(s, { agent: "desk" }) as { agent: string }).agent, "desk");
    await deliver([{ text: { body: "hi" } }], { from: CARLA });
    const [chat] = await threadsOf(runtime, launch);
    assertEquals((await said(runtime, chat._id)).at(-1)?.[0], "desk");
    // Out of the space, it answers no new chats: who answers there does.
    await runtime.call("member.remove", {
      space: launch,
      member: { kind: "agent", id: "desk" },
    }, { actor: ana });
    await deliver([{ text: { body: "hello" } }], { from: STRANGER });
    const other = (await threadsOf(runtime, launch)).find((t) => t._id !== chat._id)!;
    assertEquals((await said(runtime, other._id)).at(-1)?.[0], "lead");
    // Only those who manage the space change it.
    await assertRejects(
      () =>
        runtime.call("whatsapp.set", { number, open: false }, {
          actor: { kind: "person", id: "bob" },
        }),
      Error,
    );
  });
});

test("on an open number, a code still links a phone, a linked phone stays its person's, and commands are theirs", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, launch, personal } = s;
    await open(s);
    // A customer's six digits, or "/new", are what they say to the agent.
    await deliver([{ text: { body: "123456" } }], { from: CARLA });
    await deliver([{ text: { body: "/new" } }], { from: CARLA });
    assertEquals(graph.texts(CARLA), ["heard *Someone: 123456*", "heard *Someone: /new*"]);
    assertEquals((await threadsOf(runtime, launch)).length, 1);
    // Ana links her phone with a code from the app: it's hers, and goes to her Personal space.
    await link(s);
    assert(graph.texts(ANA_PHONE)[0].startsWith("You're linked, Ana!"));
    await deliver([{ text: { body: "my own note" } }]);
    const [mine] = await threadsOf(runtime, personal);
    assertEquals(await said(runtime, mine._id), [
      ["ana", "my own note"],
      ["lead", "heard **ana: my own note**"],
    ]);
    // Closed again, a stranger is told how to link.
    await runtime.call("whatsapp.set", { number: s.number, open: false }, { actor: ana });
    await deliver([{ text: { body: "hello?" } }], { from: STRANGER });
    assert(graph.texts(STRANGER)[0].includes("link this phone"));
  });
});

test("Meta delivering a customer's message again changes nothing: one contact, one chat, one answer", async () => {
  await setup(async (s) => {
    const { runtime, graph, launch, serve, number } = s;
    await open(s);
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "106540352242922" },
            contacts: [{ wa_id: CARLA, profile: { name: "Carla" } }],
            messages: [{ id: "wamid.same", from: CARLA, type: "text", text: { body: "once" } }],
          },
        }],
      }],
    });
    const { sign } = await import("../shared/signature.ts");
    const signature = await sign("app-secret-for-tests-0123", new TextEncoder().encode(body));
    for (let i = 0; i < 3; i++) {
      await serve(
        new Request(`http://localhost/hooks/whatsapp/${number}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": signature },
          body,
        }),
      );
      await runtime.idle();
    }
    const chats = await threadsOf(runtime, launch);
    assertEquals(chats.length, 1);
    assertEquals((await said(runtime, chats[0]._id)).length, 2);
    assertEquals(graph.texts(CARLA).length, 1);
  });
});

test("a customer taken out of their chat starts a new one; an agent's fixed message reaches them", async () => {
  await setup(async (s) => {
    const { runtime, graph, deliver, launch } = s;
    await open(s);
    await deliver([{ text: { body: "hi" } }], { from: CARLA });
    const [chat] = await threadsOf(runtime, launch);
    const carla = await contactIn(s, chat._id);
    // Said by trusted code, without a turn: it goes to their phone like any answer.
    await runtime.call("chat.say", {
      id: "pix-1:paid",
      thread: chat._id,
      from: "lead",
      text: "Payment confirmed!",
    });
    await runtime.idle();
    assertEquals(graph.texts(CARLA).at(-1), "Payment confirmed!");
    await runtime.call("member.remove", { space: chat._id, on: "thread", member: carla }, {
      actor: ana,
    });
    await deliver([{ text: { body: "are you there?" } }], { from: CARLA });
    const chats = await threadsOf(runtime, launch);
    assertEquals(chats.length, 2);
    assertEquals(graph.texts(CARLA).at(-1), "heard *Someone: are you there?*");
    // The same contact, in the new one.
    const fresh = chats.find((t) => t._id !== chat._id)!;
    assertEquals((await contactIn(s, fresh._id)).id, carla.id);
  });
});
