import { assertEquals, assertRejects } from "@std/assert";
import { evaluateCoreJq } from "../jq.ts";

Deno.test("jq executes bounded single outputs and releases capacity after invalid input/output", async () => {
  assertEquals(await evaluateCoreJq({ n: 2 }, ".n + 1"), 3);
  await assertRejects(() => evaluateCoreJq({}, "empty"), Error, "exactly one");
  await assertRejects(() => evaluateCoreJq({}, "1,2"), Error, "exactly one");
  await assertRejects(
    () => evaluateCoreJq("a".repeat(1024 * 1024), "."),
    Error,
    "1 MiB",
  );
  await assertRejects(() => evaluateCoreJq({}, "bad syntax ["));
  assertEquals(await evaluateCoreJq({ n: 2 }, ".n"), 2);
});
Deno.test("jq immediately refuses capacity and cancellation releases its worker", async () => {
  const controller = new AbortController();
  const pending = evaluateCoreJq({}, "while(true; .)", controller.signal);
  const rejected = assertRejects(() => pending, DOMException, "cancelled");
  await assertRejects(() => evaluateCoreJq({}, "."), Error, "capacity");
  controller.abort(new DOMException("cancelled", "AbortError"));
  await rejected;
  assertEquals(await evaluateCoreJq(1, "."), 1);
});
Deno.test("jq preempts a nonterminating filter at the execution deadline", async () => {
  await assertRejects(
    () => evaluateCoreJq({}, "def forever: forever; forever"),
    Error,
    "5 second",
  );
  assertEquals(await evaluateCoreJq(1, "."), 1);
});
