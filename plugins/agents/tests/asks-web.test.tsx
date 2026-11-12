/**
 * What agents wait on you for, over where you type (`chat.asks`): an agent's
 * cards wait for its own turn to be over, never for another agent still
 * working; what's asked in a side thread shows in the conversation too,
 * saying so. Each card offers only the answers its ask takes, in its order:
 * a share never "always"; publishing only once, or no. A share says where it
 * would go, who'd see it, and what it would say; an answer handed back, that
 * it would go here or to you alone. A kind a front end shows itself (a
 * computer's command) is its View inside chat's card.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { Approval } from "../chat/contract.ts";
import { asksView } from "../chat/views/web/asks.tsx";
import { waitingView } from "../chat/views/web/asking.tsx";
import { test } from "../../../testing/mod.ts";

const asked = (more: Partial<Approval> & Pick<Approval, "_id" | "agent" | "work">): Approval =>
  ({
    owner: "ana",
    for: "ana",
    on: "d1",
    thread: "t1",
    detail: "",
    answers: ["once", "thread", "always", "deny"],
    status: "pending",
    at: "2026-11-03T21:00:00.000Z",
    ...more,
  }) as Approval;

/** A computer's command, as computers asks it. */
const command = (agent: string, detail: string, more: Partial<Approval> = {}) =>
  asked({
    _id: `a-${agent}`,
    agent,
    work: "terminal",
    detail,
    text: `run ${detail} on laptop`,
    ...more,
  });

/** A share into Launch, with its 12 members. */
const share = (more: Partial<Approval> = {}) =>
  asked({
    _id: "s1",
    agent: "scout",
    work: "share",
    on: "launch",
    detail: "Launch",
    name: "Launch",
    text: "post this to Launch",
    covers: "post to Launch",
    people: 12,
    preview: "We ship on Tuesday; the budget holds.",
    answers: ["once", "thread", "deny"],
    ...more,
  });

/** The cards, as they show with these hints; `views`, the `askViews` a front end gives. */
const shown = (
  pending: Approval[],
  hints: Record<string, unknown>,
  views: Record<string, unknown> = {},
  shows: [string, unknown, unknown][] = [],
) => {
  const ctx = {
    db: { collection: () => ({ query: () => ({ status: "ready", value: pending }) }) },
    resources: {
      agents: {
        east: { name: "East", instructions: "" },
        south: { name: "South" },
        scout: { name: "Scout" },
      },
      askViews: views,
    },
    name: "chat.asks",
    hints,
    show: (kind: string, item: unknown, given: unknown) => {
      shows.push([kind, item, given]);
      return <i data-kind={kind}>shown by {kind}</i>;
    },
    call: () => Promise.resolve({} as never),
    emit: () => Promise.resolve(),
  } as unknown as ViewContext<ReactNode>;
  return renderToStaticMarkup(<>{asksView({}, ctx)}</>).replace(/<style[\s\S]*?<\/style>/g, "");
};

/** The answers a card offers, as its buttons say them, in order. */
const answers = (html: string) =>
  [...html.matchAll(/<button[^>]*>([^<]*)(?:<span class="ask-key"[^>]*>\d<\/span>)?<\/button>/g)]
    .map((m) => m[1]);

test("an agent's ask shows once its turn is over, while another agent works on", () => {
  const east = command("east", "ls -la");
  // East has said why and stopped; South is still working: East's card shows.
  const html = shown([east], { thread: "t1", working: true, busy: ["south"] });
  assertStringIncludes(html, "East");
  assertStringIncludes(html, "ls -la");
  // While East itself is still writing, its explanation comes first.
  assert(!shown([east], { thread: "t1", working: true, busy: ["east"] }).includes("ls -la"));
  // Each agent's by its own turn: South's waits, East's shows.
  const both = shown([east, command("south", "rm -rf build")], {
    thread: "t1",
    working: true,
    busy: ["south"],
  });
  assert(both.includes("ls -la") && !both.includes("rm -rf build"), both);
  // Another conversation's asks don't show here.
  assert(!shown([east], { thread: "t2", busy: [] }).includes("ls -la"));
});

test("an ask in a side thread shows in its conversation, saying where it was asked", () => {
  const east = command("east", "df -h", { thread: "t1-side" });
  const html = shown([east], { thread: "t1", side: ["t1-side"], busy: [] });
  assertStringIncludes(html, "df -h");
  assertStringIncludes(html, "in a side thread");
  // Not another conversation's side thread.
  assert(!shown([east], { thread: "t1", side: ["t2-side"], busy: [] }).includes("df -h"));
  // Seen in the side thread itself, it's just here.
  assert(!shown([east], { thread: "t1-side", busy: [] }).includes("in a side thread"));
});

test("a kind a front end shows itself is its View, inside chat's card with chat's answers", () => {
  const shows: [string, unknown, unknown][] = [];
  const east = command("east", "ls -la");
  const html = shown([east], { thread: "t1", busy: [] }, {
    terminal: { view: "computer.ask", icon: "terminal" },
  }, shows);
  assertStringIncludes(html, "shown by computer.ask");
  assertEquals(shows, [["computer.ask", east, { agent: "East", aside: false }]]);
  assertEquals(answers(html), [
    "Yes, this once",
    "Yes, for this conversation",
    "Yes, always",
    "No",
  ]);
});

test("a computer's answers are as it asks: publishing is only once, or no", () => {
  const publish = command("east", "publish Shop", {
    work: "publish",
    text: "publish Shop on laptop",
    answers: ["once", "deny"],
  });
  assertEquals(answers(shown([publish], { thread: "t1", busy: [] })), ["Yes, this once", "No"]);
  // A routine's run can be let for that routine.
  const routine = command("east", "df", {
    answers: ["once", "thread", "origin", "always", "deny"],
    origin: { kind: "routine", id: "r1", name: "Disk", rev: 0 },
  });
  assertEquals(answers(shown([routine], { thread: "t1", busy: [] })), [
    "Yes, this once",
    "Yes, for this conversation",
    "Yes, for this routine",
    "Yes, always",
    "No",
  ]);
});

test("a share says where it would go, who'd see it, and what it would say; never always", () => {
  const html = shown([share()], { thread: "t1", busy: [] });
  assertStringIncludes(html, "Post this to <b>Launch</b>?");
  assertStringIncludes(html, "Its 12 members will see it.");
  assertStringIncludes(
    html,
    "Scout&#x27;s work here may draw on things not everyone there can see.",
  );
  assertStringIncludes(html, "We ship on Tuesday; the budget holds.");
  assertEquals(answers(html), ["Yes, this once", "Yes, for this conversation", "No"]);
  assert(!html.includes("always"), html);
  // Set going by a routine, it can be let for that routine; still never always.
  const routine = shown([
    share({
      answers: ["once", "thread", "origin", "deny"],
      origin: { kind: "routine", id: "r1", name: "Weekly", rev: 2 },
    }),
  ], { thread: "t1", busy: [] });
  assertEquals(answers(routine), [
    "Yes, this once",
    "Yes, for this conversation",
    "Yes, for this routine",
    "No",
  ]);
  assert(!routine.includes("Yes, always"), routine);
});

test("a share into a contact's chat is sent to them, by name", () => {
  const html = shown([
    share({
      on: "thread:c9",
      name: "Maria",
      detail: "Maria",
      text: "send this to Maria",
      people: 1,
    }),
  ], { thread: "t1", busy: [] });
  assertStringIncludes(html, "Send this to <b>Maria</b>?");
  assertStringIncludes(html, "things Maria can&#x27;t see");
  assert(!html.includes("members will see it"), html);
});

test("an answer handed back: post it here, or send it to you only", () => {
  const html = shown([
    asked({
      _id: "b1",
      agent: "scout",
      work: "back",
      on: "launch",
      detail: "Launch",
      name: "Launch",
      text: "post its answer in Launch",
      people: 4,
      preview: "The numbers for Q3 are in.",
      answers: ["here", "me"],
    }),
  ], { thread: "t1", busy: [] });
  assertStringIncludes(html, "Post Scout&#x27;s answer here?");
  assertStringIncludes(html, "Its 4 members will see it.");
  assertStringIncludes(html, "The numbers for Q3 are in.");
  assertEquals(answers(html), ["Post here", "Send it to me only"]);
});

test("each answer has its key, for the keyboard, and the card says what's asked", () => {
  const html = shown([share()], { thread: "t1", busy: [] });
  assertStringIncludes(html, 'role="group" aria-label="Answers"');
  for (const n of [1, 2, 3]) assertStringIncludes(html, `aria-keyshortcuts="${n}"`);
  assertStringIncludes(html, 'aria-label="Scout wants to post this to Launch"');
});

test("in the sidebar: what waits on you in other chats, each a link to its chat", () => {
  const ctx = (pending: Approval[], path = "/") =>
    ({
      db: { collection: () => ({ query: () => ({ status: "ready", value: pending }) }) },
      resources: { agents: { scout: { name: "Scout", instructions: "" } } },
      name: "chat.waiting",
      hints: { path },
    }) as unknown as ViewContext<ReactNode>;
  const html = renderToStaticMarkup(<>{waitingView({}, ctx([share({ in: "s1" })]))}</>);
  assertStringIncludes(html, "Scout needs your OK");
  assertStringIncludes(html, "post this to Launch");
  assertStringIncludes(html, 'href="/thread/t1?in=s1"');
  // The chat open asks in place.
  assertEquals(renderToStaticMarkup(<>{waitingView({}, ctx([share()], "/thread/t1"))}</>), "");
});
