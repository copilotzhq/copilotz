import type { CapabilitySelection } from "../resources/index.ts";

export type CapabilitySelectionMode = "none" | "explicit" | "all";

type SelectCapabilityResourcesOptions<T> = Readonly<{
  agentId: string;
  kind: string;
  selection?: CapabilitySelection;
  resources: readonly T[];
  id(resource: T): string;
}>;

function normalizedIds(
  values: readonly string[],
  agentId: string,
  kind: string,
): readonly string[] {
  const ids = values.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(
        `Agent '${agentId}' ${kind} grants must be non-empty strings.`,
      );
    }
    return value.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(
      `Agent '${agentId}' contains duplicate ${kind} grants.`,
    );
  }
  return Object.freeze(ids);
}

function unknown(agentId: string, kind: string, id: string): Error {
  return new Error(`Agent '${agentId}' grants unknown ${kind} '${id}'.`);
}

function isExplicitSelection(
  selection: CapabilitySelection,
): selection is readonly string[] {
  return Array.isArray(selection);
}

export function capabilitySelectionMode(
  selection: CapabilitySelection | undefined,
): CapabilitySelectionMode {
  if (selection === undefined) return "none";
  return isExplicitSelection(selection) ? "explicit" : "all";
}

/** Resolves one least-authority grant while preserving declared resource order. */
export function selectCapabilityResources<T>(
  options: SelectCapabilityResourcesOptions<T>,
): readonly T[] {
  const selection = options.selection;
  if (selection === undefined) return Object.freeze([]);

  const entries = options.resources.map((resource) => {
    const id = options.id(resource).trim();
    if (!id) {
      throw new TypeError(`Available ${options.kind} resources require an ID.`);
    }
    return [id, resource] as const;
  });
  const byId = new Map(entries);
  if (byId.size !== entries.length) {
    throw new TypeError(
      `Available ${options.kind} resource IDs must be unique.`,
    );
  }

  if (isExplicitSelection(selection)) {
    const ids = normalizedIds(
      selection,
      options.agentId,
      options.kind,
    );
    return Object.freeze(ids.map((id) => {
      const resource = byId.get(id);
      if (!resource) throw unknown(options.agentId, options.kind, id);
      return resource;
    }));
  }

  if (selection.all !== true) {
    throw new TypeError(
      `Agent '${options.agentId}' ${options.kind} selection must use { all: true }.`,
    );
  }
  const except = normalizedIds(
    selection.except ?? [],
    options.agentId,
    options.kind,
  );
  for (const id of except) {
    if (!byId.has(id)) throw unknown(options.agentId, options.kind, id);
  }
  const excluded = new Set(except);
  return Object.freeze(
    entries.filter(([id]) => !excluded.has(id)).map(([, resource]) => resource),
  );
}
