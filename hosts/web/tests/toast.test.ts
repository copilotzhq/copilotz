/**
 * Toasts and tags as state (toolkit/toast-state.ts, toolkit/tags.ts): a
 * toast shows, goes after its time, waits while paused, stays with no time;
 * one `<Toasts />` shows them, the one that chose its placement; a tags
 * field adds what's typed or pasted, split, trimmed, once each.
 */
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { withTags } from "../toolkit/tags.ts";
import {
  dismissToast,
  mountToasts,
  pauseToast,
  resumeToast,
  toast,
  toastState,
} from "../toolkit/toast-state.ts";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const shown = () => toastState().toasts.map((t) => `${t.tone}:${t.message}`);

test("a toast shows with its tone, goes after its time, or when dismissed", async () => {
  const gone = toast("Saved", { tone: "success", duration: 30 });
  toast("Plain", { duration: 30 });
  assertEquals(shown(), ["success:Saved", "neutral:Plain"]);
  gone();
  assertEquals(shown(), ["neutral:Plain"]);
  await wait(60);
  assertEquals(shown(), []);
});

test("a paused toast waits, then has the time it had left; 0 stays", async () => {
  toast("Wait for me", { tone: "info", duration: 40 });
  const id = toastState().toasts[0].id;
  pauseToast(id);
  await wait(70);
  assertEquals(shown(), ["info:Wait for me"]);
  resumeToast(id);
  await wait(70);
  assertEquals(shown(), []);
  toast("Until dismissed", { tone: "destructive", duration: 0 });
  await wait(20);
  assertEquals(shown(), ["destructive:Until dismissed"]);
  dismissToast(toastState().toasts[0].id);
  assertEquals(shown(), []);
});

test("one <Toasts /> shows them: the one that chose its placement, else the first", () => {
  const shell = mountToasts("shell", false);
  assertEquals(toastState().shownBy, "shell");
  const app = mountToasts("app", true);
  assertEquals(toastState().shownBy, "app");
  app();
  assertEquals(toastState().shownBy, "shell");
  shell();
  assertEquals(toastState().shownBy, undefined);
});

test("tags: split at commas and lines, trimmed, each once, after those there", () => {
  assertEquals(withTags(["CODE128"], "EAN13, UPC-A,EAN13"), ["CODE128", "EAN13", "UPC-A"]);
  assertEquals(withTags([], " a ,\nb\r\n, ,c"), ["a", "b", "c"]);
  assertEquals(withTags(["a"], "a"), ["a"]);
  assertEquals(withTags([], "   "), []);
});
