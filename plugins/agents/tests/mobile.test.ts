/**
 * Phones: the page is an app's (it spans the screen and never zooms in on a
 * field, while people can still pinch), and nothing wide makes a pane
 * scroll sideways: a conversation scrolls up and down only, and what an
 * agent asks scrolls in its own room, its answers always in sight.
 */
import { assert, assertMatch, assertStringIncludes } from "@std/assert";
import { BASE } from "../../../hosts/web/style.ts";
import { STYLE as CHAT } from "../chat/views/web/style.ts";
import { test } from "../../../testing/mod.ts";

/** The body of the CSS rule for `selector` (its first, and outside any @media). */
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  assert(at >= 0, `no rule for ${selector}`);
  return css.slice(at, css.indexOf("}", at));
};

test("on touch screens, fields are 16px at least (phones zoom in on smaller ones), as a rule that wins", () => {
  const coarse = BASE.slice(BASE.indexOf("@media (pointer: coarse)"));
  assertMatch(coarse, /input, textarea, select \{ font-size: max\(16px, 1em\) !important; \}/);
});

test("the page never scrolls sideways or bounces as a whole; a tap doesn't zoom", () => {
  assertStringIncludes(BASE, "html, body { overflow-x: clip; overscroll-behavior: none; }");
  assertStringIncludes(BASE, "touch-action: manipulation");
});

test("a conversation scrolls up and down only; what's asked over it keeps to its room and scrolls", () => {
  assertStringIncludes(rule(CHAT, ".chat-transcript"), "overflow-x: hidden");
  const asks = rule(CHAT, ".chat-asks");
  assertStringIncludes(asks, "max-height: 60%");
  assertStringIncludes(asks, "overflow-y: auto");
  // The composer keeps clear of a phone's home bar.
  assertStringIncludes(rule(CHAT, ".chat-composer"), "env(safe-area-inset-bottom)");
});
