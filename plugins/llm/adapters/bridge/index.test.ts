import { assert, assertEquals, assertThrows } from "@std/assert";
import { ContextInputLimitError } from "../../shared/errors.ts";
import {
  createProviderAdapter,
  preflightLlmRequest,
  toolDefinition,
  validateBuiltinProviderCall,
} from "./index.ts";
import type { ChatMessage, ProviderFactory } from "../../shared/types.ts";
import type { LlmJsonObject } from "../../shared/contracts.ts";

Deno.test("bridge renders action schemas as TypeScript tool input types", () => {
  const tool = toolDefinition({
    name: "space_scheduled_jobs",
    description: "Create and manage scheduled jobs.",
    inputSchema: {
      type: "object",
      properties: {
        schedule: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
        },
        action: { type: "string", enum: ["create", "list"] },
      },
      required: ["action", "schedule"],
    },
  });
  const inputTypes = tool.function.inputTypes;
  assert(inputTypes.includes("export interface SpaceScheduledJobsInput {"));
  assert(inputTypes.includes("export interface Schedule {"));
  assert(inputTypes.includes("expression: string;"));
  assert(inputTypes.includes('"create" | "list"'));
  assertEquals(inputTypes.includes('"type": "object"'), false);
});

Deno.test("bridge falls back to a generic type for unrenderable schemas", () => {
  const tool = toolDefinition({
    name: "third_party_tool",
    description: "A third-party tool with an unsupported schema shape.",
    inputSchema: { $ref: 7 } as unknown as LlmJsonObject,
  });

  assertEquals(
    tool.function.inputTypes,
    "export type ToolInput = Record<string, unknown>;\n",
  );
});

Deno.test("provider bridge rejects unsupported built-in session mode", () => {
  assertThrows(() => validateBuiltinProviderCall("openai", "session", {}));
});

Deno.test("bridge preflight uses wire formatting and rejects an oversized request", () => {
  const request = {
    instructions: "System rules " + "x".repeat(2_000),
    tools: [{
      name: "lookup",
      description: "Looks up a record.",
      inputSchema: { type: "object" },
    }],
    messages: [],
  };
  const error = assertThrows(
    () =>
      preflightLlmRequest(request, {
        provider: "openai",
        model: "gpt-test",
        limitEstimatedInputTokens: 10,
      }),
    ContextInputLimitError,
  );
  assert(error.estimatedInputTokens > error.limitEstimatedInputTokens);
});

Deno.test("preflight measures prepared message bodies through the execution projection", () => {
  const message = {
    role: "user" as const,
    content: [{
      assetId: "body",
      kind: "text" as const,
      role: "body",
      mediaType: "text/plain",
      value: "a long conversation sentence ".repeat(300),
    }],
  };
  const request = { messages: [message] };
  const measured = preflightLlmRequest(request, {
    model: "test",
    limitEstimatedInputTokens: 100_000,
  });
  assert(measured.estimatedInputTokens > 100);
  const failure = assertThrows(
    () =>
      preflightLlmRequest(request, {
        model: "test",
        limitEstimatedInputTokens: 100,
      }),
    ContextInputLimitError,
  );
  assertEquals(failure.estimatedInputTokens, measured.estimatedInputTokens);
});

Deno.test("bridge strips native state unless adapter, API, and model all match before formatting", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: ChatMessage[][] = [];
  const protocol: ProviderFactory = () => ({
    endpoint: "https://provider.example/stream",
    headers: () => ({ "content-type": "application/json" }),
    body(messages) {
      bodies.push(structuredClone(messages));
      return { stream: true };
    },
    extractContent(data) {
      return typeof data.text === "string" ? [{ text: data.text }] : null;
    },
    nativeReasoningApi: "provider.native",
  });
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        [
          'data: {"text":"answer"}',
          "",
          'data: {"done":true}',
          "",
        ].join("\n"),
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
    );
  const adapter = createProviderAdapter("openai", {}, protocol);
  const state = {
    schema: "copilotz.llm-native-reasoning.v1" as const,
    adapter: "openai",
    api: "provider.native",
    model: "model",
    blocks: [{ opaque: "state" }],
  };
  const invoke = async (nativeReasoning = state) => {
    const invocation = adapter.call({
      model: "model",
      adapter: "openai",
      providerModel: "model",
      mode: "generate",
      fallbackAvailable: false,
      options: {},
      request: {
        messages: [{
          role: "assistant",
          content: [],
          nativeReasoning,
        }],
      },
      signal: new AbortController().signal,
    });
    await invocation.result;
  };
  try {
    await invoke({ ...state, api: "other.api" });
    assertEquals(bodies[0]?.[0]?.nativeReasoning, undefined);

    await invoke({ ...state, adapter: "other-adapter" });
    assertEquals(bodies[1]?.[0]?.nativeReasoning, undefined);

    await invoke({ ...state, model: "other-model" });
    assertEquals(bodies[2]?.[0]?.nativeReasoning, undefined);

    await invoke();
    assertEquals(bodies[3]?.[0]?.nativeReasoning, state);

    const chatCompletionsOnly: ProviderFactory = () => ({
      ...protocol({}),
      replaysNativeReasoning: false,
    });
    const unsupported = createProviderAdapter(
      "openai",
      {},
      chatCompletionsOnly,
    );
    const invocation = unsupported.call({
      model: "model",
      adapter: "openai",
      providerModel: "model",
      mode: "generate",
      fallbackAvailable: false,
      options: {},
      request: {
        messages: [{ role: "assistant", content: [], nativeReasoning: state }],
      },
      signal: new AbortController().signal,
    });
    await invocation.result;
    assertEquals(bodies[4]?.[0]?.nativeReasoning, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
