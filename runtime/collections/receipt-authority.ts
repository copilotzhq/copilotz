import { captureHostCommandJson } from "../application/host-command-json.ts";
import { decodeCapability } from "../execution/owner-capability-wire.ts";
import type { CollectionDefinition } from "./definition.ts";
import type { CollectionPolicyRegistrations } from "../authorization/resources.ts";

/** A parentless recovery has no live original invocation to reauthorize. */
export function canRecoverCollectionReceipt(
  intent: unknown,
  definitions: Readonly<Record<string, CollectionDefinition>>,
  policies: CollectionPolicyRegistrations,
): boolean {
  if (!policies.size) return true;
  try {
    const decoded = decodeCapability(
      new TextEncoder().encode(JSON.stringify(captureHostCommandJson(intent))),
    ) as {
      plan?: readonly { path: readonly string[]; args: readonly unknown[] }[];
    };
    if (!Array.isArray(decoded.plan)) return false;
    const unprotected = (name: unknown) =>
      typeof name === "string" &&
      Object.values(definitions).some((definition) =>
        definition.name === name
      ) && !policies.has(name);
    return decoded.plan.every((operation) => {
      const path = operation.path;
      if (!Array.isArray(path) || !Array.isArray(operation.args)) return false;
      if (path[0] === "collections") {
        return Object.hasOwn(definitions, path[1]) &&
          unprotected(definitions[path[1]].name);
      }
      const input = operation.args[0] as {
        owner?: { type?: unknown };
        source?: { type?: unknown };
        target?: { type?: unknown };
      } | undefined;
      if (path[0] === "vectors") return unprotected(input?.owner?.type);
      if (path[0] === "relations") {
        return unprotected(input?.source?.type) &&
          unprotected(input?.target?.type);
      }
      return false;
    });
  } catch {
    return false;
  }
}
