import type {
  ContentRef,
  ContentSequence,
  DurableContentInput,
  PreparedAsset,
  PreparedContent,
} from "../content/index.ts";
import { cloneContentRef } from "../content/input.ts";
import { workflowCanonicalJson } from "./workflow-support.ts";

export type RoleContentInput = Readonly<{
  role: string;
  input: DurableContentInput;
  cardinality?: "one" | "many";
}>;

function isSequence(value: DurableContentInput): value is ContentSequence {
  return Array.isArray(value);
}

function asPrepared(value: DurableContentInput): PreparedContent {
  return isSequence(value) ? { content: value, assets: [] } : value;
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
        existing && workflowCanonicalJson({
            namespace: existing.namespace,
            mediaType: existing.mediaType,
            byteLength: existing.byteLength,
            digest: existing.digest,
            idempotencyKey: existing.idempotencyKey,
          }) !== workflowCanonicalJson({
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

export function contentWithRole(
  content: ContentSequence,
  role: string,
): ContentSequence {
  return Object.freeze(
    content.filter((ref) => ref.role === role).map(cloneContentRef),
  );
}

export function firstContentWithRole(
  content: ContentSequence,
  role: string,
): ContentRef | undefined {
  const ref = content.find((candidate) => candidate.role === role);
  return ref ? cloneContentRef(ref) : undefined;
}

export function assertRoleContentMatches(
  actual: ContentSequence,
  expected: ContentSequence,
  roles: ReadonlySet<string>,
  label: string,
): void {
  const select = (value: ContentSequence) =>
    value.filter((ref) => roles.has(ref.role));
  if (
    workflowCanonicalJson(select(actual)) !==
      workflowCanonicalJson(select(expected))
  ) {
    throw new Error(
      `${label} deduplication identity was reused with different content.`,
    );
  }
}
