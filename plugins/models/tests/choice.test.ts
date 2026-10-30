/**
 * Choosing models: providers the catalog fills in, `"provider/model"` with
 * settings next to it, aliases, lists that fall back, one `effort` checked
 * against what each model takes and mapped to each protocol, and a model's
 * own state going back to it only.
 */
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmChunk, type LlmRequest } from "../mod.ts";
import { chooseModels, complete } from "../shared/generate.ts";
import { chat } from "../../agents/chat/mod.ts";
import { anthropic } from "../adapters/llm/anthropic.ts";
import { gemini } from "../adapters/llm/gemini.ts";
import { openaiCompletions } from "../adapters/llm/openai-compatible.ts";
import { openaiResponses } from "../adapters/llm/openai.ts";
import { lookup, resolve } from "../shared/choice.ts";
import { serve, test } from "../../../testing/mod.ts";

const resources = {
  provider: {
    openai: { apiKey: "k" },
    deepseek: { apiKey: "d" },
    // A name of our own: OpenAI's models, through another account.
    chatgpt: { adapter: "openai", catalog: "openai", headers: () => ({ authorization: "x" }) },
    local: { adapter: "openai-compatible", baseURL: "http://localhost:11434/v1" },
  },
  model: {
    cheap: { model: "openai/gpt-5.4-mini", effort: "low", options: { a: 1 } },
    fast: ["deepseek/deepseek-v4-flash", "cheap"],
  },
};

test("a provider the catalog knows needs only its key", () => {
  const [m] = resolve(resources, "deepseek/deepseek-v4-flash");
  assertEquals([m.adapter, m.endpoint.baseURL, m.endpoint.apiKey], [
    "openai-compatible",
    "https://api.deepseek.com",
    "d",
  ]);
  assertEquals(m.catalog, "deepseek/deepseek-v4-flash");
  assertEquals(m.info?.cost?.input !== undefined, true);
  // OpenAI's URL is the adapter's own.
  const [o] = resolve(resources, "openai/gpt-5.4-mini");
  assertEquals([o.adapter, o.endpoint.baseURL], ["openai", undefined]);
  // A provider of our own borrows a catalog provider's knowledge of its models.
  const [c] = resolve(resources, "chatgpt/gpt-6.1-sol");
  assertEquals([c.provider, c.catalog, c.info], [
    "chatgpt",
    "openai/gpt-6.1-sol",
    lookup("openai/gpt-6.1-sol"),
  ]);
  // One the catalog doesn't know names its protocol and URL, and has no catalog entry.
  const [l] = resolve(resources, "local/llama3");
  assertEquals([l.adapter, l.endpoint.baseURL, l.info], [
    "openai-compatible",
    "http://localhost:11434/v1",
    undefined,
  ]);
});

test("settings: where a model is used wins over an alias; a list entry over its list", () => {
  const settings = (ref: Parameters<typeof resolve>[1]) =>
    resolve(resources, ref).map((m) => [m.id, m.settings]);
  assertEquals(settings("cheap"), [["openai/gpt-5.4-mini", { effort: "low", options: { a: 1 } }]]);
  assertEquals(settings({ model: "cheap", effort: "high", options: { b: 2 } }), [
    ["openai/gpt-5.4-mini", { effort: "high", options: { a: 1, b: 2 } }],
  ]);
  assertEquals(
    settings({ model: ["openai/gpt-6.1-sol", { model: "fast", effort: "max" }], effort: "low" }),
    [
      ["openai/gpt-6.1-sol", { effort: "low" }],
      ["deepseek/deepseek-v4-flash", { effort: "max" }],
      ["openai/gpt-5.4-mini", { effort: "max", options: { a: 1 } }],
    ],
  );
});

test("what can't be called says why", () => {
  assertThrows(() => resolve(resources, "nobody/m"), Error, 'No provider "nobody"');
  assertThrows(() => resolve(resources, "nothing"), Error, 'No model "nothing"');
  assertThrows(
    () => resolve({ model: { a: "b", b: "a" } }, "a"),
    Error,
    'Model alias "a" names itself',
  );
  assertThrows(
    () => resolve({ provider: { mine: {} } }, "mine/m"),
    Error,
    'Provider "mine" needs an `adapter`',
  );
});

test("effort is checked against what each model takes", () => {
  const reach = { resources, adapters: models.adapters! };
  chooseModels(reach, { model: "openai/gpt-6.1-sol", effort: "low" });
  chooseModels(reach, { model: "openai/gpt-5.4-mini", effort: "none" });
  // Not in the catalog: the provider decides.
  chooseModels(reach, { model: "local/llama3", effort: "high" });
  assertThrows(
    () => chooseModels(reach, { model: "openai/gpt-6.1-sol", effort: "none" }),
    Error,
    '"openai/gpt-6.1-sol" takes effort low, medium, high, xhigh, max; not "none"',
  );
  assertThrows(
    () => chooseModels(reach, { model: "openai/gpt-4o", effort: "high" }),
    Error,
    "doesn't reason",
  );
  assertThrows(
    () => chooseModels(reach, { model: "openai/gpt-6.1-sol", effort: "hard" as "high" }),
    Error,
    "isn't one of",
  );
});

test("a mistake in an agent's model stops the runtime from starting", async () => {
  const app = (agent: Record<string, unknown>) =>
    definePlugin({
      name: "app",
      resources: { ...resources, agents: { lead: { instructions: "Lead.", ...agent } } },
    });
  const start = (agent: Record<string, unknown>) =>
    createRuntime({ store: memoryStore(), plugins: [models, chat, app(agent)] });
  const error = await assertRejects(() => start({ model: "openai/gpt-6.1-sol", effort: "none" }));
  assertStringIncludes((error as Error).message, 'chat: Agent "lead": "openai/gpt-6.1-sol" takes');
  // A model the catalog doesn't know is the provider's to judge; a protocol nobody speaks isn't.
  await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, app({ model: "openai/new" })],
  })
    .then((runtime) => runtime.close());
  await assertRejects(
    () =>
      createRuntime({
        store: memoryStore(),
        plugins: [models, chat, app({ model: "odd/m" }), {
          name: "odd",
          resources: { provider: { odd: { adapter: "smoke-signals" } } },
        }],
      }),
    Error,
    'No llm adapter "smoke-signals" for "odd/m"',
  );
  await assertRejects(() => start({}), Error, 'Agent "lead" has no model');
  // A later plugin changes only what it names: here, the effort.
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      app({ model: "fake/echo", effort: "high" }),
      definePlugin({ name: "tune", resources: { agents: { lead: { effort: null } } } }),
    ],
  });
  await runtime.close();
});

/** A protocol server stand-in: records each request body and answers with SSE events. */
async function server(events: (path: string) => unknown[], named = false) {
  const bodies: Record<string, unknown>[] = [];
  const http = await serve(async (request) => {
    bodies.push(JSON.parse(await request.text()));
    const path = new URL(request.url).pathname;
    if (path.includes("/fail/")) return new Response("down", { status: 503 });
    return new Response(
      events(path).map((e) =>
        (named ? `event: ${(e as { type: string }).type}\n` : "") + `data: ${JSON.stringify(e)}\n\n`
      ).join(""),
    );
  });
  return { url: http.url, bodies, close: () => http.close() };
}

async function call(adapter: LlmAdapter, request: Omit<LlmRequest, "messages">) {
  const chunks: LlmChunk[] = [];
  for await (
    const chunk of adapter.generate({ messages: [{ role: "user", text: "hi" }], ...request })
  ) chunks.push(chunk);
  return chunks;
}

test("effort and limits, as each protocol takes them", async () => {
  const mock = await server(() => []);
  try {
    const at = (path: string, model = "m") => ({ model, baseURL: `${mock.url}${path}` });
    await call(openaiResponses, { connection: at("/v1"), effort: "low", maxTokens: 900 });
    await call(openaiCompletions, { connection: at("/v1"), effort: "high", maxTokens: 900 });
    // Opus 5.5 takes effort levels: adaptive thinking; its limit, up to 32K, without maxTokens.
    await call(anthropic, {
      connection: at("/a/v1", "claude-opus-5-5"),
      effort: "medium",
      info: lookup("anthropic/claude-opus-5-5"),
    });
    // Haiku 4.5 takes a budget, which comes out of max_tokens.
    await call(anthropic, {
      connection: at("/a/v1", "claude-haiku-4-5"),
      effort: "low",
      maxTokens: 1000,
      info: lookup("anthropic/claude-haiku-4-5"),
    });
    await call(gemini, {
      connection: at("/g", "flash"),
      effort: "low",
      temperature: 0.2,
      info: { reasoning: { effort: ["minimal", "low", "medium", "high"] } },
    });
    await call(gemini, {
      connection: at("/g", "flash-2.5"),
      effort: "medium",
      info: { reasoning: { toggle: true, budget: { min: 0, max: 24_576 } } },
    });
    const [responses, completions, opus, haiku, gemini3, gemini25] = mock.bodies;
    assertEquals([responses.reasoning, responses.max_output_tokens], [{ effort: "low" }, 900]);
    assertEquals([completions.reasoning_effort, completions.max_tokens], ["high", 900]);
    assertEquals([opus.thinking, opus.output_config, opus.max_tokens], [
      { type: "adaptive" },
      { effort: "medium" },
      32_000,
    ]);
    assertEquals([haiku.thinking, haiku.max_tokens], [
      { type: "enabled", budget_tokens: 4096 },
      4097,
    ]);
    assertEquals(gemini3.generationConfig, {
      thinkingConfig: { thinkingLevel: "LOW" },
      temperature: 0.2,
    });
    assertEquals(gemini25.generationConfig, { thinkingConfig: { thinkingBudget: 8192 } });
  } finally {
    await mock.close();
  }
});

test("a model that fails before writing hands over to the next in its list", async () => {
  const mock = await server(() => [
    { choices: [{ delta: { content: "from the second" } }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ]);
  const reach = {
    resources: {
      provider: {
        // Not tried again: its failure, alone, is the answer at once.
        down: { adapter: "openai-compatible", baseURL: `${mock.url}/fail/v1`, retry: 0 },
        up: { adapter: "openai-compatible", baseURL: `${mock.url}/v1` },
      },
    },
    adapters: models.adapters!,
    signal: new AbortController().signal,
  };
  try {
    const answer = await complete(reach, {
      model: ["down/a", "up/b"],
      messages: [{ role: "user", text: "hi" }],
    });
    assertEquals(answer.text, "from the second");
    assertEquals(answer.usage, { model: "up/b", input: 3, output: 2 });
    // Alone, its failure is the answer.
    await assertRejects(
      () => complete(reach, { model: "down/a", messages: [{ role: "user", text: "hi" }] }),
      Error,
      "503",
    );
  } finally {
    await mock.close();
  }
});

test("Anthropic's signed thinking goes back to the provider's models, not another's", async () => {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Roll " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "it." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "t1", name: "roll", input: {} },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_stop" },
  ];
  const bodies: { model: string; messages: { content: { type: string }[] }[] }[] = [];
  const http = await serve(async (request) => {
    const body = await request.json();
    bodies.push(body);
    // This model takes no other model's thinking.
    if (body.model === "claude-strict" && JSON.stringify(body).includes('"sig"')) {
      return new Response("invalid signature in thinking block", { status: 400 });
    }
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    );
  });
  const url = `${http.url}/v1`;
  const reach = {
    resources: {
      provider: {
        claude: { adapter: "anthropic", baseURL: url, catalog: "anthropic" },
        // Another provider speaking the same protocol: its signatures aren't Anthropic's.
        relay: { adapter: "anthropic", baseURL: url, catalog: false },
      },
    },
    adapters: models.adapters!,
    signal: new AbortController().signal,
  };
  try {
    const first = await complete(reach, {
      model: { model: "claude/claude-opus-5-5", effort: "low" },
      messages: [{ role: "user", text: "roll" }],
    });
    const thought = { type: "thinking", thinking: "Roll it.", signature: "sig" };
    assertEquals(first.state, { by: "claude/claude-opus-5-5", data: [thought] });
    const conversation = [
      { role: "user" as const, text: "roll" },
      { role: "assistant" as const, toolCalls: first.toolCalls, state: first.state },
      { role: "tool" as const, toolCallId: "t1", text: "4" },
    ];
    const blocks = () => bodies.at(-1)!.messages[1].content.map((b) => b.type);
    await complete(reach, { model: "claude/claude-sonnet-5-5", messages: conversation });
    assertEquals(blocks(), ["thinking", "tool_use"], "another model of the same provider");
    await complete(reach, { model: "relay/claude-opus-5-5", messages: conversation });
    assertEquals(blocks(), ["tool_use"], "another provider");
    // Refused: asked again with only its own (none).
    const before = bodies.length;
    await complete(reach, { model: "claude/claude-strict", messages: conversation });
    assertEquals(bodies.length - before, 2);
    assertEquals(blocks(), ["tool_use"]);
  } finally {
    await http.close();
  }
});

test("Gemini's thought signatures go back on their parts", async () => {
  const mock = await server(() => [{
    candidates: [{
      content: {
        role: "model",
        parts: [{ functionCall: { id: "f1", name: "roll", args: {} }, thoughtSignature: "s1" }],
      },
    }],
  }]);
  try {
    const connection = { model: "g", baseURL: mock.url };
    const chunks = await call(gemini, { connection });
    const state = chunks.find((c) => c.type === "state");
    assertEquals(state, { type: "state", state: { data: { calls: { f1: "s1" } } } });
    await call(gemini, {
      connection,
      messages: [
        { role: "user", text: "roll" },
        {
          role: "assistant",
          toolCalls: [{ id: "f1", name: "roll", input: {} }],
          state: (state as { state: { data: unknown } }).state,
        },
        { role: "tool", toolCallId: "f1", text: "4" },
      ],
    } as LlmRequest);
    const contents = (mock.bodies[1] as { contents: { parts: unknown[] }[] }).contents;
    assertEquals(contents[1].parts, [{
      functionCall: { name: "roll", args: {} },
      thoughtSignature: "s1",
    }]);
  } finally {
    await mock.close();
  }
});

test("an agent's thinking goes back with its tool results, from the stored step too", async () => {
  const seen: LlmRequest["messages"][] = [];
  const thinker: LlmAdapter = {
    async *generate({ messages }) {
      seen.push(messages);
      const last = messages.at(-1)!;
      if (last.role === "tool") return yield { type: "text", text: "rolled" };
      yield { type: "state", state: { data: ["thinking about dice"] } };
      yield { type: "tool_call", call: { id: `r${seen.length}`, name: "roll", input: {} } };
    },
  };
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      definePlugin({
        name: "app",
        resources: {
          provider: { mind: { adapter: "thinker" } },
          agents: { lead: { instructions: "Roll.", model: "mind/deep" } },
          tools: { roll: { description: "Roll.", run: () => 4 } },
        },
        adapters: { llm: { thinker } },
      }),
    ],
  });
  try {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      text: "roll",
      from: "ana",
    });
    await runtime.idle();
    const state = { by: "mind/deep", data: ["thinking about dice"] };
    // In the turn: the step it just took, with its thinking (as JSON: no text, no field).
    assertEquals(seen[1].at(-2), {
      role: "assistant",
      toolCalls: [{ id: "r1", name: "roll", input: {} }],
      state,
    });
    // The next turn reads the step back from the thread, thinking included.
    await runtime.call("chat.send", { thread, text: "again", from: "ana" });
    await runtime.idle();
    const step = seen[2].find((m) => m.role === "assistant" && m.toolCalls?.length);
    assertEquals(step && "state" in step ? step.state : undefined, state);
  } finally {
    await runtime.close();
  }
});
