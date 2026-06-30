import type { MemoryResource, RagConfig } from "@/types/index.ts";

export interface LongTermMemoryConfig {
  triggerEstimatedTokens: number;
  retainRecentEstimatedTokens: number;
  maxContentEstimatedTokens: number;
  retrievalLimit: number;
}

export const DEFAULT_LONG_TERM_MEMORY_CONFIG: LongTermMemoryConfig = {
  triggerEstimatedTokens: 20_000,
  retainRecentEstimatedTokens: 0,
  maxContentEstimatedTokens: 12_000,
  retrievalLimit: 20,
};

function normalizeName(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function getEnabledMemoryResources(
  resources?: MemoryResource[] | null,
): MemoryResource[] {
  return Array.isArray(resources)
    ? resources.filter((resource) => resource?.enabled !== false)
    : [];
}

export function hasMemoryResource(
  resources: MemoryResource[] | null | undefined,
  nameOrKind: string,
): boolean {
  const normalized = normalizeName(nameOrKind);
  if (!normalized) return false;

  const enabled = getEnabledMemoryResources(resources);
  if (enabled.length === 0) return false;

  return enabled.some((resource) =>
    normalizeName(resource.name) === normalized ||
    normalizeName(resource.kind) === normalized
  );
}

export function isParticipantMemoryEnabled(
  resources?: MemoryResource[] | null,
): boolean {
  const enabled = getEnabledMemoryResources(resources);
  if (enabled.length === 0) return true;
  return hasMemoryResource(enabled, "participant");
}

export function isHistoryMemoryEnabled(
  resources?: MemoryResource[] | null,
): boolean {
  const enabled = getEnabledMemoryResources(resources);
  if (enabled.length === 0) return true;
  return hasMemoryResource(enabled, "history");
}

export function isRetrievalMemoryEnabled(
  resources?: MemoryResource[] | null,
  ragConfig?: RagConfig | null,
): boolean {
  if (hasMemoryResource(resources, "retrieval")) return true;
  return Boolean(ragConfig);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

export function getLongTermMemoryConfig(
  resources?: MemoryResource[] | null,
): LongTermMemoryConfig | null {
  const resource = getEnabledMemoryResources(resources).find((candidate) =>
    normalizeName(candidate.name) === "long_term" ||
    normalizeName(candidate.kind) === "long_term"
  );
  if (!resource) return null;
  const config = resource.config ?? {};
  return {
    triggerEstimatedTokens: positiveInteger(
      config.triggerEstimatedTokens,
      DEFAULT_LONG_TERM_MEMORY_CONFIG.triggerEstimatedTokens,
    ),
    retainRecentEstimatedTokens: nonNegativeInteger(
      config.retainRecentEstimatedTokens,
      DEFAULT_LONG_TERM_MEMORY_CONFIG.retainRecentEstimatedTokens,
    ),
    maxContentEstimatedTokens: positiveInteger(
      config.maxContentEstimatedTokens,
      DEFAULT_LONG_TERM_MEMORY_CONFIG.maxContentEstimatedTokens,
    ),
    retrievalLimit: positiveInteger(
      config.retrievalLimit,
      DEFAULT_LONG_TERM_MEMORY_CONFIG.retrievalLimit,
    ),
  };
}
