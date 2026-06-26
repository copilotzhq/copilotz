/**
 * Usage attribution helpers: resolve who initiated or generated metered work.
 *
 * The unified usage ledger stores flat `initiatedById` / `agentId` for cheap
 * admin aggregation. These helpers centralize resolution from run metadata
 * and thread identity.
 */

import { getUserExternalId } from "@/runtime/memory/identity.ts";

/** Resolve a participant external id from a run sender envelope. */
export function runSenderExternalId(
  sender?: Record<string, unknown> | null,
): string | null {
  const candidates = [
    sender?.externalId,
    sender?.id,
    sender?.email,
    sender?.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

/** Extract a run sender object from queue / event metadata. */
export function pickRunSenderFromMetadata(
  metadata: unknown,
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const runSender = (metadata as Record<string, unknown>).runSender;
  if (!runSender || typeof runSender !== "object" || Array.isArray(runSender)) {
    return undefined;
  }
  return runSender as Record<string, unknown>;
}

/** Merge optional fields into metadata while preserving an existing runSender. */
export function withRunSenderMetadata(
  metadata: Record<string, unknown> | null | undefined,
  runSender: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const base = metadata && typeof metadata === "object" ? { ...metadata } : {};
  if (runSender) {
    base.runSender = runSender;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

export interface ResolveInitiatedByIdInput {
  initiatedById?: string | null;
  runSender?: Record<string, unknown> | null;
  threadMetadata?: unknown;
}

/**
 * Resolve the initiating participant external id for a usage ledger row.
 *
 * Priority: explicit `initiatedById` → run sender → thread memory identity.
 */
export function resolveInitiatedById(
  input: ResolveInitiatedByIdInput,
): string | null {
  const explicit = typeof input.initiatedById === "string" &&
      input.initiatedById.trim().length > 0
    ? input.initiatedById.trim()
    : null;
  if (explicit) return explicit;

  const fromSender = runSenderExternalId(input.runSender);
  if (fromSender) return fromSender;

  const fromThread = getUserExternalId(input.threadMetadata);
  return fromThread ?? null;
}

/** Legacy and current participant→usage edge types for admin compatibility. */
export const USAGE_INITIATOR_EDGE_TYPES = [
  "initiated_usage",
  "initiated_llm_usage",
] as const;

/** Legacy and current agent→usage edge types for admin compatibility. */
export const USAGE_GENERATOR_EDGE_TYPES = [
  "generated_usage",
  "used_llm",
] as const;
