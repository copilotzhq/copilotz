/** Browser-safe content serialization and reference validation. @module */
import { assertJsonValue } from "../json.ts";
import { base64ToBytes, bytesToBase64, parseDataUrl } from "./encoding.ts";
import { canonicalizeContentRefs } from "./input.ts";
import { capturePendingContentRef, isContentRef } from "./schema.ts";
import type { ContentInput, ContentRef, PendingContentRef } from "./types.ts";

type MediaInput = Extract<ContentInput, { bytes: Uint8Array }>;
/** Canonical JSON media representation. Encoders never emit data URLs or bytes. */
export type ContentWireInput =
  | Exclude<ContentInput, MediaInput>
  | (
    Omit<MediaInput, "bytes"> & { dataBase64: string }
  );
const media = new Set(["image", "audio", "video", "file"]);

function assertJson(value: unknown): void {
  assertJsonValue(value, {
    label: "Content",
    maxDepth: 64,
    omitUndefinedProperties: true,
  });
}

function part(value: unknown): ContentInput {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      "Content must be text, a reference, or a typed content object.",
    );
  }
  assertJsonValue(value, {
    label: "Content",
    maxDepth: 64,
    omitUndefinedProperties: true,
    allowBytes: true,
  });
  const input = structuredClone(value) as Record<string, unknown>;
  if (isContentRef(input)) {
    const ref = canonicalizeContentRefs(input) as ContentRef;
    assertJson(ref);
    return ref;
  }
  if (input.type === "text" && typeof input.text === "string") {
    assertJson(input);
    return input as ContentInput;
  }
  if (input.type === "json" && Object.hasOwn(input, "value")) {
    assertJson(input.value);
    assertJson(input);
    return input as ContentInput;
  }
  if (typeof input.type !== "string" || !media.has(input.type)) {
    throw new TypeError("Unsupported content type.");
  }
  if ("url" in input) {
    throw new TypeError(
      "Use dataUrl for inline media; remote URLs are not content bodies.",
    );
  }
  const keys = ["bytes", "dataBase64", "dataUrl"].filter((key) =>
    Object.hasOwn(input, key)
  );
  if (keys.length !== 1) {
    throw new TypeError(
      "Media requires exactly one of bytes, dataBase64, or dataUrl.",
    );
  }
  let bytes: Uint8Array;
  let mediaType = input.mediaType;
  if (keys[0] === "bytes") {
    if (!(input.bytes instanceof Uint8Array)) {
      throw new TypeError("Media bytes must be Uint8Array.");
    }
    bytes = input.bytes;
  } else if (keys[0] === "dataBase64") {
    if (
      typeof input.dataBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        input.dataBase64,
      )
    ) {
      throw new TypeError("Media dataBase64 must be canonical base64.");
    }
    bytes = base64ToBytes(input.dataBase64);
    if (bytesToBase64(bytes) !== input.dataBase64) {
      throw new TypeError("Media base64 has invalid padding bits.");
    }
    mediaType ??= "application/octet-stream";
  } else {
    const decoded = typeof input.dataUrl === "string"
      ? parseDataUrl(input.dataUrl)
      : null;
    if (!decoded) throw new TypeError("Invalid media dataUrl.");
    if (mediaType !== undefined && mediaType !== decoded.mediaType) {
      throw new TypeError("Media type conflicts with dataUrl.");
    }
    bytes = decoded.bytes;
    mediaType = decoded.mediaType;
  }
  if (typeof mediaType !== "string" || !mediaType.trim()) {
    throw new TypeError("Media type must be non-empty.");
  }
  const { dataBase64: _base64, dataUrl: _url, bytes: _bytes, ...rest } = input;
  assertJson(rest);
  return { ...rest, bytes, mediaType } as MediaInput;
}

/** Decode in-memory or JSON-safe content; never performs I/O or Asset publication. */
export function decodeContent(
  input: unknown,
): ContentInput | readonly ContentInput[] {
  return Array.isArray(input) ? (input.map(part)) : part(input);
}

/** Generated inputs preserve catalog pointers until the owner Collection
 * transaction adopts them. Ordinary decodeContent still rejects these pointers. */
export function decodeGeneratedContent(
  input: unknown,
):
  | ContentInput
  | PendingContentRef
  | readonly (ContentInput | PendingContentRef)[] {
  assertJsonValue(input, {
    label: "Generated content",
    maxDepth: 64,
    maxNodes: 20000,
    allowBytes: true,
    omitUndefinedProperties: true,
  });
  const candidate = (value: unknown): ContentInput | PendingContentRef => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const type = Object.getOwnPropertyDescriptor(value, "type");
      if (type && "value" in type && type.value === "content.pending") {
        return capturePendingContentRef(value);
      }
    }
    return part(value);
  };
  if (!Array.isArray(input)) return candidate(input);
  // Never dispatch a caller-owned map, iterator or Array species constructor.
  const descriptors = Object.getOwnPropertyDescriptors(input as object);
  const length: unknown = descriptors.length?.value;
  if (
    typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
    length > 20000 ||
    Reflect.ownKeys(descriptors).length !== length + 1
  ) throw new TypeError("Invalid generated content sequence.");
  const output: (ContentInput | PendingContentRef)[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Invalid generated content sequence.");
    }
    output.push(candidate(descriptor.value));
  }
  return output;
}

/** Encode media once for durable JSON ingress; preserves sequence ordering and metadata. */
export function encodeContent(input: ContentInput): ContentWireInput;
export function encodeContent(
  input: readonly ContentInput[],
): readonly ContentWireInput[];
export function encodeContent(
  input: ContentInput | readonly ContentInput[],
): ContentWireInput | readonly ContentWireInput[];
export function encodeContent(
  input: ContentInput | readonly ContentInput[],
): ContentWireInput | readonly ContentWireInput[] {
  const encode = (value: unknown): ContentWireInput => {
    const decoded = part(value);
    if (typeof decoded === "object" && "bytes" in decoded) {
      const { bytes, ...rest } = decoded;
      return ({ ...rest, dataBase64: bytesToBase64(bytes) } as const);
    }
    return decoded;
  };
  return Array.isArray(input) ? (input.map(encode)) : encode(input);
}

export {
  capturePendingContentRef,
  generatedContentSequenceSchema,
  isContentRef,
  isPendingContentRef,
  pendingContentRefSchema,
} from "./schema.ts";
export type {
  ContentJsonValue,
  ContentRef,
  GeneratedContentSequence,
  PendingContentRef,
} from "./types.ts";

export { canonicalJson, orderedJson } from "../data-only-json.ts";
export { captureJsonValue } from "../json.ts";
