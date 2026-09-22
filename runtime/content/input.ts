import { createContentError } from "./errors.ts";
import { isContentRef } from "./schema.ts";
import type {
  AssetOrigin,
  ContentInput,
  ContentKind,
  ContentRef,
  ContentRole,
  ContentSequence,
  NormalizeContentOptions,
} from "./types.ts";

export type ContentBodyCandidate = Readonly<{
  body: Uint8Array;
  mediaType: string;
  kind: ContentKind;
  role: ContentRole;
  index: number;
  idempotencyKey?: string;
  origin?: AssetOrigin;
  fields: Omit<ContentRef, "assetId" | "kind" | "role" | "mediaType">;
}>;

export type ContentInputMaterializer = Readonly<{
  materialize(candidate: ContentBodyCandidate): Promise<ContentRef>;
  reference(ref: ContentRef, index: number): Promise<ContentRef>;
}>;

function cloneMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return metadata === undefined ? undefined : structuredClone(metadata);
}

export function withoutUndefined<T extends Record<string, unknown>>(
  value: T,
): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

export function cloneContentRef(ref: ContentRef): ContentRef {
  return withoutUndefined({
    assetId: ref.assetId,
    kind: ref.kind,
    role: ref.role,
    mediaType: ref.mediaType,
    name: ref.name,
    alt: ref.alt,
    language: ref.language,
    disposition: ref.disposition,
    metadata: cloneMetadata(ref.metadata),
  });
}

/** Removes resolved data from Content references before JSON becomes durable. */
export function canonicalizeContentRefs(value: unknown): unknown {
  if (isContentRef(value)) {
    const ref = cloneContentRef(value);
    const canonical = ref.metadata === undefined ? ref : {
      ...ref,
      metadata: canonicalizeContentRefs(ref.metadata) as Record<
        string,
        unknown
      >,
    };
    // `resolve: false` is a caller-owned instruction to keep this reference
    // descriptor-only. Unlike a hydrated value, it must survive Action replay.
    return (value as { resolve?: unknown }).resolve === false
      ? { ...canonical, resolve: false }
      : canonical;
  }
  if (Array.isArray(value)) return value.map(canonicalizeContentRefs);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return structuredClone(value);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        canonicalizeContentRefs(child),
      ]),
    );
  }
  return value;
}

function defaultRole(kind: ContentKind): ContentRole {
  return kind === "text" || kind === "json" ? "body" : "attachment";
}

function childIdempotencyKey(base: string | undefined, index: number) {
  return base ? `${base}:${index}` : undefined;
}

function textFields(input: Extract<ContentInput, { type: "text" }>) {
  return withoutUndefined({
    name: input.name,
    language: input.language,
    metadata: cloneMetadata(input.metadata),
  });
}

function binaryFields(
  input: Extract<ContentInput, { bytes: Uint8Array }>,
) {
  return withoutUndefined({
    name: input.name,
    alt: input.alt,
    language: input.language,
    disposition: input.disposition,
    metadata: cloneMetadata(input.metadata),
  });
}

/** Shared runtime-neutral parser used by immediate and atomic content paths. */
export async function materializeContentInput(
  input: ContentInput | readonly ContentInput[],
  options: NormalizeContentOptions,
  materializer: ContentInputMaterializer,
): Promise<ContentSequence> {
  const namespace = options.namespace.trim();
  if (!namespace) {
    throw createContentError(
      "content_invalid",
      "Content namespace must be a non-empty string.",
    );
  }
  const values = Array.isArray(input) ? input : [input];
  const refs: ContentRef[] = [];

  const body = async (
    bytes: Uint8Array,
    mediaType: string,
    kind: ContentKind,
    role: ContentRole | undefined,
    index: number,
    fields: ContentBodyCandidate["fields"],
    origin?: AssetOrigin,
  ) => {
    refs.push(
      await materializer.materialize({
        body: bytes,
        mediaType,
        kind,
        role: role ?? defaultRole(kind),
        index,
        idempotencyKey: childIdempotencyKey(options.idempotencyKey, index),
        origin: origin ?? options.origin,
        fields,
      }),
    );
  };

  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (typeof value === "string") {
      await body(
        new TextEncoder().encode(value),
        "text/plain; charset=utf-8",
        "text",
        "body",
        index,
        {},
      );
      continue;
    }

    if (!(value && typeof value === "object")) {
      throw createContentError(
        "content_invalid",
        `Unsupported content value at index ${index}.`,
        { namespace },
      );
    }

    if ("assetId" in value) {
      refs.push(await materializer.reference(value as ContentRef, index));
      continue;
    }

    if (value.type === "text") {
      await body(
        new TextEncoder().encode(value.text),
        value.mediaType?.trim() || "text/plain; charset=utf-8",
        "text",
        value.role,
        index,
        textFields(value),
        value.origin,
      );
      continue;
    }

    if (value.type === "json") {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(canonicalizeContentRefs(value.value));
      } catch (cause) {
        throw createContentError(
          "content_invalid",
          `JSON content at index ${index} is not serializable.`,
          { namespace, cause },
        );
      }
      if (encoded === undefined) {
        throw createContentError(
          "content_invalid",
          `JSON content at index ${index} is not serializable.`,
          { namespace },
        );
      }
      await body(
        new TextEncoder().encode(encoded),
        value.mediaType?.trim() || "application/json",
        "json",
        value.role,
        index,
        withoutUndefined({
          name: value.name,
          metadata: cloneMetadata(value.metadata),
        }),
        value.origin,
      );
      continue;
    }

    if (
      value.type === "image" || value.type === "audio" ||
      value.type === "video" || value.type === "file"
    ) {
      if (!(value.bytes instanceof Uint8Array)) {
        throw createContentError(
          "content_invalid",
          `Binary content at index ${index} must contain Uint8Array bytes.`,
          { namespace },
        );
      }
      if (!value.mediaType.trim()) {
        throw createContentError(
          "content_invalid",
          `Binary content at index ${index} requires a media type.`,
          { namespace },
        );
      }
      await body(
        value.bytes,
        value.mediaType.trim(),
        value.type,
        value.role,
        index,
        binaryFields(value),
        value.origin,
      );
      continue;
    }

    throw createContentError(
      "content_invalid",
      `Unsupported content value at index ${index}.`,
      { namespace },
    );
  }

  return refs;
}
