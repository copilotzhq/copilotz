/**
 * A call that breaks: the network, a stream gone silent, a provider busy. It
 * is tried again, longer waits apart, for the provider's `retry`; a `retry`
 * chunk says what came before is void. A provider refusing the request isn't
 * tried again, and `retry: 0` never is.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { LlmAdapter, LlmChunk } from "../mod.ts";
import { complete, generate } from "../shared/generate.ts";
import { alive } from "../shared/provider.ts";
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

test("a model thinking longer than the silence isn't a dropped call", async () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const { adapter, attempts } = scripted(async function* () {
    // Four times the silence before it writes, saying it's at work all along.
    for (let i = 0; i < 10; i++) {
      yield { type: "thinking" };
      await sleep(20);
    }
    yield { type: "text", text: "thought it through" };
    yield { type: "usage", input: 3, output: 5 };
  });
  const chunks: LlmChunk[] = [];
  for await (const chunk of generate(reach(adapter, { silence: 50 }), ask)) chunks.push(chunk);
  assertEquals(chunks.filter((c) => c.type === "retry"), []);
  assertEquals(attempts(), 1);
  // The whole answer: its words, and its usage (thinking isn't usage).
  const answer = await complete(reach(adapter, { silence: 50 }), ask);
  assertEquals([answer.text, answer.usage?.output], ["thought it through", 5]);
});

test("a model that thinks, then goes silent, hands over: thinking isn't writing", async () => {
  const first: LlmAdapter = {
    async *generate() {
      yield { type: "thinking" };
      await new Promise(() => {});
    },
  };
  const second: LlmAdapter = {
    async *generate() {
      yield { type: "text", text: "the next one's answer" };
    },
  };
  const both = {
    resources: {
      provider: {
        a: { adapter: "a", catalog: false, silence: 50 },
        b: { adapter: "b", catalog: false },
      },
    },
    adapters: { llm: { a: first, b: second } },
    signal: new AbortController().signal,
  };
  const chunks: LlmChunk[] = [];
  for await (const chunk of generate(both, { ...ask, model: ["a/m", "b/m"] })) chunks.push(chunk);
  assertEquals(chunks.filter((c) => c.type === "retry"), []);
  assertEquals(chunks.at(-1), { type: "text", text: "the next one's answer" });
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

test("a stream says it's alive at most once in a while, however often its provider sends", async () => {
  const beat = alive(40);
  assertEquals([beat(), beat(), beat()], [true, false, false]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals([beat(), beat()], [true, false]);
});
