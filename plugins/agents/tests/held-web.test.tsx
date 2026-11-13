/**
 * What code writes into conversations is stored as what happened, never as a
 * sentence, and said in the reader's words wherever it shows: a line where a
 * reply went that not everyone there could read (a message's `held`, for
 * someone or for no one; an answer handed back, that it went to its asker
 * alone, or stayed), and the threads made beside a chat, called what they are
 * around its own title (staff notes, `about`; what was held from it,
 * `held.from`). English by default, as it always read; the app's words when
 * it gives them; agents told it in English; WhatsApp and voice say nothing
 * for one, and don't break on it.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setWords } from "../../../hosts/web/mod.ts";
import { englishLeft, pseudoWords } from "../../../testing/words.ts";
import { test } from "../../../testing/mod.ts";
import type { Message, Thread } from "../chat/mod.ts";
import { messageView } from "../chat/views/web/message.tsx";
import { messageView as llmMessageView } from "../chat/views/message.ts";
import { type Listed, matches, threadTitle, titleOf } from "../chat/views/web/listed.ts";
import { recentView } from "../chat/views/web/recent.tsx";
import { chatPaletteView } from "../chat/views/web/palette.tsx";
import { messageView as whatsAppView } from "../../interfaces/whatsapp/views/message.ts";
import { messageView as voiceView } from "../../interfaces/voice/views/message.ts";

const at = new Date().toISOString();

/** Placeholders as `chat.unmark` and a hand-back leave them: who wrote it, for whom, nothing said. */
const line = (more: Partial<Message> = {}): Message => ({
  _id: "h1:held",
  thread: "t1",
  in: "launch",
  from: "lead",
  to: [],
  held: { for: "ana" },
  at,
  ...more,
});
const forAna = line();
const forNobody = line({ _id: "u1:held", held: {} });
const handed = { kind: "delegated", name: "Research" };
const wentToAna = line({ _id: "r1:back", from: "scout", to: ["lead"], via: handed });
const stayed = line({ _id: "r2:back", from: "scout", to: ["lead"], via: handed, held: {} });

/** A View context whose people are named: Ana is "Ana Lima". */
// deno-lint-ignore no-explicit-any
const ctx = (hints: Record<string, unknown> = {}, rows: any = undefined): any => ({
  name: "test",
  hints,
  resources: { names: { people: { collection: "profile" } } },
  viewer: { name: "bob", label: "Bob" },
  call: () => Promise.resolve({}),
  show: () => null,
  db: {
    collection: (name: string) => ({
      query: (query: string) => ({
        status: "ready",
        value: query === "names" ? { ana: "Ana Lima" } : rows,
      }),
      find: () => ({ status: "ready", value: name === "space" ? [] : rows }),
      findOne: () => ({ status: "ready", value: rows?.[0] ?? null }),
    }),
  },
});

const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const shown = (m: Message) => html(messageView(m, ctx({ thread: "t1" })));

test("a line where a reply went says where in English, its person by name, and nothing it said", () => {
  assertStringIncludes(
    shown(forAna),
    "A reply only Ana Lima could see was moved to their Personal space.",
  );
  assertStringIncludes(shown(forNobody), "A reply only some here could see was held back.");
  assertStringIncludes(shown(wentToAna), "The answer went to Ana Lima only.");
  assertStringIncludes(shown(stayed), "The answer stayed where it was written.");
  // No reply to copy, nothing to send on: it says nothing of its own.
  assert(!shown(forAna).includes("Copy reply"), shown(forAna));
});

test("the app's words say it in its language, the name filled in as it's read", () => {
  const restore = setWords({
    "chat.heldMoved": "Uma resposta que só {name} podia ver foi para o espaço pessoal dela.",
    "chat.heldBack": "Uma resposta que nem todos aqui podiam ver ficou guardada.",
    "chat.answerWentTo": "A resposta foi só para {name}.",
    "chat.answerStayed": "A resposta ficou onde foi escrita.",
  });
  try {
    assertStringIncludes(
      shown(forAna),
      "Uma resposta que só Ana Lima podia ver foi para o espaço pessoal dela.",
    );
    assertStringIncludes(
      shown(forNobody),
      "Uma resposta que nem todos aqui podiam ver ficou guardada.",
    );
    assertStringIncludes(shown(wentToAna), "A resposta foi só para Ana Lima.");
    assertStringIncludes(shown(stayed), "A resposta ficou onde foi escrita.");
  } finally {
    restore();
  }
  const pseudo = setWords(pseudoWords("chat"));
  try {
    const all = [forAna, forNobody, wentToAna, stayed].map(shown).join("\n")
      .replace(/ (class|href|id)="[^"]*"/g, "");
    assertEquals(englishLeft(all, "chat"), []);
  } finally {
    pseudo();
  }
});

test("agents are told where it went, in English; WhatsApp and voice have nothing to say for it", () => {
  const told = (m: Message, viewer: string) =>
    llmMessageView(m, { ...ctx(), viewer: { kind: "agent", name: viewer } })
      .map((said) => "text" in said ? said.text : "").join("\n");
  // Its own line, as the agent's turn; another's, as input.
  assertEquals(
    told(forAna, "lead"),
    "A reply only Ana Lima could see was moved to their Personal space.",
  );
  assertStringIncludes(told(forNobody, "other"), "lead: A reply only some here could see");
  assertStringIncludes(told(wentToAna, "lead"), "The answer went to Ana Lima only.");
  assertStringIncludes(told(stayed, "lead"), "The answer stayed where it was written.");
  assertEquals(whatsAppView(forAna, ctx()), []);
  assertEquals(voiceView(forAna, ctx()), "");
});

/** Threads as lists have them: a chat, its staff notes, what was held from it. */
const listed = (more: Partial<Listed>): Listed => ({
  _id: "x",
  in: "s1",
  agents: [],
  messages: 2,
  at,
  last: "Sounds good",
  ...more,
} as Listed);
const plan = listed({ _id: "t1", title: "Plan" });
const notes = listed({ _id: "t1:notes", about: "t1", title: "Plan" });
const held = listed({ _id: "t1:held:ana", held: { from: "t1" }, title: "Plan" });
const untitled = listed({ _id: "t2:notes", about: "t2", first: "hi" });

test("threads code made are called what they are around their chat's own title", () => {
  assertEquals(
    [plan, notes, held, untitled].map(titleOf),
    ["Plan", "Staff notes: Plan", "Held from Plan", "Staff notes: a conversation"],
  );
  assertEquals(threadTitle({ title: "Plan" } as Thread), "Plan");
  assertEquals(threadTitle({} as Thread), undefined);
  // Found by what they're called, too.
  assert(matches(notes, "staff notes") && matches(held, "held plan"));
  // In the sidebar and the palette, as everywhere chats are listed.
  const sidebar = html(recentView({ _id: "s1" }, ctx({}, [plan, notes, held])));
  for (const title of ["Plan", "Staff notes: Plan", "Held from Plan"]) {
    assertStringIncludes(sidebar, `>${title}<`);
  }
  const palette = JSON.stringify(chatPaletteView(undefined, ctx({}, [plan, notes, held])));
  assertStringIncludes(palette, '"label":"Staff notes: Plan"');
  assertStringIncludes(palette, '"label":"Held from Plan"');
});

test("the app's words call them in its language", () => {
  const restore = setWords({
    "chat.notesOf": "Notas da equipe: {title}",
    "chat.heldFrom": "Guardado de {title}",
    "chat.aConversation": "uma conversa",
  });
  try {
    assertEquals([notes, held, untitled].map(titleOf), [
      "Notas da equipe: Plan",
      "Guardado de Plan",
      "Notas da equipe: uma conversa",
    ]);
    assertStringIncludes(
      html(recentView({ _id: "s1" }, ctx({}, [notes]))),
      ">Notas da equipe: Plan<",
    );
  } finally {
    restore();
  }
});
