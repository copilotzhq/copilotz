import type { InternalCopilotzApplication as CopilotzApplication } from "../runtime/application/types.ts";
import type { ConversationMessage } from "@copilotz/copilotz/core";
import type { ContentRef } from "../runtime/content/index.ts";
import { type EventNativeAsset, eventNativeAsset } from "./assets.ts";

export type EventNativeHistoryInclude = "content";

/** JSON transport representation of canonical resolved content. */
export type EventNativeResolvedContent = Readonly<{
  ref: ContentRef;
  asset: EventNativeAsset;
  base64: string;
}>;

/** Canonical immutable content bodies referenced by one message page. */
export type EventNativeMessageHistoryIncluded = Readonly<{
  content: readonly EventNativeResolvedContent[];
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueRefs(refs: readonly ContentRef[]): ContentRef[] {
  const values = new Map<string, ContentRef>();
  for (const ref of refs) {
    const key = JSON.stringify([
      ref.assetId,
      ref.kind,
      ref.role,
      ref.mediaType,
      ref.name ?? null,
      ref.disposition ?? null,
    ]);
    if (!values.has(key)) values.set(key, ref);
  }
  return [...values.values()];
}

function metadataContent(message: ConversationMessage): readonly ContentRef[] {
  const reasoning = record(message.metadata).llmReasoning;
  return Array.isArray(reasoning) ? reasoning as ContentRef[] : [];
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Resolves immutable content referenced by the canonical message projection. */
export async function createEventNativeMessageHistoryIncluded(
  application: CopilotzApplication,
  namespace: string,
  messages: readonly ConversationMessage[],
  includes: ReadonlySet<EventNativeHistoryInclude>,
): Promise<EventNativeMessageHistoryIncluded | undefined> {
  if (!includes.has("content")) return undefined;
  const refs = uniqueRefs(messages.flatMap((message) => [
    ...message.content,
    ...metadataContent(message),
  ]));
  const resolved = refs.length
    ? await application.content.resolver.getMany(refs, { namespace })
    : [];
  return Object.freeze({
    content: Object.freeze(resolved.map((value) =>
      Object.freeze({
        ref: value.ref,
        asset: eventNativeAsset(value.asset),
        base64: base64(value.bytes),
      })
    )),
  });
}
