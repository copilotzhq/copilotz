/**
 * What an app's front end does with chat's composer, the box where a
 * conversation is typed in. It puts words there (`handDraft`, from chat's
 * contract): typed in after what was handed before, taken once. And it acts
 * before the box sends (the `conversation` resource's `beforeSend`): each
 * hook in order, after the one before, given the conversation, its space,
 * the words, the files and how the page calls Actions; `false` holds the
 * message and stops the rest, and a hook that throws stops them too, its
 * words the send's failure. An entry may be a hook alone, with no View over
 * the box.
 */
import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { isValidElement, type ReactElement } from "react";
import type { ViewContext } from "../../../runtime/mod.ts";
import { test } from "../../../testing/mod.ts";
import { handDraft, type Sending } from "../contract.ts";
import { beforeSend } from "../chat/views/web/before-send.ts";
import { Composer } from "../chat/views/web/composer.tsx";
import { conversationView } from "../chat/views/web/conversation.tsx";
import { handedTo, onHanded, takeDraft } from "../chat/views/web/handed.ts";
import { Over } from "../chat/views/web/over.tsx";

test("an app hands words to a conversation's box through chat's contract: after what's there, taken once", () => {
  let heard = 0;
  const stop = onHanded(() => heard++);
  try {
    handDraft("t1", "Your order 12 left today.");
    handDraft("t1", "Tracking: ABC123.");
    assertEquals(handedTo("t1"), "Your order 12 left today.\n\nTracking: ABC123.");
    assertEquals(handedTo("t2"), undefined);
    // The box takes it once, as it shows.
    assertEquals(takeDraft("t1"), "Your order 12 left today.\n\nTracking: ABC123.");
    assertEquals(takeDraft("t1"), undefined);
    assertEquals(heard, 3);
  } finally {
    stop();
  }
});

const sending: Sending = { thread: "c1", in: "s1", text: "Hi", files: [] };
const noCall = (() => Promise.resolve({})) as ViewContext["call"];

test("hooks run in order, each after the one before; false holds it and stops the rest", async () => {
  const ran: string[] = [];
  const later = (name: string, answer?: boolean) => ({
    beforeSend: async () => {
      await new Promise((r) => setTimeout(r, 5));
      ran.push(name);
      return answer;
    },
  });
  assert(await beforeSend([later("a"), { view: "x" }, later("b", true)], sending, noCall));
  assertEquals(ran, ["a", "b"]);
  ran.length = 0;
  assertEquals(
    await beforeSend([later("a"), later("b", false), later("c")], sending, noCall),
    false,
  );
  assertEquals(ran, ["a", "b"]);
  assert(await beforeSend([], sending, noCall));
});

test("a hook that throws stops the rest, and its words are the send's failure", async () => {
  const ran: string[] = [];
  const entries = [
    { beforeSend: () => void ran.push("a") },
    {
      beforeSend: () => {
        throw new Error("Take the chat over first.");
      },
    },
    { beforeSend: () => void ran.push("c") },
  ];
  await assertRejects(() => beforeSend(entries, sending, noCall), Error, "Take the chat over");
  assertEquals(ran, ["a"]);
});

/** Every element of `type` in what a View returned, however deep in its children. */
function elements(node: unknown, type: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((n) => elements(n, type));
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  const inside = elements(el.props.children, type);
  return el.type === type ? [el, ...inside] : inside;
}

/** A conversation's View context: chat `c1` in Support (`s1`), with the front ends' entries. */
function conversationOf(conversation: Record<string, unknown>) {
  const ctx = {
    name: "web.thread",
    hints: { in: "s1" },
    resources: { conversation },
    viewer: { name: "sam" },
    call: noCall,
    emit: () => Promise.resolve(),
    show: () => null,
    db: {
      collection: (name: string) => ({
        findOne: () => ({
          status: "ready",
          value: name === "thread"
            ? { _id: "c1", in: "s1", title: "Order 12", agents: [], at: "" }
            : name === "space"
            ? { _id: "s1", name: "Support", kind: "shared" }
            : null,
        }),
        find: () => ({ status: "ready", value: [] }),
        query: () => ({ status: "ready", value: undefined }),
      }),
    },
  } as unknown as ViewContext;
  const drawn = conversationView({ _id: "c1" }, ctx as ViewContext<never>);
  return {
    ctx,
    box: elements(drawn, Composer)[0]?.props as Parameters<typeof Composer>[0],
    over: elements(drawn, Over)[0]?.props as Parameters<typeof Over>[0] | undefined,
  };
}

test("a conversation's box asks the front ends' hooks before it sends, with where and what", async () => {
  const given: [Sending, unknown][] = [];
  const desk = {
    view: "desk.bar",
    order: 5,
    beforeSend: (s: Sending, call: unknown) => void given.push([s, call]),
  };
  // A hook alone: nothing over the box.
  const check = { order: 20, beforeSend: (s: Sending) => s.text !== "no" };
  const { ctx, box, over } = conversationOf({ desk, check, gone: null });
  const files = [{ name: "note.webm", type: "audio/webm" }];
  assert(await box.before!({ text: "Hi", files }));
  assertEquals(given.length, 1);
  assertEquals(given[0][0], { thread: "c1", in: "s1", text: "Hi", files });
  assertStrictEquals(given[0][1], ctx.call);
  assertEquals(await box.before!({ text: "no", files: [] }), false);
  // Over the box: the Views alone, chat's own among them when it's there.
  assertEquals(over?.entries.map((e) => e.view), ["desk.bar"]);
  // With no hooks, nothing is asked.
  assertEquals(conversationOf({ desk: { view: "desk.bar" } }).box.before, undefined);
});
