/**
 * The command palette in the shell, its logic: the front ends that fill it
 * in their order, the page an address opens, and the key that opens it,
 * ⌘K on Apple's computers and Ctrl+K elsewhere.
 */
import { assertEquals } from "@std/assert";
import { apple, opens, pageOf, shortcutOf, sourcesOf } from "../shared/palette.ts";
import { test } from "../../../../testing/mod.ts";

test("the front ends that fill it, in order, without those taken away", () => {
  assertEquals(
    sourcesOf({
      memory: { view: "memory.palette", order: 40 },
      chats: { view: "chat.palette", order: 20 },
      gone: null,
      broken: { order: 1 },
      spaces: { view: "spaces.palette", order: 10 },
    }),
    [
      { view: "spaces.palette", order: 10 },
      { view: "chat.palette", order: 20 },
      { view: "memory.palette", order: 40 },
    ],
  );
  assertEquals(sourcesOf(undefined), []);
});

test("the page an address opens", () => {
  assertEquals(pageOf("/"), { kind: "home" });
  assertEquals(pageOf("/thread/t1"), { kind: "thread", id: "t1" });
  assertEquals(pageOf("/space/personal%3Aana"), { kind: "space", id: "personal:ana" });
  assertEquals(pageOf("/memories"), { kind: "memories" });
});

test("the key that opens it: ⌘K on a Mac, Ctrl+K elsewhere, nothing else", () => {
  const key = (
    k: string,
    mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
  ) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  assertEquals(opens(key("k", { metaKey: true }), true), true);
  assertEquals(opens(key("K", { metaKey: true }), true), true);
  assertEquals(opens(key("k", { ctrlKey: true }), true), false);
  assertEquals(opens(key("k", { ctrlKey: true }), false), true);
  assertEquals(opens(key("k", { metaKey: true }), false), false);
  assertEquals(opens(key("k", { metaKey: true, shiftKey: true }), true), false);
  assertEquals(opens(key("j", { metaKey: true }), true), false);
  assertEquals(opens(key("k"), true), false);
  assertEquals([apple("MacIntel"), apple("iPhone"), apple("Win32"), apple("Linux x86_64")], [
    true,
    true,
    false,
    false,
  ]);
  assertEquals([shortcutOf(true), shortcutOf(false)], ["⌘K", "Ctrl K"]);
});
