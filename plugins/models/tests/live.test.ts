/**
 * Against real provider APIs, when their keys are set (COPILOTZ_LIVE=1, and
 * OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY). Each adapter answers
 * a tool call with some reasoning effort, then uses the tool's result.
 */
import { assert, assertEquals } from "@std/assert";
import plugin, { type LlmMessage, type ModelRef } from "../mod.ts";
import { complete } from "../shared/generate.ts";
import { embed } from "../shared/embed.ts";
import { transcribe } from "../shared/transcribe.ts";
import { env, test } from "../../../testing/mod.ts";

const live = env("COPILOTZ_LIVE") === "1";
const key = (name: string) => env(name);
const reach = {
  resources: {
    provider: {
      // Providers the catalog knows: just the key.
      openai: { apiKey: key("OPENAI_API_KEY") },
      anthropic: { apiKey: key("ANTHROPIC_API_KEY") },
      google: { apiKey: key("GEMINI_API_KEY") },
      // OpenAI's models through Chat Completions: priced and checked as OpenAI's.
      "openai-chat": {
        adapter: "openai-compatible",
        catalog: "openai",
        apiKey: key("OPENAI_API_KEY"),
      },
    },
  },
  adapters: {
    llm: plugin.adapters!.llm,
    embeddings: plugin.adapters!.embeddings,
    transcription: plugin.adapters!.transcription,
  },
  signal: new AbortController().signal,
};

const tools = [{
  name: "roll_dice",
  description: "Roll a die with the given number of sides and return the result.",
  input: {
    type: "object",
    properties: { sides: { type: "integer", description: "Number of sides" } },
    required: ["sides"],
  } as const,
}];

// Each with an effort, so reasoning models think, and their thinking goes back with the tool result.
const models: [string, string, ModelRef][] = [
  // OpenAI takes tools with reasoning on Chat Completions only at effort "none".
  ["openai-compatible", "OPENAI_API_KEY", {
    model: `openai-chat/${key("COPILOTZ_OPENAI_COMPLETIONS_MODEL") ?? "gpt-5.4-mini"}`,
    effort: "none",
  }],
  ["openai", "OPENAI_API_KEY", {
    model: `openai/${key("COPILOTZ_OPENAI_MODEL") ?? "gpt-6.1-sol"}`,
    effort: "low",
  }],
  ["anthropic", "ANTHROPIC_API_KEY", {
    model: `anthropic/${key("COPILOTZ_ANTHROPIC_MODEL") ?? "claude-sonnet-5-5"}`,
    effort: "low",
  }],
  ["gemini", "GEMINI_API_KEY", {
    model: `google/${key("COPILOTZ_GEMINI_MODEL") ?? "gemini-3-flash"}`,
    effort: "low",
  }],
];

for (const [name, secret, model] of models) {
  test({
    name: `live ${name}: a tool call and its result`,
    ignore: !live || !key(secret),
    async fn() {
      const messages: LlmMessage[] = [{ role: "user", text: "Roll a 20-sided die with the tool." }];
      const first = await complete(reach, {
        model,
        instructions: "Use tools when asked. Be brief.",
        messages,
        tools,
      });
      assertEquals(first.toolCalls.length, 1, JSON.stringify(first));
      assertEquals(first.toolCalls[0].name, "roll_dice");
      assertEquals(first.toolCalls[0].input.sides, 20);
      assert(first.usage && first.usage.input > 0 && first.usage.output > 0);
      messages.push(
        { role: "assistant", text: first.text, toolCalls: first.toolCalls, state: first.state },
        { role: "tool", toolCallId: first.toolCalls[0].id, text: "17" },
      );
      const second = await complete(reach, {
        model,
        instructions: "Use tools when asked. Be brief.",
        messages,
        tools,
      });
      assert(second.text.includes("17"), second.text);
    },
  });
}

test({
  name: "live openai embeddings",
  ignore: !live || !key("OPENAI_API_KEY"),
  async fn() {
    const { vectors, usage } = await embed(reach, {
      model: { model: "openai/text-embedding-3-small", dimensions: 8 },
      input: ["hello", "world"],
    });
    assertEquals(vectors.map((v) => v.length), [8, 8]);
    assert(usage && usage.input > 0);
  },
});

test({
  name: "live openai transcription (of speech the API itself generates)",
  ignore: !live || !key("OPENAI_API_KEY"),
  async fn() {
    const speech = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key("OPENAI_API_KEY")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: "The quick brown fox.",
        response_format: "mp3",
      }),
    });
    assert(speech.ok, await speech.clone().text());
    const { text } = await transcribe(reach, {
      model: "openai/gpt-4o-mini-transcribe",
      audio: {
        data: new Uint8Array(await speech.arrayBuffer()),
        type: "audio/mpeg",
        language: "en",
      },
    });
    assert(/quick brown fox/i.test(text), text);
  },
});
