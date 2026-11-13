/**
 * What agents wait on you for, over where you type (`chat.asks`): an agent's
 * cards wait for its own turn to be over, never for another agent still
 * working; what's asked in a side thread shows in the conversation too,
 * saying so. Each card offers only the answers its ask takes, in its order:
 * a share never "always"; publishing only once, or no. A share says where it
 * would go, who'd see it, and what it would say; an answer handed back, that
 * it would go here or to you alone. A kind a front end shows itself (a
 * computer's command) is its View inside chat's card. Every word is chat's
 * (`chat.<key>`), said from what each ask is (where, to how many), never
 * from a stored sentence: English by default, the app's when it gives them,
 * in the cards, the sidebar and the terminal's notice alike.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { Approval } from "../chat/contract.ts";
import { asksView, tipOf } from "../chat/views/web/asks.tsx";
import { waitingView } from "../chat/views/web/asking.tsx";
import { approvalsView } from "../chat/views/terminal/asks.ts";
import { setWords } from "../../../hosts/web/mod.ts";
import { plain } from "../../../hosts/terminal/contract.ts";
import { englishLeft, pseudoWords } from "../../../testing/words.ts";
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

/** A share into Launch, with its 12 members: where, and to how many, as chat keeps it. */
const share = (more: Partial<Approval> = {}) =>
  asked({
    _id: "s1",
    agent: "scout",
    work: "share",
    on: "launch",
    detail: "Launch",
    name: "Launch",
    people: 12,
    preview: "We ship on Tuesday; the budget holds.",
    answers: ["once", "thread", "deny"],
    ...more,
  });

/** An answer handed back to Launch, waiting on where it goes. */
const back = (more: Partial<Approval> = {}) =>
  asked({
    _id: "b1",
    agent: "scout",
    work: "back",
    on: "launch",
    detail: "Launch",
    name: "Launch",
    people: 4,
    preview: "The numbers for Q3 are in.",
    answers: ["here", "me"],
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
  const html = shown([share({ on: "thread:c9", name: "Maria", detail: "Maria", people: 1 })], {
    thread: "t1",
    busy: [],
  });
  assertStringIncludes(html, "Send this to <b>Maria</b>?");
  assertStringIncludes(html, "things Maria can&#x27;t see");
  assert(!html.includes("members will see it"), html);
});

test("an answer handed back: post it here, or send it to you only", () => {
  const html = shown([back()], { thread: "t1", busy: [] });
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

const routine = { kind: "routine", id: "r1", name: "Weekly", rev: 2 };

/** The sidebar, with what waits on Ana in other chats. */
const sidebar = (pending: Approval[]) =>
  renderToStaticMarkup(
    <>
      {waitingView(
        {},
        {
          db: { collection: () => ({ query: () => ({ status: "ready", value: pending }) }) },
          resources: { agents: { scout: { name: "Scout", instructions: "" } } },
          name: "chat.waiting",
          hints: { path: "/" },
        } as unknown as ViewContext<ReactNode>,
      )}
    </>,
  );

/** Every card and the sidebar, as their words say them (tips too, which show on hover). */
function everything(): string {
  const routed = share({ answers: ["once", "thread", "origin", "deny"], origin: routine });
  const cards = shown([
    routed,
    share({ _id: "s2", on: "thread:c9", name: "Maria", detail: "Maria", people: 1 }),
    back(),
    command("east", "df -h", { thread: "t1-side" }),
  ], { thread: "t1", side: ["t1-side"], busy: [] });
  const tips = [routed, back()].flatMap((a) =>
    a.answers.map((answer) => tipOf(answer, a, "Scout"))
  );
  const waiting = sidebar(
    ["a", "b", "c", "d", "e"].map((t) => share({ _id: `w-${t}`, thread: `t-${t}` })),
  );
  // Class names and addresses are code, not words.
  return [cards, waiting, ...tips].join("\n").replace(/ (class|href|id)="[^"]*"/g, "");
}

test("the cards' words are chat's, said from what each ask is: English by default, else the app's", () => {
  const english = everything();
  for (
    const phrase of [
      "Post this to <b>Launch</b>?",
      "Its 12 members will see it.",
      "Send this to <b>Maria</b>?",
      "Post Scout&#x27;s answer here?",
      "It may draw on things not everyone here can see.",
      "in a side thread ·",
      'aria-label="What Scout would post"',
      'aria-label="What Scout answered"',
      'aria-label="Scout wants to post this to Launch"',
      "Scout may post this to Launch, this once.",
      "Scout may post to Launch without asking again, in this conversation.",
      "Scout may post to Launch without asking again, whenever “Weekly” runs, until it's",
      "Scout is told no, and goes on without it.",
      "It goes in this conversation, for everyone in it.",
      "It goes to your Personal space, where only you see it.",
      "and 2 more chats waiting on you",
    ]
  ) assertStringIncludes(english, phrase);
  const restore = setWords(pseudoWords("chat"));
  try {
    const all = everything();
    assertEquals(englishLeft(all, "chat"), []);
    for (const key of ["askPost", "askBack", "answerOnce", "letsOrigin", "moreWaiting"]) {
      assertStringIncludes(all, `«chat.${key}»`);
    }
  } finally {
    restore();
  }
});

test("a second language says each ask, its answers and who'd see it", () => {
  const restore = setWords({
    "chat.askPost": "Publicar isto em {place}?",
    "chat.seenByMembers": { one: "O único membro vai ver.", other: "Os {count} membros vão ver." },
    "chat.workMayDraw": "O trabalho de {agent} aqui pode usar o que nem todos lá veem.",
    "chat.answerOnce": "Sim, só desta vez",
    "chat.answerThread": "Sim, nesta conversa",
    "chat.answerNo": "Não",
    "chat.wantsTo": "{agent} quer {doing}",
    "chat.doingPost": "publicar isto em {place}",
    "chat.needsYourOk": "{agent} precisa do seu OK",
    "chat.letsOnce": "{agent} pode {doing}, só desta vez.",
  });
  try {
    const html = shown([share()], { thread: "t1", busy: [] });
    assertStringIncludes(html, "Publicar isto em <b>Launch</b>?");
    assertStringIncludes(html, "Os 12 membros vão ver.");
    assertStringIncludes(html, "O trabalho de Scout aqui pode usar o que nem todos lá veem.");
    assertEquals(answers(html), ["Sim, só desta vez", "Sim, nesta conversa", "Não"]);
    assertStringIncludes(html, 'aria-label="Scout quer publicar isto em Launch"');
    assertEquals(
      tipOf("once", share(), "Scout"),
      "Scout pode publicar isto em Launch, só desta vez.",
    );
    const waiting = sidebar([share()]);
    assertStringIncludes(waiting, "Scout precisa do seu OK");
    assertStringIncludes(waiting, "publicar isto em Launch");
  } finally {
    restore();
  }
});

test("the terminal's notice says them in chat's words too: what, for whom, who'd see it", () => {
  const notice = () =>
    plain(
      approvalsView(
        { person: "ana" },
        {
          db: {
            collection: () => ({
              query: () => ({ status: "ready", value: [share(), back({ for: "bob" })] }),
            }),
          },
          resources: {},
          hints: {},
        } as unknown as ViewContext,
      ) ?? "",
    );
  const english = notice();
  assertStringIncludes(english, "[1] scout wants to post this to Launch");
  assertStringIncludes(english, "Its 12 members will see it.");
  assertStringIncludes(english, "[2] scout (for bob) wants to post its answer in Launch");
  assertStringIncludes(english, "Its 4 members will see it.");
  const restore = setWords({
    "chat.wantsTo": "{agent} quer {doing}",
    "chat.askerFor": "{agent} (por {name})",
    "chat.doingPostAnswer": "publicar a resposta em {place}",
    "chat.seenByMembers": { one: "O único membro vai ver.", other: "Os {count} membros vão ver." },
  });
  try {
    const pt = notice();
    assertStringIncludes(pt, "[2] scout (por bob) quer publicar a resposta em Launch");
    assertStringIncludes(pt, "Os 4 membros vão ver.");
  } finally {
    restore();
  }
});
