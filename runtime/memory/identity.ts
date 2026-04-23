import type { ChatContext } from "@/types/index.ts";
import {
  getMemoryThreadMetadata,
  setMemoryThreadMetadata,
  type StructuredThreadMetadata,
} from "@/runtime/thread-metadata.ts";

export function getUserExternalId(raw: unknown): string | undefined {
  const identity = getMemoryThreadMetadata(raw).identity;
  return typeof identity?.userExternalId === "string"
    ? identity.userExternalId
    : undefined;
}

export function setUserExternalId(
  raw: unknown,
  userExternalId: string,
): StructuredThreadMetadata {
  return setMemoryThreadMetadata(raw, {
    identity: {
      userExternalId,
    },
  });
}

export function resolveParticipantCollection(
  context: ChatContext,
): Record<string, unknown> | undefined {
  const collections = context.collections as
    | { withNamespace?: (namespace: string) => Record<string, unknown> }
    | Record<string, unknown>
    | undefined;

  if (!collections) return undefined;
  if (typeof collections.withNamespace === "function") {
    return collections.withNamespace(context.namespace ?? "global")
      ?.participant as Record<string, unknown> | undefined;
  }
  return (collections as Record<string, unknown>).participant as
    | Record<string, unknown>
    | undefined;
}
