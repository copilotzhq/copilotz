/**
 * Enter in chat's composer. On a computer (a mouse or a trackpad) it sends, and Shift+Enter starts
 * a new line. On a touch screen it starts a new line, as the keyboard's return key says, and the
 * Send button sends; so does Enter with ⌘ or Ctrl, from a keyboard attached to it.
 */
import { assert } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { sends } from "../chat/views/web/composer.tsx";

const press = (
  key: string,
  held: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...held,
});

test("on a computer, Enter sends and Shift+Enter starts a new line", () => {
  assert(sends(press("Enter"), true));
  assert(sends(press("Enter", { metaKey: true }), true));
  assert(!sends(press("Enter", { shiftKey: true }), true));
  assert(!sends(press("a"), true));
});

test("on a touch screen, Enter starts a new line, and Enter with ⌘ or Ctrl sends", () => {
  assert(!sends(press("Enter"), false));
  assert(!sends(press("Enter", { shiftKey: true }), false));
  assert(sends(press("Enter", { metaKey: true }), false));
  assert(sends(press("Enter", { ctrlKey: true }), false));
});
