/**
 * A call that breaks: the network, a stream gone silent, a provider busy. It
 * is tried again, longer waits apart, for the provider's `retry`; a `retry`
 * chunk says what came before is void. A provider refusing the request isn't
 * tried again, and `retry: 0` never is.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { LlmAdapter, LlmChunk } from "../mod.ts";
import { complete, generate } from "../shared/generate.ts";
import { test } from "../../../testing/mod.ts";

/** An adapter whose calls go as `script` says, by attempt (1, 2…). */
const scripted = (script: (attempt: number) => AsyncGenerator<LlmChunk>) => {
  let attempt = 0;
  const adapter: LlmAdapter = { generate: () => script(++attempt) };
  return { adapter, attempts: () => attempt };
};

const reach = (adapter: LlmAdapter, provider: Record<string, unknown> = {}) => ({
  resources: { provider: { p: { adapter: "p", catalog: false, ...provider } } },
  adapters: { llm: { p: adapter } },
  signal: new AbortController().signal,
});

const ask = { model: "p/m", messages: [{ role: "user" as const, text: "hi" }] };

test("a connection that breaks mid-answer is tried again; what came before is void", async () => {
  const { adapter, attempts } = scripted(async function* (n) {
    yield { type: "text", text: n === 1 ? "half an ans" : "a whole answer" };
    if (n === 1) throw new TypeError("error sending request: connection reset");
  });
  const chunks: LlmChunk[] = [];
  for await (const chunk of generate(reach(adapter), ask)) chunks.push(chunk);
  const retry = chunks.find((c) => c.type === "retry") as Extract<LlmChunk, { type: "retry" }>;
  assertEquals([retry.attempt, retry.reason], [1, "error sending request: connection reset"]);
  assert(retry.wait >= 800 && retry.wait <= 1200, `waits about a second: ${retry.wait}`);
  assertEquals(
    (await complete(
      reach(
        scripted(async function* (n) {
          yield { type: "text", text: n === 1 ? "half" : "whole" };
          if (n === 1) throw new TypeError("network");
        }).adapter,
      ),
      ask,
    )).text,
    "whole",
  );
  assertEquals(attempts(), 2);
});

test("a stream that goes silent counts as broken, and is tried again", async () => {
  const { adapter } = scripted(async function* (n) {
    yield { type: "text", text: "starting" };
    // The first attempt never says anything more, whatever the signal.
    if (n === 1) await new Promise(() => {});
    yield { type: "text", text: ", and done" };
  });
  const chunks: LlmChunk[] = [];
  for await (const chunk of generate(reach(adapter, { silence: 50 }), ask)) chunks.push(chunk);
  const retry = chunks.find((c) => c.type === "retry") as Extract<LlmChunk, { type: "retry" }>;
  assert(retry.reason.startsWith("No answer from the model"), retry.reason);
  assertEquals(
    chunks.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(""),
    "startingstarting, and done",
  );
});

test("a refusal isn't tried again; with retry: 0, nothing is", async () => {
  const refusal = scripted(async function* () {
    throw Object.assign(new Error("p 401: no key"), { status: 401 });
  });
  await assertRejects(() => complete(reach(refusal.adapter), ask), Error, "401");
  assertEquals(refusal.attempts(), 1);
  const down = scripted(async function* () {
    throw new TypeError("network down");
  });
  await assertRejects(() => complete(reach(down.adapter, { retry: 0 }), ask), Error, "network");
  assertEquals(down.attempts(), 1);
});
