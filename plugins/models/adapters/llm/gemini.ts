/** Google Gemini generateContent API, streaming. */
import type { JSONSchema } from "../../../../runtime/mod.ts";
import { post, sse, usageOf } from "../../shared/provider.ts";
import type { ModelInfo } from "../../shared/choice.ts";
import type { Effort, LlmAdapter, LlmMessage } from "../../shared/types.ts";

export const GEMINI = {
  name: "Gemini",
  baseURL: "https://generativelanguage.googleapis.com/v1beta",
  auth: (apiKey: string) => ({ "x-goog-api-key": apiKey }),
};

type Part = Record<string, unknown>;

/** Thought signatures Gemini 3 needs back: by tool call id, and on its text. */
type Signatures = { calls?: Record<string, string>; text?: string };

/**
 * Gemini answers tool calls by function name: find each call's name by its
 * id. A model turn's thought signatures (its state) go back on their parts.
 */
const contentsOf = (messages: LlmMessage[]) => {
  const names = new Map<string, string>();
  const turns: { role: "user" | "model"; parts: Part[] }[] = [];
  const add = (role: "user" | "model", parts: Part[]) => {
    if (!parts.length) return;
    const last = turns.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else turns.push({ role, parts });
  };
  for (const message of messages) {
    if (message.role === "tool") {
      add("user", [{
        functionResponse: {
          name: names.get(message.toolCallId) ?? message.toolCallId,
          response: { result: message.text },
        },
      }]);
    } else if (message.role === "user") {
      add("user", [
        ...(message.text ? [{ text: message.text }] : []),
        ...(message.files ?? []).map((file) => ({
          inlineData: { mimeType: file.type, data: file.data },
        })),
      ]);
    } else {
      for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
      const signed = (message.state?.data ?? {}) as Signatures;
      const sign = (signature?: string) => signature ? { thoughtSignature: signature } : {};
      add("model", [
        ...(message.text ? [{ text: message.text, ...sign(signed.text) }] : []),
        ...(message.toolCalls ?? []).map((call) => ({
          functionCall: { name: call.name, args: call.input },
          ...sign(signed.calls?.[call.id]),
        })),
      ]);
    }
  }
  return turns;
};

const KEEP = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "title",
]);

/** Gemini accepts a subset of JSON Schema: keep what it understands. */
export function schemaFor(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaFor);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!KEEP.has(key)) continue;
    if (key === "type" && Array.isArray(value)) {
      // ["string", "null"] becomes a nullable string.
      const types = value.filter((t) => t !== "null");
      out.type = types[0];
      if (types.length < value.length) out.nullable = true;
    } else if (key === "properties") {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, schemaFor(v)]),
      );
    } else out[key] = key === "items" || key === "anyOf" ? schemaFor(value) : value;
  }
  return out;
}

const declaration = (tool: { name: string; description: string; input: JSONSchema }) => {
  const parameters = schemaFor(tool.input) as { type?: string; properties?: object };
  // An object without properties is "no parameters" to Gemini.
  const empty = parameters.type === "object" && !Object.keys(parameters.properties ?? {}).length;
  return { name: tool.name, description: tool.description, ...(empty ? {} : { parameters }) };
};

/** Thinking budgets for models that take one (Gemini 2.5); -1 lets the model decide. */
const BUDGETS: Record<Effort, number> = {
  none: 0,
  minimal: 512,
  low: 2048,
  medium: 8192,
  high: 16_384,
  xhigh: 24_576,
  max: -1,
};

/** How hard to think, as the model takes it: a level (Gemini 3), a budget (2.5), or off. */
function thinkingConfig(effort: Effort | undefined, info: ModelInfo | undefined) {
  const reasoning = info?.reasoning;
  if (!effort || reasoning === false) return undefined;
  if (reasoning?.budget && !reasoning.effort) {
    const budget = BUDGETS[effort];
    const { min = 0, max = Infinity } = reasoning.budget;
    return { thinkingBudget: budget <= 0 ? budget : Math.min(Math.max(budget, min), max) };
  }
  if (effort === "none") return reasoning?.toggle ? { thinkingBudget: 0 } : undefined;
  return { thinkingLevel: effort.toUpperCase() };
}

export const gemini: LlmAdapter = {
  media: ["image", "pdf", "audio", "video"],
  async *generate(
    {
      connection,
      effort,
      maxTokens,
      temperature,
      options,
      info,
      instructions,
      messages,
      tools = [],
      signal,
    },
  ) {
    const thinking = thinkingConfig(effort, info);
    const generationConfig = {
      ...(thinking ? { thinkingConfig: thinking } : {}),
      ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };
    const response = await post(
      connection,
      GEMINI,
      `/models/${encodeURIComponent(connection.model)}:streamGenerateContent?alt=sse`,
      {
        contents: contentsOf(messages),
        ...(instructions ? { systemInstruction: { parts: [{ text: instructions }] } } : {}),
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map(declaration) }] } : {}),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
        ...options,
      },
      signal,
    );
    const signatures: Signatures = {};
    let usage: Record<string, number | undefined> | undefined;
    for await (const { data } of sse(response.body!)) {
      const chunk = JSON.parse(data);
      if (chunk.error) {
        throw new Error(`Gemini: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      }
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        const signature = typeof part.thoughtSignature === "string"
          ? part.thoughtSignature
          : undefined;
        if (part.text && !part.thought) yield { type: "text", text: part.text };
        if (part.functionCall) {
          const id = part.functionCall.id ?? crypto.randomUUID();
          if (signature) (signatures.calls ??= {})[id] = signature;
          yield {
            type: "tool_call",
            call: { id, name: part.functionCall.name, input: part.functionCall.args ?? {} },
          };
        } else if (signature) signatures.text = signature;
      }
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }
    if (signatures.calls || signatures.text) yield { type: "state", state: { data: signatures } };
    if (usage) {
      // The prompt count includes cached tokens; thoughts are output, billed as such.
      yield {
        type: "usage",
        ...usageOf({
          input: usage.promptTokenCount ?? 0,
          output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          cached: usage.cachedContentTokenCount,
          reasoning: usage.thoughtsTokenCount,
        }),
      };
    }
  },
};
