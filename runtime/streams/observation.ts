import type { ContentStreamOpened } from "./stream.ts";
import type { StreamOutputDescriptor } from "./types.ts";
import { deepFreeze, snapshotStreamMetadata } from "./json.ts";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function plainMetadata(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  try {
    return Boolean(value) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Boolean(snapshotStreamMetadata(value));
  } catch {
    return false;
  }
}

/** Creates the one serializable publication emitted by each opened stream. */
export function createStreamOutputDescriptor(
  stream: ContentStreamOpened,
  context: Readonly<{
    namespace: string;
    correlationId?: string;
    causationId?: string;
    metadata?: Readonly<Record<string, unknown>>;
  }>,
): StreamOutputDescriptor {
  const streamMetadata = snapshotStreamMetadata(stream.metadata);
  const contextMetadata = snapshotStreamMetadata(context.metadata ?? {});
  const metadata = deepFreeze({
    ...streamMetadata,
    ...contextMetadata,
  });
  return Object.freeze({
    type: "stream.output",
    namespace: requiredText(context.namespace, "Stream output namespace"),
    streamId: requiredText(stream.id, "Stream output id"),
    mediaType: requiredText(stream.mediaType, "Stream output mediaType"),
    kind: stream.kind,
    role: requiredText(stream.role, "Stream output role"),
    ...(stream.name ? { name: stream.name } : {}),
    ...(stream.alt ? { alt: stream.alt } : {}),
    ...(stream.language ? { language: stream.language } : {}),
    ...(stream.disposition ? { disposition: stream.disposition } : {}),
    ...(context.causationId?.trim()
      ? { causationId: context.causationId.trim() }
      : {}),
    ...(context.correlationId?.trim()
      ? { correlationId: context.correlationId.trim() }
      : {}),
    metadata: metadata as Readonly<Record<string, unknown>>,
  });
}

/** Strictly excludes event, routing, collection, and transport-only fields. */
export function isStreamOutputDescriptor(
  value: unknown,
): value is StreamOutputDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const allowed = new Set([
    "type",
    "namespace",
    "streamId",
    "mediaType",
    "kind",
    "role",
    "name",
    "alt",
    "language",
    "disposition",
    "causationId",
    "correlationId",
    "metadata",
  ]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => {
      const descriptor = descriptors[String(key)];
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  ) return false;
  const field = (key: string): unknown => descriptors[key]?.value;
  if (
    field("type") !== "stream.output" ||
    typeof field("namespace") !== "string" ||
    !(field("namespace") as string).trim() ||
    typeof field("streamId") !== "string" ||
    !(field("streamId") as string).trim() ||
    typeof field("mediaType") !== "string" ||
    !(field("mediaType") as string).trim() ||
    !["text", "json", "image", "audio", "video", "file"].includes(
      field("kind") as string,
    ) ||
    typeof field("role") !== "string" || !(field("role") as string).trim() ||
    !plainMetadata(field("metadata"))
  ) return false;
  return ["name", "alt", "language", "causationId", "correlationId"].every(
    (key) =>
      field(key) === undefined ||
      (typeof field(key) === "string" &&
        Boolean((field(key) as string).trim())),
  ) && (field("disposition") === undefined ||
    field("disposition") === "inline" ||
    field("disposition") === "attachment");
}
