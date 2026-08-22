import type {
  ContentRef,
  ContentSequence,
  DurableContentInput,
  PreparedAsset,
  PreparedContent,
} from "./types.ts";
import { cloneContentRef } from "./input.ts";

export type RoleContentInput = Readonly<{
  role: string;
  input: DurableContentInput;
  cardinality?: "one" | "many";
}>;

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function isSequence(value: DurableContentInput): value is ContentSequence {
  return Array.isArray(value);
}

function asPrepared(value: DurableContentInput): PreparedContent {
  return isSequence(value) ? { content: value, assets: [] } : value;
}

export function contentSequence(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value) as ContentSequence;
}

/** Combines independently prepared fields into one transaction batch. */
export function composeRoleContent(
  fields: readonly RoleContentInput[],
): PreparedContent {
  const content: ContentRef[] = [];
  const assets = new Map<string, PreparedAsset>();
  for (const field of fields) {
    const prepared = asPrepared(field.input);
    if (field.cardinality === "one" && prepared.content.length !== 1) {
      throw new TypeError(`${field.role} requires exactly one content ref.`);
    }
    for (const ref of prepared.content) {
      content.push(cloneContentRef({ ...ref, role: field.role }));
    }
    for (const asset of prepared.assets) {
      const existing = assets.get(asset.id);
      if (
        existing && canonicalJson({
            namespace: existing.namespace,
            mediaType: existing.mediaType,
            byteLength: existing.byteLength,
            digest: existing.digest,
            idempotencyKey: existing.idempotencyKey,
          }) !== canonicalJson({
            namespace: asset.namespace,
            mediaType: asset.mediaType,
            byteLength: asset.byteLength,
            digest: asset.digest,
            idempotencyKey: asset.idempotencyKey,
          })
      ) {
        throw new TypeError(`Prepared asset '${asset.id}' is inconsistent.`);
      }
      if (!existing) assets.set(asset.id, asset);
    }
  }
  return Object.freeze({
    content: Object.freeze(content),
    assets: Object.freeze([...assets.values()]),
  });
}

export function replaceContentRoles(
  current: ContentSequence,
  replacement: ContentSequence,
  roles: ReadonlySet<string>,
): ContentSequence {
  return Object.freeze([
    ...current.filter((ref) => !roles.has(ref.role)).map(cloneContentRef),
    ...replacement.map(cloneContentRef),
  ]);
}
