/** Current Core thread metadata: public data and opaque plugin-owned system namespaces. */
export interface StructuredThreadMetadata {
  public?: Record<string, unknown>;
  system?: Record<string, unknown>;
}
export interface ThreadTag {
  id: string;
  name: string;
  color?: string;
}
const MAX_THREAD_TAGS = 20;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? structuredClone(value) : {};
}
function removeUndefinedKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
export function normalizeThreadMetadata(
  raw: unknown,
): StructuredThreadMetadata {
  const value = isRecord(raw) ? raw : {};
  return {
    public: cloneRecord(value.public),
    system: cloneRecord(value.system),
  };
}
export function mergeThreadMetadata(
  base: unknown,
  patch: unknown,
): StructuredThreadMetadata {
  const before = normalizeThreadMetadata(base),
    after = normalizeThreadMetadata(patch);
  return {
    public: removeUndefinedKeys({ ...before.public, ...after.public }),
    system: removeUndefinedKeys({ ...before.system, ...after.system }),
  };
}
export function getPublicThreadMetadata(raw: unknown): Record<string, unknown> {
  return normalizeThreadMetadata(raw).public!;
}
export function getSerializableThreadMetadata(
  raw: unknown,
): Record<string, unknown> | null {
  const value = normalizeThreadMetadata(raw);
  const result = {
    ...(Object.keys(value.public!).length ? { public: value.public } : {}),
    ...(Object.keys(value.system!).length ? { system: value.system } : {}),
  };
  return Object.keys(result).length ? result : null;
}
function slugTagName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "tag";
}

function normalizeThreadTag(value: unknown): ThreadTag | null {
  if (typeof value === "string") {
    const name = value.trim();
    if (!name) return null;
    return {
      id: `tag_${slugTagName(name)}`,
      name,
    };
  }

  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  const rawId = typeof value.id === "string" ? value.id.trim() : "";
  const color = typeof value.color === "string" && value.color.trim()
    ? value.color.trim()
    : undefined;
  return removeUndefinedKeys({
    id: rawId || `tag_${slugTagName(name)}`,
    name,
    color,
  });
}

/** Returns normalized public thread tags from `metadata.public.tags`. */
export function getThreadTags(raw: unknown): ThreadTag[] {
  const publicMetadata = getPublicThreadMetadata(raw);
  const rawTags = publicMetadata.tags;
  if (!Array.isArray(rawTags)) return [];

  const byId = new Map<string, ThreadTag>();
  const seenNames = new Set<string>();
  for (const rawTag of rawTags) {
    const tag = normalizeThreadTag(rawTag);
    if (!tag) continue;
    const nameKey = tag.name.toLowerCase();
    if (byId.has(tag.id) || seenNames.has(nameKey)) continue;
    byId.set(tag.id, tag);
    seenNames.add(nameKey);
    if (byId.size >= MAX_THREAD_TAGS) break;
  }
  return Array.from(byId.values());
}

/** Returns metadata with `metadata.public.tags` replaced by normalized tags. */
export function setThreadTags(
  raw: unknown,
  tags: unknown[],
): StructuredThreadMetadata {
  return mergeThreadMetadata(raw, {
    public: {
      tags: tags.length > 0 ? getThreadTags({ public: { tags } }) : [],
    },
  });
}

/** Returns metadata with a tag added to `metadata.public.tags`. */
export function addThreadTag(
  raw: unknown,
  tag: unknown,
): StructuredThreadMetadata {
  return setThreadTags(raw, [...getThreadTags(raw), tag]);
}

/** Returns metadata with a tag removed from `metadata.public.tags`. */
export function removeThreadTag(
  raw: unknown,
  tagId: string,
): StructuredThreadMetadata {
  const normalizedTagId = tagId.trim();
  return setThreadTags(
    raw,
    getThreadTags(raw).filter((tag) => tag.id !== normalizedTagId),
  );
}
