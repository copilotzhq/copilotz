import type { MemoryResource, RagConfig } from "@/types/index.ts";

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
