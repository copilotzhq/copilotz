export const NO_RESPONSE_SELF_CLOSING_TAG = "<no_response/>";

export const COPILOTZ_CONTROL_TAGS = [
  "tool_calls",
  "tool_results",
  "no_response",
  "continue_after_tool_results",
] as const;

/**
 * Literal special-token markers some model servers leak as raw text when their
 * native tool/message framing is not parsed server-side. These never appear in
 * legitimate output, so they are always safe to strip.
 */
export const STRUCTURAL_LEAK_LITERALS = [
  "]<]minimax[>[",
  "]~!b[",
  "]~b]",
  "[e~[",
] as const;

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeStructuredTagNames(tagNames: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const candidate of tagNames) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!/^[a-z][a-z0-9_:-]*$/i.test(trimmed)) continue;

    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    normalized.push(trimmed);
  }

  return normalized;
}

export function suffixPrefix(text: string, tag: string): number {
  const maxLen = Math.min(text.length, tag.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (text.slice(-len) === tag.slice(0, len)) return len;
  }
  return 0;
}

export function suffixPrefixAny(text: string, tags: string[]): number {
  let maxOverlap = 0;
  for (const tag of tags) {
    maxOverlap = Math.max(maxOverlap, suffixPrefix(text, tag));
  }
  return maxOverlap;
}
