import type { ChatContentPart, ChatMessage } from "@/runtime/llm/types.ts";

const EXPLICIT_BREAKPOINT = { mode: "explicit" } as const;

function isOpenAICacheablePart(part: ChatContentPart): boolean {
  return part.type === "text" ||
    part.type === "image_url" ||
    part.type === "input_audio" ||
    part.type === "file";
}

/**
 * Marks the end of content as an explicit provider prompt-cache boundary.
 * The marker remains provider-neutral until the adapter serializes it.
 */
export function withExplicitPromptCacheBreakpoint(
  content: ChatMessage["content"],
): ChatMessage["content"] {
  if (typeof content === "string") {
    if (content.length === 0) return content;
    return [{
      type: "text",
      text: content,
      promptCacheBreakpoint: EXPLICIT_BREAKPOINT,
    }];
  }

  const parts = content.map((part) => ({ ...part }));
  for (let index = parts.length - 1; index >= 0; index--) {
    if (!isOpenAICacheablePart(parts[index])) continue;
    parts[index] = {
      ...parts[index],
      promptCacheBreakpoint: EXPLICIT_BREAKPOINT,
    };
    return parts;
  }

  return parts;
}

export function withoutPromptCacheBreakpoint(
  content: ChatMessage["content"],
): ChatMessage["content"] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    const { promptCacheBreakpoint: _, ...rest } = part;
    return rest as ChatContentPart;
  });
}
