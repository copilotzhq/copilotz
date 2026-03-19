import type { MessagePayload } from "@/interfaces/index.ts";

type RawInboundToolCall = {
  id?: unknown;
  name?: unknown;
  args?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
};

type InboundMessagePayload = MessagePayload & { tool_calls?: unknown };

function parseInboundToolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

export function normalizeInboundToolCalls(
  message: InboundMessagePayload,
): MessagePayload["toolCalls"] {
  const metadataToolCalls =
    message.metadata && typeof message.metadata === "object" &&
      Array.isArray((message.metadata as { toolCalls?: unknown[] }).toolCalls)
      ? (message.metadata as { toolCalls?: unknown[] }).toolCalls
      : null;

  const source = Array.isArray(message.toolCalls)
    ? message.toolCalls
    : Array.isArray(message.tool_calls)
      ? message.tool_calls
      : metadataToolCalls;

  if (!Array.isArray(source)) {
    return null;
  }

  return source.flatMap((call) => {
    if (!call || typeof call !== "object") {
      return [];
    }

    const rawCall = call as RawInboundToolCall;
    const name = typeof rawCall.name === "string" && rawCall.name.trim().length > 0
      ? rawCall.name
      : typeof rawCall.function?.name === "string" &&
          rawCall.function.name.trim().length > 0
      ? rawCall.function.name
      : null;

    if (!name) {
      return [];
    }

    return [{
      id: typeof rawCall.id === "string" ? rawCall.id : null,
      tool: { id: name, name },
      args: parseInboundToolArgs(rawCall.args ?? rawCall.function?.arguments),
    }];
  });
}

export function normalizeInboundRunMessage(
  message: InboundMessagePayload,
): MessagePayload {
  return {
    ...message,
    toolCalls: normalizeInboundToolCalls(message),
  };
}

export function hasRunInput(message: MessagePayload): boolean {
  if (typeof message.content === "string") {
    if (message.content.trim().length > 0) {
      return true;
    }
  } else if (Array.isArray(message.content) && message.content.length > 0) {
    return true;
  }

  return Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
}
