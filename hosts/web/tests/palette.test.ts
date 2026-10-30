/**
 * The command palette's logic: how well an item fits what's typed (and
 * where, to mark it), and what it lists from front ends' groups: merged by
 * heading, each item once (what can't be undone last), filtered and ranked,
 * cut to a group's limit, and groups ordered by `order`, or while searching
 * by their best match.
 */
import { assertEquals } from "@std/assert";
import { fold, hits, rank } from "../palette/rank.ts";
import { groupsOf, listOf } from "../palette/list.ts";
import type { PaletteGroup } from "../palette/state.ts";
import { test } from "../../../testing/mod.ts";

test("folding: no case, no accents, and where each character came from", () => {
  assertEquals(fold("Café É"), { text: "cafe e", at: [0, 1, 2, 3, 4, 5] });
});

test("what fits best: the start of the label, a word in it, inside it, its letters, other words", () => {
  const label = "Move this chat to another space…";
  assertEquals(rank("", label), 1);
  assertEquals(rank("zebra", label), 0);
  const start = rank("move", label);
  const word = rank("chat", label);
  const inside = rank("hat", label);
  const letters = rank("mvc", label);
  const keyword = rank("relocate", label, ["relocate"]);
  assertEquals(start > word && word > inside && inside > keyword && keyword > letters, true);
  // Every word must fit; any order, any case or accent.
  assertEquals(rank("SPACE move", label) > 0, true);
  assertEquals(rank("move dog", label), 0);
  assertEquals(rank("cafe", "Café plans") > 0, true);
  // The same fit, a shorter label first.
  assertEquals(rank("launch", "Launch") > rank("launch", "Launch party plans"), true);
  // Letters spread too thin aren't what was meant.
  assertEquals(rank("ae", "a long way to the end"), 0);
});

test("where what's typed is in a label, to mark it", () => {
  assertEquals(hits("", "Launch"), []);
  assertEquals(hits("lau", "Launch"), [[0, 3]]);
  assertEquals(hits("chat new", "New chat"), [[0, 3], [4, 8]]);
  assertEquals(hits("cafe", "Le Café"), [[3, 7]]);
  assertEquals(hits("nct", "New chat"), [[0, 1], [4, 5], [7, 8]]);
});

const group = (
  title: string,
  labels: string[],
  more: Partial<PaletteGroup> = {},
): PaletteGroup => ({
  title,
  items: labels.map((label) => ({ key: `${title}:${label}`, label })),
  ...more,
});

test("what it lists: groups by heading, in their order, each item once, as many as they show", () => {
  const listed = listOf([
    group("Chats", ["Plan", "Notes", "Ideas"], { order: 30, limit: 2 }),
    group("This space", ["Invite someone…"], { order: 10 }),
    { title: "This space", items: [{ key: "This space:Invite someone…", label: "Again" }] },
    group("This space", ["Move a note…"]),
    group("Untitled", []),
  ], "");
  assertEquals(listed.groups.map((g) => [g.title, g.items.map((i) => i.label)]), [
    ["This space", ["Invite someone…", "Move a note…"]],
    ["Chats", ["Plan", "Notes"]],
  ]);
  assertEquals(listed.items.map((i) => i.label), [
    "Invite someone…",
    "Move a note…",
    "Plan",
    "Notes",
  ]);
});

test("in a headed group, what can't be undone goes last, whichever front end gave it", () => {
  const listed = listOf([
    {
      title: "This space",
      order: 10,
      items: [
        { key: "invite", label: "Invite someone…" },
        { key: "leave", label: "Leave Launch…", tone: "destructive" },
      ],
    },
    group("This space", ["Add an agent…"]),
  ], "");
  assertEquals(listed.items.map((i) => i.label), [
    "Invite someone…",
    "Add an agent…",
    "Leave Launch…",
  ]);
  // A question's choices stay as given: the first is what Enter does.
  const asked = listOf([{
    title: "",
    items: [
      { key: "leave", label: "Leave Launch", tone: "destructive" },
      { key: "stay", label: "Stay" },
    ],
  }], "");
  assertEquals(asked.items.map((i) => i.label), ["Leave Launch", "Stay"]);
});

test("while searching: what fits, best first, and the group with the best match on top", () => {
  const listed = listOf([
    group("This space", ["Archive Launch…", "Rename Launch…"], { order: 10 }),
    group("Spaces", ["Personal", "Launch"], { order: 20 }),
    group("Chats", ["Party at launch", "Lunch"], { order: 30 }),
  ], "launch");
  assertEquals(listed.groups.map((g) => [g.title, g.items.map((i) => i.label)]), [
    ["Spaces", ["Launch"]],
    // The same kind of match, the shorter first.
    ["This space", ["Rename Launch…", "Archive Launch…"]],
    ["Chats", ["Party at launch"]],
  ]);
  // A step whose items are what's typed (a new name) isn't filtered.
  const named = listOf([group("", ["Create “Q4”"])], "Q4 plans", false);
  assertEquals(named.items.map((i) => i.label), ["Create “Q4”"]);
  // Descriptions and keywords find an item too.
  const found = listOf([{
    title: "Chats",
    items: [{ key: "a", label: "Plan", description: "Launch" }, {
      key: "b",
      label: "Other",
      keywords: ["budget"],
    }],
  }], "budget");
  assertEquals(found.items.map((i) => i.key), ["b"]);
});

test("front ends' answers as groups: one, several, or none", () => {
  const one = group("A", ["x"]);
  assertEquals(groupsOf(one), [one]);
  assertEquals(groupsOf([one, null, { title: "no items" }]), [one]);
  assertEquals(groupsOf(null), []);
  assertEquals(groupsOf(undefined), []);
});
