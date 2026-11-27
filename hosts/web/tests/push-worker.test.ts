/**
 * The service worker's side of push notifications: every push is shown (as
 * browsers require), with its title, words and tag, the app's name when it
 * has no title; a tap moves a window of the app already open to where it
 * points, or opens one; and it never points anywhere but the app.
 */
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { workerOf } from "../pwa.ts";

type Listener = (event: Record<string, unknown>) => void;

/** The worker's script, run against a stand-in for the browser's `self`. */
function run(clients: { url: string }[] = []) {
  const listeners: Record<string, Listener> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const told: unknown[] = [];
  const waits: Promise<unknown>[] = [];
  const windows = clients.map((c) => ({
    url: c.url,
    focus: () => Promise.resolve({ postMessage: (m: unknown) => told.push(m) }),
  }));
  const self = {
    location: { origin: "https://app.example.com" },
    addEventListener: (type: string, listener: Listener) => listeners[type] = listener,
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) =>
        Promise.resolve(void shown.push({ title, options })),
    },
    clients: {
      matchAll: () => Promise.resolve(windows),
      openWindow: (url: string) => Promise.resolve(void opened.push(url)),
      claim: () => Promise.resolve(),
    },
    skipWaiting: () => {},
  };
  const script = workerOf({
    version: "abc",
    code: "/app/",
    entry: "main.js",
    precache: [],
    title: "Harbor Desk",
  });
  new Function("self", "caches", "fetch", script)(self, {}, fetch);
  const fire = async (type: string, event: Record<string, unknown>) => {
    listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { fire, shown, opened, told };
}

const pushOf = (data: unknown) => ({
  data: { json: () => data, text: () => JSON.stringify(data) },
});

test("a push is shown: its title, words and tag, pointing in the app", async () => {
  const worker = run();
  await worker.fire(
    "push",
    pushOf({ title: "Ana", body: "Can you look?", url: "/chat/t1", tag: "t1" }),
  );
  assertEquals(worker.shown.length, 1);
  assertEquals(worker.shown[0].title, "Ana");
  assertEquals(worker.shown[0].options.body, "Can you look?");
  assertEquals(worker.shown[0].options.tag, "t1");
  assertEquals(worker.shown[0].options.data, { url: "https://app.example.com/chat/t1" });
});

test("a push without a title, or without words at all, is still shown, as the app's", async () => {
  const worker = run();
  await worker.fire("push", { data: null });
  await worker.fire("push", { data: { json: () => JSON.parse("{"), text: () => "plain words" } });
  assertEquals(worker.shown.map((s) => [s.title, s.options.body]), [
    ["Harbor Desk", ""],
    ["Harbor Desk", "plain words"],
  ]);
});

test("it never points outside the app", async () => {
  const worker = run();
  await worker.fire("push", pushOf({ title: "x", url: "https://evil.example.com/" }));
  await worker.fire("push", pushOf({ title: "x", url: "javascript:alert(1)" }));
  assertEquals(worker.shown.map((s) => (s.options.data as { url: string }).url), [
    "https://app.example.com/",
    "https://app.example.com/",
  ]);
});

test("a tap moves an open window of the app there, or opens one", async () => {
  const notification = (url: string) => ({
    notification: { close: () => {}, data: { url } },
  });
  const open = run([{ url: "https://app.example.com/" }]);
  await open.fire("notificationclick", notification("https://app.example.com/chat/t1"));
  assertEquals(open.told, [{ type: "copilotz:open", url: "https://app.example.com/chat/t1" }]);
  assertEquals(open.opened, []);
  const closed = run();
  await closed.fire("notificationclick", notification("https://app.example.com/chat/t1"));
  assertEquals(closed.opened, ["https://app.example.com/chat/t1"]);
});
