/**
 * A tool call and the conversation it belongs to: a contact in a chat of
 * its own, named by ChatGPT's session or a handle the app gave; the tool
 * run as that contact, written as a step, answered as the app's agents
 * read it; errors that say only what's for the caller; a request sent
 * again answered once; the line's limits; and no way into another
 * conversation.
 */
import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects } from "@std/assert";
import { test } from "../../../../testing/mod.ts";
import type { Message, Step } from "../../../agents/chat/mod.ts";
import { conversationOf } from "../shared/keys.ts";
import { handleIn, runs, said, SECRET, setup } from "./setup.ts";

const SCOPE = { line: "chatgpt" };
const chatOf = (session: string, subject?: string) =>
  conversationOf(SECRET, SCOPE, { session, ...(subject ? { subject } : {}) });

test("a call: a contact in a chat of its own, the tool run as it, a step, the agents' reading", async () => {
  await setup(async (s) => {
    const answer = await s.call("search", { to: "Rio" }, { session: "conv-1", subject: "user-1" });
    assertEquals(answer.status, 200);
    // What the app's own agents read (its View), never what the View leaves out.
    assertEquals(said(answer), "2 trips: Rio 10:30, Rio 14:00");
    assertEquals(answer.body.result?.isError, undefined);
    const { contact, thread } = await chatOf("conv-1", "user-1");
    const [found] = await s.docs<{ _id: string; in: string; via: string }>("contact");
    assertEquals([found._id, found.in, found.via], [contact, "line", "mcp"]);
    const [chat] = (await s.docs<{ _id: string; in: string; title: string }>("thread"))
      .filter((t) => t._id === thread);
    assertEquals([chat.in, chat.title], ["line", "ChatGPT"]);
    // The step, as an agent's: private, from the client, the call with what it returned.
    const [step] = await s.steps(thread);
    assertEquals([step.from, step.private, step.in, step.to], ["ChatGPT", true, "line", []]);
    const [made] = step.toolCalls as Step[];
    assertEquals([made.name, made.input], ["search", { to: "Rio" }]);
    assertEquals(JSON.parse(made.output).secret, "kept out by its View");
    assertMatch(made.id, new RegExp(`^mcp:${thread}:\\d+:[0-9a-f]{16}$`));
    // A chat only steps are written in: its count of messages doesn't move.
    assertEquals((chat as unknown as { messages: number }).messages, 0);
  });
});

test("the tool runs as the conversation's contact: its client, its chat, its step", async () => {
  await setup(async (s) => {
    const who = JSON.parse(said(await s.call("whoami", {}, { session: "conv-1" })));
    const { contact, thread } = await chatOf("conv-1");
    assertEquals(who.kind, "contact");
    assertEquals(who.id, contact);
    assertEquals([who.mcp, who.client, who.agent, who.thread], [
      "chatgpt",
      "ChatGPT",
      "ChatGPT",
      thread,
    ]);
    const [step] = await s.steps(thread);
    assertEquals([who.trigger, who.callId, who.retry], [step._id, step._id, false]);
  });
});

test("one ChatGPT conversation is one chat; another session, or another user, is another", async () => {
  await setup(async (s) => {
    await s.call("pick", { trip: "T1" }, { session: "conv-1", subject: "ana" });
    await s.call("search", { to: "Rio" }, { session: "conv-1", subject: "ana" });
    await s.call("search", { to: "Rio" }, { session: "conv-2", subject: "ana" });
    await s.call("search", { to: "Rio" }, { session: "conv-1", subject: "bob" });
    const one = await chatOf("conv-1", "ana");
    assertEquals((await s.steps(one.thread)).length, 2);
    const threads = (await s.docs<{ _id: string }>("thread")).map((t) => t._id);
    assertEquals(threads.length, 3);
    assertEquals((await s.docs("contact")).length, 3);
    assertEquals(
      said(await s.call("peek", {}, { session: "conv-1", subject: "ana" })),
      "Booked: T1",
    );
    assertEquals(
      said(await s.call("peek", {}, { session: "conv-2", subject: "ana" })),
      "No booking.",
    );
  });
});

test("no conversation reaches another's: not by naming its chat, nor by its booking", async () => {
  await setup(async (s) => {
    await s.call("pick", { trip: "T1" }, { session: "conv-1" });
    const theirs = await chatOf("conv-1");
    // Another conversation, naming the first one's chat outright: the rules keep it out.
    assertEquals(
      said(await s.call("peek", { thread: theirs.thread }, { session: "conv-2" })),
      "No booking.",
    );
    // And a handle-less client gets a chat of its own.
    const stranger = await s.call("peek", { thread: theirs.thread });
    assertEquals(said(stranger).split("\n")[0], "No booking.");
    // The contact is let into its chat only, never the space.
    const members = await s.docs<{ member: string; space: string; on?: string }>("member");
    const own = members.filter((m) => m.member === `contact:${theirs.contact}`);
    assertEquals(own.map((m) => m.on).sort(), ["contact", "thread"]);
  });
});

test("a client without a session gets a handle; with it, its calls go on in one chat", async () => {
  await setup(async (s) => {
    const first = await s.call("pick", { trip: "T9" });
    const handle = handleIn(first);
    assert(handle, said(first));
    assertEquals(said(first), `Picked T9.\n\nchat: ${handle}`);
    const second = await s.call("peek", { chat: handle });
    assertEquals(said(second), `Booked: T9\n\nchat: ${handle}`);
    // A handle is never kept: only its chat, by its HMAC.
    const { thread } = await conversationOf(SECRET, SCOPE, { handle });
    assertEquals((await s.steps(thread)).length, 2);
    assertEquals((await s.docs("thread")).length, 1);
    const stored = JSON.stringify([
      await s.docs("message"),
      await s.docs("contact"),
      await s.docs("thread"),
      await s.docs("mcp_call"),
    ]);
    assert(!stored.includes(handle));
    // A new call without one is a new conversation.
    const other = handleIn(await s.call("peek", {}));
    assertNotEquals(other, handle);
    assertEquals((await s.docs("thread")).length, 2);
  });
});

test("a handle the app never gave is refused, and makes nothing", async () => {
  await setup(async (s) => {
    for (const chat of ["made-up", "A".repeat(22), 42]) {
      const refused = await s.call("peek", { chat });
      assertEquals(refused.body.result?.isError, true);
      assertMatch(said(refused), /isn't one this app gave/);
      assertEquals(handleIn(refused), undefined);
    }
    assertEquals(runs.peek, undefined);
    assertEquals((await s.docs("thread")).length, 0);
    assertEquals((await s.docs("contact")).length, 0);
  });
});

test("with a session, a handle sent along is ignored; with handles off, each call is its own chat", async () => {
  await setup(async (s) => {
    const answer = await s.call("search", { to: "Rio", chat: "A".repeat(22) }, { session: "c" });
    assertEquals(said(answer), "2 trips: Rio 10:30, Rio 14:00");
  });
  await setup(async (s) => {
    const first = await s.call("pick", { trip: "T1" });
    assertEquals(said(first), "Picked T1.");
    assertEquals(said(await s.call("peek", {})), "No booking.");
    assertEquals((await s.docs("thread")).length, 2);
  }, { line: { handles: false } });
});

test("errors: a coded one says its message; any other only that it failed, the step keeps it", async () => {
  await setup(async (s) => {
    const boom = await s.call("boom", {}, { session: "c" });
    assertEquals(boom.status, 200);
    assertEquals(boom.body.result?.isError, true);
    assertEquals(said(boom), "Something went wrong running that tool. Try again in a moment.");
    assert(!boom.text.includes("hunter2") && !boom.text.includes("10.0.0.5"));
    const { thread } = await chatOf("c");
    const [step] = await s.steps(thread);
    assertMatch((step.toolCalls as Step[])[0].output, /^Error: connect ECONNREFUSED/);
    const refused = await s.call("refuse", {}, { session: "c" });
    assertEquals([refused.body.result?.isError, said(refused)], [
      true,
      "That date is in the past.",
    ]);
    // The app's own codes are for the caller too; the runtime's codes about its insides aren't.
    const later = await s.call("later", {}, { session: "c" });
    assertEquals(said(later), "Search trips first: possible now: search_trips.");
    const inside = await s.call("inside", {}, { session: "c" });
    assertEquals(said(inside), "Something went wrong running that tool. Try again in a moment.");
    // Input that doesn't fit the tool's schema: said, so the model can mend it.
    const wrong = await s.call("search", { to: 5 }, { session: "c" });
    assertEquals(wrong.body.result?.isError, true);
    assertMatch(said(wrong), /search input/);
    assertEquals(runs.search, undefined);
  });
});

test("a request sent again is answered from the first, once; another under the same id is a new call", async () => {
  await setup(async (s) => {
    const first = await s.call("pick", { trip: "T1" }, { session: "c", id: 7 });
    const again = await s.call("pick", { trip: "T1" }, { session: "c", id: 7 });
    assertEquals(said(again), said(first));
    assertEquals(runs.pick, 1);
    const { thread } = await chatOf("c");
    assertEquals((await s.steps(thread)).length, 1);
    // A client that numbers each call from 1: the same id, asking something else, runs.
    const other = await s.call("pick", { trip: "T2" }, { session: "c", id: 7 });
    assertEquals(said(other), "Picked T2.");
    assertEquals(runs.pick, 2);
    // An error is answered again the same way.
    await s.call("boom", {}, { session: "c", id: 8 });
    const boomAgain = await s.call("boom", {}, { session: "c", id: 8 });
    assertEquals([boomAgain.body.result?.isError, runs.boom], [true, 1]);
    // Two minutes after its answer, the same request is asked again for a reason: it runs.
    await s.runtime.call("test.age", { ms: 121_000 });
    await s.call("pick", { trip: "T1" }, { session: "c", id: 7 });
    assertEquals(runs.pick, 3);
    assertEquals((await s.steps(thread)).map((m) => (m.toolCalls as Step[])[0].name), [
      "pick",
      "pick",
      "boom",
      "pick",
    ]);
  });
});

test("the same request twice at once runs once: the second joins the first", async () => {
  await setup(async (s) => {
    const [a, b] = await Promise.all([
      s.call("slow", {}, { session: "c", id: "same" }),
      s.call("slow", {}, { session: "c", id: "same" }),
    ]);
    assertEquals([said(a), said(b)], ["Done, slowly.", "Done, slowly."]);
    assertEquals(runs.slow, 1);
    // Two different calls at once, in a new conversation: both run, in one chat.
    const [c, d] = await Promise.all([
      s.call("search", { to: "A" }, { session: "new" }),
      s.call("search", { to: "B" }, { session: "new" }),
    ]);
    assertEquals([said(c), said(d)], ["2 trips: A 10:30, A 14:00", "2 trips: B 10:30, B 14:00"]);
    const { thread } = await chatOf("new");
    assertEquals((await s.steps(thread)).length, 2);
    assertEquals(
      (await s.docs<{ _id: string }>("thread")).filter((t) => t._id === thread).length,
      1,
    );
  });
});

test("limits: calls a minute in a conversation, and in all; past them, refused, nothing written", async () => {
  await setup(async (s) => {
    for (let i = 0; i < 2; i++) await s.call("search", { to: `R${i}` }, { session: "c" });
    const third = await s.call("search", { to: "R3" }, { session: "c" });
    assertEquals(third.body.result?.isError, true);
    assertMatch(said(third), /Too many calls in this conversation/);
    const { thread } = await chatOf("c");
    assertEquals((await s.steps(thread)).length, 2);
    assertEquals(runs.search, 2);
    // Another conversation still goes on, until the line's own limit.
    assertEquals(
      said(await s.call("search", { to: "X" }, { session: "d" })).slice(0, 7),
      "2 trips",
    );
    const busy = await s.call("search", { to: "Y" }, { session: "e" });
    assertMatch(said(busy), /busy/);
    assertEquals((await s.docs("contact")).length, 2);
  }, { line: { limits: { perMinute: 2, linePerMinute: 4 } } });
});

test("limits: new conversations an hour, on the line and by user", async () => {
  await setup(async (s) => {
    await s.call("search", { to: "A" }, { session: "s1", subject: "ana" });
    const second = await s.call("search", { to: "A" }, { session: "s2", subject: "ana" });
    assertMatch(said(second), /Too many new conversations/);
    // Her first conversation goes on; someone else's new one is taken.
    assertEquals(
      said(await s.call("search", { to: "B" }, { session: "s1", subject: "ana" })).slice(0, 7),
      "2 trips",
    );
    assertEquals(
      said(await s.call("search", { to: "C" }, { session: "s3", subject: "bob" })).slice(0, 7),
      "2 trips",
    );
    assertEquals((await s.docs("contact")).length, 2);
  }, { line: { limits: { userChatsPerHour: 1 } } });
  await setup(async (s) => {
    await s.call("search", { to: "A" }, { session: "s1" });
    const refused = await s.call("search", { to: "A" }, { session: "s2" });
    assertMatch(said(refused), /busy/);
    const handled = await s.call("search", { to: "A" });
    assertEquals(handleIn(handled), undefined);
    assertEquals((await s.docs("thread")).length, 1);
  }, { line: { limits: { chatsPerHour: 1 } } });
});

test("an answer is cut past the line's result limit", async () => {
  await setup(async (s) => {
    const answer = await s.call("search", { to: "Rio" }, { session: "c" });
    assertEquals(said(answer), "2 trips: \n[…cut]");
  }, { line: { limits: { result: 9 } } });
});

test("a conversation its people took the contact out of is closed for good", async () => {
  await setup(async (s) => {
    await s.call("pick", { trip: "T1" }, { session: "c" });
    const { contact, thread } = await chatOf("c");
    await s.runtime.call("test.out", { thread, contact });
    const closed = await s.call("peek", {}, { session: "c" });
    assertEquals(closed.body.result?.isError, true);
    assertMatch(said(closed), /closed/);
    assertEquals(runs.peek, undefined);
    assertEquals((await s.steps(thread)).length, 1);
  });
});

test("mcp.call: only the contact the MCP route makes for that line may call it", async () => {
  await setup(async (s) => {
    const input = { line: "chatgpt", tool: "search", input: { to: "Rio" }, call: "x", by: "new" };
    for (
      const actor of [
        { kind: "contact", id: "c-123456789012" },
        { kind: "contact", id: "c-123456789012", mcp: "other" },
        { kind: "person", id: "ana" },
        { kind: "visitor", id: "" },
      ]
    ) {
      await assertRejects(
        () => s.runtime.call("mcp.call", input, { actor }),
        Error,
        "may not call",
      );
    }
    assertEquals(runs.search, undefined);
  });
});

test("staff read a conversation's chat as any in their space: its steps, in order", async () => {
  await setup(async (s) => {
    await s.call("search", { to: "Rio" }, { session: "c" });
    await s.call("pick", { trip: "T1" }, { session: "c" });
    const { thread } = await chatOf("c");
    const steps = await s.steps(thread);
    assertEquals(steps.map((m) => (m.toolCalls as Step[])[0].name), ["search", "pick"]);
    const messages = await s.docs<Message>("message", thread);
    assertEquals(messages.every((m) => m.private), true);
  });
});
