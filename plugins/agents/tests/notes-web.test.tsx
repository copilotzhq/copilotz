// deno-lint-ignore-file jsx-key
/**
 * Staff notes on the web: the lane shows beside a chat shared outside its
 * space, never beside a team chat or the notes themselves; before the notes
 * are made it says what they're for, and the first message makes them, then
 * goes there; a draft in the notes goes on to the chat as the person's own,
 * to the contact alone; notes opened as a page say what they're about, with
 * the way back; naming an agent in a contact's chat offers to ask in the
 * notes instead, moving what's typed there; the notes' box takes the keys
 * only when someone just opened them; and none of it says English once the
 * app gives its words.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setWords } from "../../../hosts/web/mod.ts";
import { englishLeft, pseudoWords } from "../../../testing/words.ts";
import { test } from "../../../testing/mod.ts";
import { Composer, type Mentioned } from "../chat/views/web/composer.tsx";
import { conversationView } from "../chat/views/web/conversation.tsx";
import { takeDraft } from "../chat/views/web/handed.ts";
import { notesOpen, setNotesOpen, takeOpened } from "../chat/views/web/lane.ts";
import { messageView } from "../chat/views/web/message.tsx";
import { MentionHint, NotesBanner } from "../chat/views/web/notes-lane.tsx";
import { notesView } from "../chat/views/web/notes.tsx";
import { SendOn } from "../chat/views/web/send-on.tsx";

/** Who looks: Sam, of the team. The chat `c1` is shared with Ana, a contact. */
const ME = "sam";
const at = new Date().toISOString();
const chat = { _id: "c1", in: "s1", title: "Order 12", agents: ["maya"], at };
const notes = { _id: "c1:notes", in: "s1", about: "c1", title: "Order 12", at };
const team = {
  here: ["maya"],
  default: ["maya"],
  agents: { maya: { name: "Maya", description: "Looks orders up" } },
};
const answer = {
  _id: "m1",
  thread: "c1:notes",
  from: "maya",
  to: ["sam"],
  turn: "r1",
  at,
  text: "Order **12** shipped Monday; tracking is `ABC123`.\n\n- Ask for her *flat* number",
};

type Rows = {
  threads: Record<string, unknown>;
  members?: Record<string, { member: string }[]>;
  messages?: { thread: string }[];
};

/** A View context over fake rows, noting what's called and what's shown. */
function fake(rows: Rows, hints: Record<string, unknown> = {}) {
  const calls: [string, unknown][] = [];
  const shown: [string, unknown, Record<string, unknown>][] = [];
  const ctx = {
    name: "test",
    hints,
    resources: {
      names: {
        people: { collection: "profile" },
        contacts: { collection: "contact", prefix: "contact:" },
      },
    },
    viewer: { name: ME, label: "Sam" },
    call: (action: string, input: unknown) => {
      calls.push([action, input]);
      return Promise.resolve(action === "chat.notes" ? { thread: "c1:notes", about: "c1" } : {});
    },
    emit: () => Promise.resolve(),
    show: (view: string, item: unknown, h: Record<string, unknown> = {}) => {
      shown.push([view, item, h]);
      return null;
    },
    db: {
      collection: (name: string) => ({
        findOne: (filter: { _id: string }) => ({
          status: "ready",
          value: name === "thread"
            ? rows.threads[filter._id] ?? null
            : name === "space"
            ? { _id: "s1", name: "Support", kind: "shared" }
            : null,
        }),
        find: (filter: { space?: string }) => ({
          status: "ready",
          value: name === "member" ? rows.members?.[filter.space ?? ""] ?? [] : [],
        }),
        query: (query: string, params: { thread?: string }) => ({
          status: "ready",
          value: name === "message"
            ? query === "conversation"
              ? (rows.messages ?? []).filter((m) => m.thread === params.thread)
              : []
            : name === "thread"
            ? query === "agents" ? team : undefined
            : query === "names"
            ? { "contact:c9": "Ana", sam: "Sam" }
            : query === "pictures"
            ? {}
            : undefined,
        }),
      }),
    },
  };
  // deno-lint-ignore no-explicit-any
  return { ctx: ctx as any, calls, shown };
}

const shared = { "thread:c1": [{ member: "contact:c9" }] };
const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);

/** Every element of `type` in what a View returned, however deep in its children. */
function elements(node: unknown, type: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((n) => elements(n, type));
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  const inside = elements(el.props.children, type);
  return el.type === type ? [el, ...inside] : inside;
}

/** The composer a View drew, with the props it was given. */
const composerIn = (node: unknown) =>
  elements(node, Composer)[0]?.props as Parameters<
    typeof Composer
  >[0];

const clean = () => {
  setNotesOpen(ME, false);
  try {
    globalThis.localStorage?.removeItem(`copilotz-chat-notes:${ME}`);
  } catch { /* Nothing kept. */ }
};

test("the staff notes lane shows beside a chat shared outside its space, and only there", () => {
  try {
    setNotesOpen(ME, false);
    const contact = fake({ threads: { c1: chat }, members: shared });
    const closed = html(conversationView({ _id: "c1" }, contact.ctx));
    assertStringIncludes(
      closed,
      'class="copilotz-button copilotz-button-outline copilotz-button-sm notes-toggle"',
    );
    assertStringIncludes(closed, 'class="notes-switch"');
    assertStringIncludes(closed, 'aria-expanded="false"');
    assertStringIncludes(closed, "Shared with Ana");
    assert(
      !closed.includes('class="notes-lane"'),
      "nothing of the notes is read while it's closed",
    );

    setNotesOpen(ME, true);
    const open = html(conversationView({ _id: "c1" }, contact.ctx));
    assertStringIncludes(open, 'class="notes-lane"');
    assertStringIncludes(open, "Only your team sees this, never Ana");
    assertStringIncludes(open, 'data-notes="open"');
    assertStringIncludes(open, 'aria-expanded="true"');
    // Their messages counted on the button, once they exist; and a way to open them as a page.
    const counted = fake({
      threads: { c1: chat, "c1:notes": { ...notes, messages: 3 } },
      members: shared,
    });
    const made = html(conversationView({ _id: "c1" }, counted.ctx));
    assertStringIncludes(made, 'aria-label="Staff notes, 3 messages"');
    assertStringIncludes(made, 'href="/thread/c1%3Anotes?in=s1"');

    // A team chat has none, open or not; nor do the notes themselves.
    const teamChat = html(
      conversationView({ _id: "t2" }, fake({ threads: { t2: { ...chat, _id: "t2" } } }).ctx),
    );
    assert(!teamChat.includes('class="notes-toggle') && !teamChat.includes('class="notes-lane"'));
    assert(!teamChat.includes("Shared with"));
    const page = html(
      conversationView(
        { _id: "c1:notes" },
        fake({ threads: { "c1:notes": notes }, members: shared }).ctx,
      ),
    );
    assert(!page.includes('class="notes-toggle') && !page.includes('class="notes-lane"'));
  } finally {
    clean();
  }
});

test("notes opened as a page say what they're about, with the way back to the conversation", () => {
  const page = html(
    conversationView(
      { _id: "c1:notes" },
      fake({ threads: { "c1:notes": notes }, members: shared }).ctx,
    ),
  );
  assertStringIncludes(page, "Staff notes about the conversation with Ana");
  // Headed as what they are, around the chat's own title (stored as it is).
  assertStringIncludes(page, ">Staff notes: Order 12</h1>");
  assertStringIncludes(page, "Only your team sees this");
  assertStringIncludes(page, 'href="/thread/c1?in=s1"');
  assertStringIncludes(page, "Open conversation");
  assertStringIncludes(page, "Ask an agent or leave a note for your team…");
  // A contact with no name yet is "your contact".
  assertStringIncludes(
    html(<NotesBanner name="your contact" href="/thread/c1" />),
    "Staff notes about the conversation with your contact",
  );
});

test("before the notes are made, the lane says what they're for; the first message makes them", async () => {
  const empty = fake({ threads: { c1: chat }, members: shared });
  const shown = notesView({ _id: "c1" }, empty.ctx);
  const markup = html(shown);
  assertStringIncludes(markup, "Your team&#x27;s side of this conversation");
  assertStringIncludes(markup, "Nothing here reaches Ana.");
  assertStringIncludes(markup, "Ask an agent or leave a note for your team…");
  assertStringIncludes(markup, "Only your team sees this");
  const composer = composerIn(shown);
  assertEquals(composer.place, { thread: "c1:notes", in: "s1" });
  assertEquals(composer.agents?.map((a) => a.id), ["maya"]);
  await composer.send("@maya where is order 12?", [], {});
  assertEquals(empty.calls, [
    ["chat.notes", { thread: "c1" }],
    ["chat.send", { thread: "c1:notes", text: "@maya where is order 12?" }],
  ]);

  // Made already: straight there.
  const there = fake({ threads: { c1: chat, "c1:notes": notes }, members: shared });
  await composerIn(notesView({ _id: "c1" }, there.ctx)).send("Noted", [], {});
  assertEquals(there.calls, [["chat.send", { thread: "c1:notes", text: "Noted" }]]);
});

test("a draft in the notes goes on to the chat as the person's own, to the contact alone", async () => {
  const lane = fake({
    threads: { c1: chat, "c1:notes": notes },
    members: shared,
    messages: [answer],
  });
  notesView({ _id: "c1" }, lane.ctx);
  const sendTo = { thread: "c1", to: ["contact:c9"], name: "Ana" };
  assertEquals(lane.shown.find(([view]) => view === "web.message")?.[2].sendTo, sendTo);

  const asked = fake({ threads: {} }, { thread: "c1:notes", sendTo });
  const message = messageView(answer as never, asked.ctx);
  assertStringIncludes(html(message), "Send to Ana…");
  const on = elements(message, SendOn)[0].props as Parameters<typeof SendOn>[0];
  // Its words as the contact reads them: markdown's marks left out, its lines kept.
  assertEquals([on.text, on.name, on.shown], [
    "Order 12 shipped Monday; tracking is ABC123.\n\n- Ask for her flat number",
    "Ana",
    true,
  ]);
  await on.send("Your order shipped Monday: ABC123.");
  assertEquals(asked.calls, [
    ["chat.send", { thread: "c1", text: "Your order shipped Monday: ABC123.", to: ["contact:c9"] }],
  ]);

  // Anywhere else, a message offers nothing of the kind; nor one that failed, or a step.
  assert(
    !html(messageView(answer as never, fake({ threads: {} }, { thread: "c1" }).ctx))
      .includes("Send to"),
  );
  const failed = { ...answer, failed: true };
  assert(!html(messageView(failed as never, asked.ctx)).includes("Send to"));
  const step = { ...answer, toolCalls: [{ id: "x", name: "clock" }] };
  assert(!html(messageView(step as never, asked.ctx)).includes("Send to"));
});

test("naming an agent in a contact's chat says where it would answer, and asks in the notes instead", () => {
  try {
    setNotesOpen(ME, false);
    // Only a chat shared outside its space says so.
    const said = (id: string, threads: Rows["threads"], members?: Rows["members"]) =>
      composerIn(conversationView({ _id: id }, fake({ threads, members }).ctx)).mentionNote;
    assert(said("c1", { c1: chat }, shared));
    assertEquals(said("t2", { t2: { ...chat, _id: "t2" } }), undefined);
    assertEquals(said("c1:notes", { "c1:notes": notes }, shared), undefined);

    const note = composerIn(
      conversationView({ _id: "c1" }, fake({ threads: { c1: chat }, members: shared }).ctx),
    )
      .mentionNote!;
    const typed = (initial: string) =>
      html(
        <Composer
          attach={() => Promise.resolve({ id: "f" })}
          send={() => Promise.resolve()}
          agents={[{ id: "maya", name: "Maya" }]}
          initial={initial}
          mentionNote={note}
        />,
      );
    assertStringIncludes(
      typed("@maya where is order 12?"),
      "Maya will answer here, where Ana can read it.",
    );
    assertStringIncludes(typed("@maya where is order 12?"), "Ask in staff notes");
    assert(!typed("Where is order 12?").includes("will answer here"));
    assert(!typed("@bob where is order 12?").includes("will answer here"));
    // Still being typed, the list open: not yet.
    assert(!typed("Ask @maya").includes("will answer here"));

    // Asking in the notes moves what's typed there, and opens them.
    let cleared = false;
    const hint = MentionHint({
      who: ME,
      notes: "c1:notes",
      name: "Ana",
      typed: {
        text: "@maya where is order 12?",
        agents: [{ id: "maya", name: "Maya" }],
        clear: () => cleared = true,
      } satisfies Mentioned,
    }) as ReactElement<{ action: ReactElement<{ onClick(): void }> }>;
    hint.props.action.props.onClick();
    assert(cleared);
    assert(notesOpen(ME));
    assertEquals(takeDraft("c1:notes"), "@maya where is order 12?");
    assertEquals(takeDraft("c1:notes"), undefined);
  } finally {
    clean();
  }
});

test("with the app's words set, nothing English of the notes or a draft sent on shows", () => {
  const restore = setWords(pseudoWords("chat"));
  try {
    setNotesOpen(ME, true);
    const sendTo = { thread: "c1", to: ["contact:c9"], name: "Ana" };
    const all = [
      conversationView(
        { _id: "c1" },
        fake({ threads: { c1: chat, "c1:notes": { ...notes, messages: 2 } }, members: shared }).ctx,
      ),
      conversationView(
        { _id: "c1:notes" },
        fake({ threads: { "c1:notes": notes }, members: shared }).ctx,
      ),
      notesView({ _id: "c1" }, fake({ threads: { c1: chat }, members: shared }).ctx),
      messageView(answer as never, fake({ threads: {} }, { thread: "c1:notes", sendTo }).ctx),
      <Composer
        attach={() => Promise.resolve({ id: "f" })}
        send={() => Promise.resolve()}
        agents={[{ id: "maya", name: "Maya" }]}
        initial="@maya hi"
        mentionNote={(typed) => <MentionHint who={ME} notes="c1:notes" name="Ana" typed={typed} />}
      />,
    ].map(html).join("\n");
    const read = all.replace(/ (class|href|id|for|aria-labelledby|aria-controls)="[^"]*"/g, "");
    assertEquals(englishLeft(read, "chat"), []);
    for (const key of ["notesTitle", "notesNever", "notesAbout", "sharedWith", "notesEmptyTitle"]) {
      assertStringIncludes(all, `«chat.${key}»`);
    }
    for (const key of ["sendToName", "answersWhereSeen", "askInNotes", "notesWithCount"]) {
      assertStringIncludes(all, `«chat.${key}»`);
    }
  } finally {
    restore();
    clean();
  }
});

test("the notes' box takes the keys when someone opens them, not when they show as kept open", () => {
  try {
    const box = composerIn(
      notesView(
        { _id: "c1" },
        fake({ threads: { c1: chat, "c1:notes": notes }, members: shared }).ctx,
      ),
    );
    assertEquals(box.autoFocus, takeOpened);
    setNotesOpen(ME, true);
    assertEquals([takeOpened(), takeOpened()], [true, false]);
    // The chat's own box, as ever.
    const chatBox = composerIn(
      conversationView({ _id: "c1" }, fake({ threads: { c1: chat }, members: shared }).ctx),
    );
    assertEquals(chatBox.autoFocus, undefined);
  } finally {
    clean();
  }
});
