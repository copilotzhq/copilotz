/**
 * Memory's web front end says only the app's words: with every word replaced nothing English
 * shows, with none replaced the English reads as before, and a second language fills blanks and
 * picks plurals.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setWords } from "../../../hosts/web/mod.ts";
import { englishLeft, pseudoWords } from "../../../hosts/web/tests/pseudo.ts";
import type { ViewContext } from "../../../runtime/mod.ts";
import type { Memory } from "../memory/collections/memory.ts";
import { MemoryCard } from "../memory/views/web/card.tsx";
import { MemoryList } from "../memory/views/web/list.tsx";
import { moveStep } from "../memory/views/web/move.ts";
import { memoryPaletteView } from "../memory/views/web/palette.tsx";
import { memoryPickView } from "../memory/views/web/pick.tsx";
import { memoriesView } from "../memory/views/web/memories.tsx";
import { test } from "../../../testing/mod.ts";

const call = () => Promise.resolve({} as never);

const memory = (more: Partial<Memory> & { _id: string; text: string; about: string }): Memory =>
  ({ by: "maya", at: "2026-01-01T10:00:00.000Z", ...more }) as Memory;

const memories: Memory[] = [
  memory({ _id: "1", text: "Ana prefers short answers", about: "person:ana", core: true }),
  memory({
    _id: "2",
    text: "Ana lives in Lisbon",
    about: "person:ana",
    by: "memory",
    updated: "2026-02-01T10:00:00.000Z",
    was: "Ana lives in Porto",
    source: { thread: "t1" },
    in: "s1",
  }),
  memory({ _id: "3", text: "Ben likes tea", about: "person:ben" }),
  memory({ _id: "4", text: "Maya writes launch copy", about: "agent:maya" }),
  memory({ _id: "5", text: "Be kind", about: "everyone" }),
  memory({ _id: "6", text: "The trip was planned here", about: "thread:t1" }),
];

const list = (items: Memory[]) => (
  <MemoryList
    memories={items}
    spaces={{ s1: "Acme" }}
    agents={{ maya: { name: "Maya", icon: "🦉" } }}
    names={{ ben: "Ben" }}
    me="ana"
    call={call}
  />
);

/** A view's context, answering reads from what it's given. */
const context = (
  reads: { memory?: Memory[]; open?: Memory | null },
  hints: Record<string, unknown> = {},
) =>
  ({
    hints,
    call,
    resources: {},
    viewer: { name: "ana" },
    db: {
      collection: (name: string) => ({
        findOne: () => ({ value: reads.open ?? null }),
        find: () => ({ value: [] }),
        query: (query: string) => ({
          value: name === "memory" ? reads.memory ?? [] : query === "agents" ? {} : {},
        }),
      }),
    },
  }) as unknown as ViewContext<ReactNode>;

function everything(): string[] {
  return [
    renderToStaticMarkup(list(memories)),
    renderToStaticMarkup(list([])),
    renderToStaticMarkup(<MemoryCard memory={memories[1]} by="Maya" space="Acme" call={call} />),
    renderToStaticMarkup(<MemoryCard memory={memories[0]} call={call} />),
    JSON.stringify(
      memoryPaletteView(null, context({ memory: memories }, { in: "s1" })),
    ),
    JSON.stringify(
      memoryPaletteView(
        null,
        context({ open: memories[0] }, { page: { kind: "memory", id: "1" } }),
      ),
    ),
    JSON.stringify(moveStep(memories[1], call)),
    JSON.stringify(memoryPickView(null, context({ memory: memories }, { in: "s1" }))),
  ];
}

test("with every word replaced, memory shows no English of its own", () => {
  const restore = setWords(pseudoWords("memory"));
  try {
    const all = everything();
    for (const markup of all) assertEquals(englishLeft(markup, "memory"), []);
    const page = all.join("\n");
    for (const key of ["emptyTitle", "searchMemories", "aboutYou", "moveToSpace", "moveThis"]) {
      assertStringIncludes(page + renderToStaticMarkup(list([])), `«memory.${key}»`);
    }
    assertStringIncludes(all[0], "«memory.aboutPerson»");
    assertStringIncludes(all[0], "«memory.core»");
    assertStringIncludes(all[2], "«memory.notedFromChat»");
  } finally {
    restore();
  }
});

test("with none replaced, the English reads as before", () => {
  const markup = renderToStaticMarkup(list(memories));
  assertStringIncludes(markup, "About you");
  assertStringIncludes(markup, "About Maya");
  assertStringIncludes(markup, "About particular chats");
  assertStringIncludes(markup, "About everyone");
  assertStringIncludes(markup, 'placeholder="Search memories"');
  const empty = renderToStaticMarkup(list([]));
  assertStringIncludes(empty, "Nothing remembered yet");
  assertStringIncludes(empty, "Start a chat");
  const card = renderToStaticMarkup(
    <MemoryCard memory={memories[1]} space="Acme" call={call} />,
  );
  assertStringIncludes(card, "Noted from the chat");
  assertStringIncludes(card, "updated");
  assertEquals(moveStep(memories[1], call).title, "Move “Ana lives in Lisbon” to…");
});

test("in another language, blanks are filled where that language puts them", () => {
  const restore = setWords({
    "memory.aboutPerson": "Sobre {name}",
    "memory.aboutYou": "Sobre você",
    "memory.by": "Por {name}",
    "memory.moveTitle": "Mover “{memory}” para…",
  });
  try {
    const markup = renderToStaticMarkup(list(memories));
    assertStringIncludes(markup, "Sobre você");
    assertStringIncludes(markup, "Sobre Ben");
    assertStringIncludes(
      renderToStaticMarkup(<MemoryCard memory={memories[0]} by="Maya" call={call} />),
      "Por Maya",
    );
    assertEquals(moveStep(memories[2], call).title, "Mover “Ben likes tea” para…");
  } finally {
    restore();
  }
});

test("the memories page says its title and intro through the words", () => {
  const restore = setWords(pseudoWords("memory"));
  try {
    const markup = renderToStaticMarkup(
      <>{memoriesView({}, context({ memory: memories }, { mode: "full" }))}</>,
    );
    assertEquals(englishLeft(markup, "memory"), []);
    assertStringIncludes(markup, "«memory.memories»");
  } finally {
    restore();
  }
});
