/**
 * A new message brings an archived chat back, in the commit that writes it,
 * by whichever way it comes: a person's, a contact's, one in its staff
 * notes or in a subthread (two levels down too), an agent's answer to a turn
 * that ran on while it was put away, its question, what it sends there from
 * another chat, an answer handed back from another space (on its own, or
 * where its asker says), trusted code's `chat.say`, a routine's run. What an
 * agent does privately (a tool's step) doesn't. And what's archived after a
 * message stays archived.
 */
import { assert, assertEquals } from "@std/assert";
import type { Actor } from "../../../runtime/mod.ts";
import { test } from "../../../testing/mod.ts";
import type { Approval, Message } from "../chat/mod.ts";
import { ana, archiveKit, bob, carla, gate, type Kit, until } from "./archive-kit.ts";
import { yesToShares } from "./yes.ts";

const archive = (k: Kit, thread: string, actor: Actor = ana) =>
  k.runtime.call("chat.archive", { thread, archived: true }, { actor });

const archived = async (k: Kit, thread: string) => !!(await k.thread(thread))?.archived;

/**
 * That `message` brought `chat` back in its own commit: the chat's `archived`
 * went in a change recorded with the message's, by the same cause.
 */
function broughtBack(k: Kit, from: number, chat: string, message: (m: Message) => boolean) {
  const since = k.events.slice(from);
  const made = since.find((e) => e.type === "message.created" && message(e.data.doc as Message));
  assert(made, "the message was written");
  const back = since.find((e) =>
    e.type === "thread.updated" && e.data._id === chat &&
    (e.data.removed as string[]).includes("archived")
  );
  assert(back, "the chat came back");
  assertEquals([back.cause, back.at], [made.cause, made.at], "in the same commit");
}

/** Sends as someone without waiting for what follows (an agent may be held). */
const post = (k: Kit, input: Record<string, unknown>, actor: Actor = ana) =>
  k.runtime.call<{ thread: string; message: string }>("chat.send", input, { actor });

test("a person's message brings it back; one archived after a message stays archived", async () => {
  await archiveKit(async (k) => {
    const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
    await archive(k, plan, bob);
    assert(await archived(k, plan));
    const from = k.events.length;
    const { message } = await post(k, { thread: plan, text: "one more thing" }, bob);
    broughtBack(k, from, plan, (m) => m._id === message);
    assertEquals(await archived(k, plan), false);
    await k.runtime.idle();
    // Said, then put away: it stays put away (what came last is the archive).
    await archive(k, plan, bob);
    await k.runtime.idle();
    assert(await archived(k, plan));
    assertEquals((await k.recent(ana, { in: k.shop })).map((t) => t._id), [k.carlas]);
  });
});

test("a contact's message brings her chat back, with its notes", async () => {
  await archiveKit(async (k) => {
    await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
    const { thread: notes } = await k.runtime.call<{ thread: string }>("chat.notes", {
      thread: k.carlas,
    }, { actor: bob });
    await k.send({ thread: notes, text: "she ordered on Monday" }, bob);
    await archive(k, k.carlas, bob);
    const from = k.events.length;
    const { message } = await post(k, { thread: k.carlas, text: "any news?" }, carla);
    broughtBack(k, from, k.carlas, (m) => m._id === message);
    await k.runtime.idle();
    assertEquals(
      (await k.recent(bob, { in: k.shop })).map((t) => t._id).sort(),
      [
        k.carlas,
        notes,
      ].sort(),
    );
  });
});

test("a message in its staff notes brings the chat back", async () => {
  await archiveKit(async (k) => {
    await k.send({ thread: k.carlas, text: "where's my order?" }, carla);
    const { thread: notes } = await k.runtime.call<{ thread: string }>("chat.notes", {
      thread: k.carlas,
    }, { actor: bob });
    await archive(k, k.carlas, bob);
    const from = k.events.length;
    const { message } = await post(k, { thread: notes, text: "she ordered on Monday" }, bob);
    broughtBack(k, from, k.carlas, (m) => m._id === message);
    await k.runtime.idle();
    // And the agent's answer there, to a message before the chat was archived again.
    const held = gate();
    k.holds.lead = held.opened;
    await post(k, { thread: notes, text: "@lead what do we know?" }, bob);
    await archive(k, k.carlas, bob);
    const again = k.events.length;
    held.open();
    await k.runtime.idle();
    broughtBack(k, again, k.carlas, (m) => m.from === "lead" && m.thread === notes);
  });
});

test("an agent's answer brings back a chat archived while it worked", async () => {
  await archiveKit(async (k) => {
    const held = gate();
    k.holds.lead = held.opened;
    const { thread } = await post(k, { in: k.shop, text: "the plan for the quarter" });
    await archive(k, thread);
    assert(await archived(k, thread));
    const from = k.events.length;
    held.open();
    await k.runtime.idle();
    broughtBack(k, from, thread, (m) => m.from === "lead" && !m.private);
    assertEquals(await archived(k, thread), false);
  });
});

test("an agent's question, and what it sends there, bring it back", async () => {
  await archiveKit(async (k) => {
    // A tool that asks Ana before it goes on.
    let held = gate();
    k.holds.lead = held.opened;
    const { thread } = await post(k, { in: k.shop, text: "check" });
    await archive(k, thread);
    let from = k.events.length;
    held.open();
    await k.runtime.idle();
    broughtBack(k, from, thread, (m) => m.from === "lead" && m.to.includes("ana") && !m.private);
    // Its message to Ana, there.
    held = gate();
    k.holds.lead = held.opened;
    const { thread: other } = await post(k, { in: k.shop, text: "ask ana" });
    await archive(k, other);
    from = k.events.length;
    held.open();
    await k.runtime.idle();
    broughtBack(k, from, other, (m) => m.text === "Which one?");
  });
});

test("a subthread's messages bring its chat back, two levels down too", async () => {
  await archiveKit(async (k) => {
    // The message that opens a subthread, in the chat.
    const lead = gate();
    const scout = gate();
    k.holds.lead = lead.opened;
    k.holds.scout = scout.opened;
    const { thread: side } = await post(k, { in: k.shop, text: "sub prices" });
    await archive(k, side);
    let from = k.events.length;
    lead.open();
    await until(async () => (await k.messages(side)).some((m) => m.subthread), "a subthread");
    broughtBack(k, from, side, (m) => !!m.subthread);
    const sub = (await k.messages(side)).find((m) => m.subthread)!.subthread!;
    // Scout's answer, in the subthread: Lead waits to go on.
    const after = gate();
    k.holds.lead = after.opened;
    await archive(k, side);
    from = k.events.length;
    scout.open();
    await until(async () => (await k.messages(sub)).some((m) => m.from === "scout"), "an answer");
    broughtBack(k, from, side, (m) => m.from === "scout" && m.thread === sub);
    after.open();
    await k.runtime.idle();
    // Someone writing in the subthread itself.
    await archive(k, side);
    from = k.events.length;
    const { message } = await post(k, { thread: sub, text: "@scout and shipping?" });
    broughtBack(k, from, side, (m) => m._id === message);
    await k.runtime.idle();

    // Two levels: Scout asks Deep in a subthread of its own.
    const deep = gate();
    k.holds.deep = deep.opened;
    const { thread: far } = await post(k, { in: k.shop, text: "deep costs" });
    await until(
      async () => {
        const opening = (await k.messages(far)).find((m) => m.subthread);
        return !!opening && (await k.messages(opening.subthread!)).some((m) => m.subthread);
      },
      "a subthread in a subthread",
    );
    const first = (await k.messages(far)).find((m) => m.subthread)!.subthread!;
    const second = (await k.messages(first)).find((m) => m.subthread)!.subthread!;
    const waiting = gate();
    k.holds.scout = waiting.opened;
    await archive(k, far);
    from = k.events.length;
    deep.open();
    await until(async () => (await k.messages(second)).some((m) => m.from === "deep"), "Deep");
    broughtBack(k, from, far, (m) => m.from === "deep");
    waiting.open();
    await k.runtime.idle();
  });
});

test("what an agent sends into an archived chat from another one brings it back", async () => {
  await archiveKit(async (k) => {
    const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
    await archive(k, plan);
    const held = gate();
    k.holds.scout = held.opened;
    const from = k.events.length;
    await post(k, { in: k.shop, text: `tell ${plan}` });
    await until(async () => (await k.messages(plan)).some((m) => m.text === "For you."), "sent");
    broughtBack(k, from, plan, (m) => m.text === "For you.");
    held.open();
    await k.runtime.idle();
  });
});

/** A space where Scout answers and Lead doesn't, for work handed over. */
async function research(k: Kit) {
  await k.runtime.call("space.create", { id: "research", name: "Research" }, { actor: ana });
  await k.runtime.call("member.set", {
    space: "research",
    member: { kind: "agent", id: "scout" },
    role: "editor",
  }, { actor: ana });
  await k.runtime.call("member.remove", {
    space: "research",
    member: { kind: "agent", id: "lead" },
  }, { actor: ana });
}

test("an answer handed back brings back the chat it was handed from", async () => {
  await archiveKit(async (k) => {
    await research(k);
    // From Ana's Personal space, the answer comes back on its own; Scout works on it meanwhile.
    const held = gate();
    k.holds.scout = held.opened;
    const { thread } = await post(k, { in: k.personal, text: "hand research: what's new?" });
    const shares = async () =>
      (await k.runtime.query<Approval[]>("approval.pending", {}, { actor: ana }))
        .filter((a) => a.work === "share");
    const handed = async () => (await k.recent(ana, { in: "research" })).length > 0;
    await until(async () => (await shares()).length > 0 || await handed(), "asked first");
    for (const asked of await shares()) {
      await k.runtime.call("chat.approve", { approval: asked._id, answer: "once" }, { actor: ana });
    }
    await until(handed, "handed over");
    await archive(k, thread);
    const from = k.events.length;
    held.open();
    await k.runtime.idle();
    broughtBack(k, from, thread, (m) => m.from === "scout" && m.thread === thread);
  });
});

test("an answer handed back where its asker says brings that chat back, either way", async () => {
  for (const answer of ["here", "me"]) {
    await archiveKit(async (k) => {
      await research(k);
      // From the shop, the answer waits on Ana: the shop's people can't all see Research.
      const { thread } = await post(k, { in: k.shop, text: "hand research: what's new?" });
      await k.runtime.idle();
      await yesToShares(k.runtime, ana);
      const asked = (await k.runtime.query<Approval[]>("approval.pending", {}, { actor: ana }))
        .find((a) => a.work === "back")!;
      await archive(k, thread);
      const from = k.events.length;
      await k.runtime.call("chat.approve", { approval: asked._id, answer }, { actor: ana });
      await k.runtime.idle();
      broughtBack(k, from, thread, (m) => m.from === "scout" && m.thread === thread);
    });
  }
});

test("trusted code's chat.say and a routine's run bring it back", async () => {
  await archiveKit(async (k) => {
    const plan = await k.send({ in: k.shop, text: "the plan for the quarter" });
    await archive(k, plan);
    let from = k.events.length;
    await k.runtime.call("chat.say", {
      id: "payment-1",
      thread: plan,
      from: "lead",
      text: "Payment confirmed.",
    });
    broughtBack(k, from, plan, (m) => m.text === "Payment confirmed.");
    await archive(k, plan);
    from = k.events.length;
    // As a routine's run sends: its maker's message, marked as the routine's.
    const routine = { kind: "routine", id: "r1", name: "Daily", rev: 0, path: "/routines/r1" };
    await k.runtime.call("chat.send", {
      thread: plan,
      text: "The daily check",
      to: ["lead"],
      via: { kind: "routine", name: "Daily", path: "/routines/r1" },
    }, { actor: { ...ana, in: k.shop, origin: routine } });
    broughtBack(k, from, plan, (m) => m.text === "The daily check");
    await k.runtime.idle();
  });
});

test("an agent's private step doesn't bring it back; its answer does", async () => {
  await archiveKit(async (k) => {
    const first = gate();
    const second = gate();
    k.holds.lead = first.opened;
    const { thread } = await post(k, { in: k.shop, text: "note" });
    await archive(k, thread);
    first.open();
    k.holds.lead = second.opened;
    await until(
      async () => (await k.messages(thread)).some((m) => m.private && m.toolCalls?.length),
      "the step",
    );
    assert(await archived(k, thread), "a private step brought it back");
    const from = k.events.length;
    second.open();
    await k.runtime.idle();
    broughtBack(k, from, thread, (m) => m.text === "lead done");
  });
});
