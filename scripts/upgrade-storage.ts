import { resolve, toFileUrl } from "@std/path";
import type { RetainedDataUpgradeStorage } from "../runtime/actions/upgrade.ts";

/** Operator modules are executable code; validate their exported configuration. */
export async function loadUpgradeStorage(
  path: string,
): Promise<RetainedDataUpgradeStorage> {
  const value = (await import(toFileUrl(resolve(path)).href)).default;
  const record = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (
    !record(value) ||
    Object.keys(value).some((key) =>
      !["storeFor", "streamBackend", "copyMappings", "concurrency"].includes(
        key,
      )
    ) ||
    (value.storeFor !== undefined && typeof value.storeFor !== "function") ||
    (value.streamBackend !== undefined && (!record(value.streamBackend) ||
      !text(value.streamBackend.kind) ||
      !text(value.streamBackend.backendId))) ||
    (value.concurrency !== undefined &&
      (!Number.isSafeInteger(value.concurrency) ||
        Number(value.concurrency) < 1 || Number(value.concurrency) > 256)) ||
    (value.copyMappings !== undefined && (!Array.isArray(value.copyMappings) ||
      value.copyMappings.some((m) =>
        !record(m) ||
        ![m.namespace, m.backendId, m.sourceBodyId, m.targetBodyId].every(text)
      )))
  ) {
    throw new TypeError(
      "--storage module must default-export RetainedDataUpgradeStorage (storeFor, streamBackend, copyMappings, concurrency).",
    );
  }
  return value as RetainedDataUpgradeStorage;
}
