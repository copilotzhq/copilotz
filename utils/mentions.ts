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
