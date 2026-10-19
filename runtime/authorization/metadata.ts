/** Lossless operation ownership constraints, shared by owner command consumers. */
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { sameValue } from "../collections/equal.ts";
import type { ServerConstraints } from "./contracts.ts";

type OperationConstraints = NonNullable<ServerConstraints["operations"]>;

export function captureOperationConstraints(
  value: OperationConstraints,
): OperationConstraints {
  // Undefined must not silently disappear at a JSON boundary. A policy must
  // declare absentMetadata explicitly, including during its one-time migration.
  const captured = captureHostCommandJson(value) as OperationConstraints;
  if (
    !captured || typeof captured !== "object" || Array.isArray(captured) ||
    Object.keys(captured).some((key) =>
      key !== "metadata" && key !== "absentMetadata"
    ) ||
    !captured.metadata || typeof captured.metadata !== "object" ||
    Array.isArray(captured.metadata)
  ) throw new TypeError("Invalid operation metadata constraints.");
  const absent = captured.absentMetadata ?? [];
  if (
    !Array.isArray(absent) || new Set(absent).size !== absent.length ||
    absent.some((key) =>
      typeof key !== "string" || !key || Object.hasOwn(captured.metadata, key)
    )
  ) throw new TypeError("Invalid required-absent metadata keys.");
  return captured;
}

export function matchesOperationConstraints(
  candidate: unknown,
  constraints: OperationConstraints,
): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const metadata = candidate as Record<string, unknown>;
  return Object.entries(constraints.metadata).every(([key, value]) =>
    Object.hasOwn(metadata, key) && sameValue(metadata[key], value)
  ) && (constraints.absentMetadata ?? []).every((key) =>
    !Object.hasOwn(metadata, key)
  );
}
