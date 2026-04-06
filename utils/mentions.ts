/**
 * Extract @mention names from free text, preserving first-seen order and
 * de-duplicating case-insensitively.
 */
export function extractMentionNames(content: string): string[] {
  const mentionPattern = /(?<!\w)@([\w](?:[\w.-]*[\w])?)/g;
  const matches = content.matchAll(mentionPattern);

  const mentions: string[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const name = match[1];
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) continue;

    mentions.push(name);
    seen.add(normalized);
  }

  return mentions;
}

/**
 * Build routing from ordered mentions while preserving a return path.
 * The first mention becomes the next target. Any additional mentions,
 * followed by the explicit return target and fallback queue, become the
 * remaining target queue with case-insensitive de-duplication.
 */
export function buildMentionTargetRoute(
  mentions: string[],
  options?: {
    returnTarget?: string | null;
    fallbackQueue?: string[] | null;
  },
): { targetId: string; targetQueue: string[] } | null {
  if (mentions.length === 0) return null;

  const [targetId, ...mentionedQueue] = mentions;
  const queue: string[] = [];
  const seen = new Set<string>([targetId.toLowerCase()]);

  const append = (candidate: string | null | undefined) => {
    if (typeof candidate !== "string") return;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) return;

    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) return;

    queue.push(trimmed);
    seen.add(normalized);
  };

  for (const mention of mentionedQueue) append(mention);
  append(options?.returnTarget);
  for (const fallback of options?.fallbackQueue ?? []) append(fallback);

  return { targetId, targetQueue: queue };
}
