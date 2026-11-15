/**
 * The pages the host shows (screens.ts): each drawn as soon as it's asked
 * for, on its way until it's ready, the one before staying until then and
 * closing after; a page asked for while another is on its way takes over;
 * the first page is never on its way; a page that fails arrives all the same.
 */
import { assertEquals } from "@std/assert";
import { screens } from "../screens.ts";
import { test } from "../../../testing/mod.ts";

type Page = {
  name: string;
  ready: Promise<void>;
  closed: boolean;
  close(): void;
  arrive(): void;
  fail(): void;
};

/** A page that's ready (or fails) when the test says. */
function page(name: string): Page {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const made: Page = {
    name,
    ready: promise,
    closed: false,
    close: () => void (made.closed = true),
    arrive: () => resolve(),
    fail: () => reject(new Error("refused")),
  };
  return made;
}

/** What was drawn, in order: a page's name, and whether it was on its way. */
function drawing() {
  const drawn: string[] = [];
  const show = screens<Page>((p, going) => drawn.push(going ? `${p.name} (on its way)` : p.name));
  return { drawn, show };
}

const settled = () => new Promise((done) => setTimeout(done, 0));

test("screens: the first page isn't on its way; the next is, the one before staying until it's ready", async () => {
  const { drawn, show } = drawing();
  const home = page("home");
  show(home);
  assertEquals(drawn, ["home"]);
  home.arrive();
  await settled();
  const chat = page("chat");
  show(chat);
  assertEquals(drawn.at(-1), "chat (on its way)");
  await settled();
  assertEquals(home.closed, false);
  chat.arrive();
  await settled();
  assertEquals(drawn.at(-1), "chat");
  assertEquals(home.closed, true);
  assertEquals(chat.closed, false);
});

test("screens: a page asked for while another is on its way takes over; only its readiness ends the wait", async () => {
  const { drawn, show } = drawing();
  const home = page("home");
  show(home);
  home.arrive();
  await settled();
  const first = page("first");
  const second = page("second");
  show(first);
  show(second);
  assertEquals(drawn.slice(-2), ["first (on its way)", "second (on its way)"]);
  // The first one ready: the page before it closes, but the second is still on its way.
  first.arrive();
  await settled();
  assertEquals(home.closed, true);
  assertEquals(drawn.at(-1), "second (on its way)");
  second.arrive();
  await settled();
  assertEquals(drawn.at(-1), "second");
  assertEquals(first.closed, true);
});

test("screens: a page that fails arrives all the same (its parts say why)", async () => {
  const { drawn, show } = drawing();
  const home = page("home");
  show(home);
  home.arrive();
  await settled();
  const broken = page("broken");
  show(broken);
  broken.fail();
  await settled();
  assertEquals(drawn.at(-1), "broken");
  assertEquals(home.closed, true);
});
