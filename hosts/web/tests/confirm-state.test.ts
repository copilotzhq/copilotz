/**
 * `useConfirm`'s questions, as state (toolkit/confirm-state.ts): asked in order, shown one at a
 * time by the first host, each answered once. When the host or the owner goes, a question still
 * waiting is answered no and never shows again; one whose operation runs is answered by how it
 * ends.
 */
import assert from "node:assert/strict";
import { test } from "../../../testing/mod.ts";
import { questions } from "../toolkit/confirm-state.ts";

/** How a promise stands, after what's pending has run. */
async function standing<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((done) => setTimeout(() => done("pending"), 0)),
  ]);
}

test("with no host ever drawn, asking is the developer's mistake", async () => {
  const asked = questions<string>();
  await assert.rejects(asked.ask("Delete Ana?"), /\{dialog\}/);
});

test("C5: questions show one at a time, in order, and each is answered once", async () => {
  const asked = questions<string>();
  const host = {};
  asked.host(host);
  const changes: number[] = [];
  asked.subscribe(() => changes.push(asked.queue().length));
  assert.equal(asked.shower(), host);
  const first = asked.ask("Delete Ana?");
  const second = asked.ask("Delete Bo?");
  assert.deepEqual(asked.queue().map((q) => q.options), ["Delete Ana?", "Delete Bo?"]);
  const [a, b] = asked.queue();
  asked.settle(a.id, true);
  asked.settle(a.id, false); // once only
  assert.equal(await first, true);
  assert.deepEqual(asked.queue().map((q) => q.options), ["Delete Bo?"]);
  asked.settle(b.id, false);
  assert.equal(await second, false);
  assert.deepEqual(asked.queue(), []);
  assert.deepEqual(changes, [1, 2, 1, 0]);
});

test("the first host shows the questions; a second shows none until the first goes", () => {
  const asked = questions<string>();
  const one = {};
  const two = {};
  const leaveOne = asked.host(one);
  asked.host(two);
  assert.equal(asked.shower(), one);
  leaveOne();
  assert.equal(asked.shower(), two);
});

test("C6: when the host goes, waiting questions say no; a running one says how it ended", async () => {
  const asked = questions<string>();
  const leave = asked.host({});
  const running = asked.ask("Delete Ana?");
  const waiting = asked.ask("Delete Bo?");
  const [a] = asked.queue();
  asked.running(a.id, true);
  leave();
  assert.deepEqual(asked.queue(), []);
  assert.equal(await waiting, false);
  assert.equal(await standing(running), "pending");
  asked.settle(a.id, true);
  assert.equal(await running, true);
  // With no host now, though one was drawn, asking is answered no.
  assert.equal(await asked.ask("Delete Cy?"), false);
});

test("C6: when the owner goes, its questions say no and a later one is no at once", async () => {
  const asked = questions<string>();
  asked.host({});
  const waiting = asked.ask("Delete Ana?");
  asked.close();
  assert.equal(await waiting, false);
  assert.deepEqual(asked.queue(), []);
  assert.equal(await asked.ask("Delete Bo?"), false);
  asked.open(); // shown again (React's Activity), it asks again
  const again = asked.ask("Delete Cy?");
  assert.equal(asked.queue().length, 1);
  asked.settle(asked.queue()[0].id, true);
  assert.equal(await again, true);
});

test("C8: dropped from view, a waiting question says no; a running one waits for its end", async () => {
  const asked = questions<string>();
  asked.host({});
  const idle = asked.ask("Archive?");
  asked.drop(asked.queue()[0].id);
  assert.equal(await idle, false);
  const busy = asked.ask("Delete?");
  const [q] = asked.queue();
  asked.running(q.id, true);
  asked.drop(q.id);
  assert.deepEqual(asked.queue(), []);
  assert.equal(await standing(busy), "pending");
  asked.running(q.id, false);
  asked.settle(q.id, false);
  assert.equal(await busy, false);
});

test("a question keeps what had focus as it was asked", () => {
  const asked = questions<string>();
  asked.host({});
  const opener = { focus() {}, isConnected: true };
  asked.ask("Delete?", opener);
  assert.equal(asked.queue()[0].opener, opener);
});
