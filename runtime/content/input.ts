import { createContentError } from "./errors.ts";
import type {
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
  role: ContentRole | string;
  index: number;
  idempotencyKey?: string;
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
    ...ref,
    metadata: cloneMetadata(ref.metadata),
  });
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
    role: ContentRole | string | undefined,
    index: number,
    fields: ContentBodyCandidate["fields"],
  ) => {
    refs.push(
      await materializer.materialize({
        body: bytes,
        mediaType,
        kind,
        role: role ?? defaultRole(kind),
        index,
        idempotencyKey: childIdempotencyKey(options.idempotencyKey, index),
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
      );
      continue;
    }

    if (value.type === "json") {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(value.value);
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
