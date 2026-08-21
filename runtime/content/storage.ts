import {
  bodyProtectionMs,
  createFilesystemBodyStore,
  createFixedBodyStoreAdapter,
  createMemoryBodyStore,
  DEFAULT_BODY_PROTECTION_MS,
  DEFAULT_MAX_DATABASE_ASSET_BYTES,
} from "./body-store.ts";
import type {
  BodyStorageOptions,
  BodyStorageRuntime,
  BodyStore,
  BodyStoreDeployment,
} from "./body-store.ts";
import { createS3BodyStore } from "./s3-body-store.ts";

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return resolved;
}

/** Compiles declarative application configuration into body-store capabilities. */
export function createBodyStorageRuntime(
  options: BodyStorageOptions = {},
): BodyStorageRuntime {
  const config = options.storage ?? {
    type: "database" as const,
    config: { maxBytes: DEFAULT_MAX_DATABASE_ASSET_BYTES },
  };
  let writer: BodyStore | undefined;
  let prefix = "";
  let maxDatabaseBytes = DEFAULT_MAX_DATABASE_ASSET_BYTES;
  let deploymentProtectionMs = DEFAULT_BODY_PROTECTION_MS;
  if (config.type === "database") {
    maxDatabaseBytes = positiveInteger(
      config.config?.maxBytes,
      DEFAULT_MAX_DATABASE_ASSET_BYTES,
      "assets.storage.config.maxBytes",
    );
    deploymentProtectionMs = bodyProtectionMs(config.config?.protectionMs);
  } else if (config.type === "memory") {
    deploymentProtectionMs = bodyProtectionMs(config.config?.protectionMs);
    writer = createMemoryBodyStore({
      backendId: config.config?.backendId,
      protectionMs: config.config?.protectionMs,
    });
    prefix = config.config?.prefix ?? "";
  } else if (config.type === "filesystem") {
    deploymentProtectionMs = bodyProtectionMs(config.config.protectionMs);
    writer = createFilesystemBodyStore(config.config);
    prefix = config.config.prefix ?? "";
  } else if (config.type === "s3") {
    deploymentProtectionMs = bodyProtectionMs(config.config.protectionMs);
    writer = createS3BodyStore(config.config);
    prefix = config.config.prefix ?? "";
  } else {
    writer = config.config.store;
    prefix = config.config.prefix ?? "";
  }
  const deployment: BodyStoreDeployment | undefined = writer
    ? writer.kind === "memory"
      ? {
        durability: "ephemeral",
        reach: "process",
        minimumProtectionMs: deploymentProtectionMs,
      }
      : writer.kind === "filesystem"
      ? {
        durability: "durable",
        reach: "process",
        minimumProtectionMs: deploymentProtectionMs,
      }
      : writer.kind === "database" || writer.kind === "object"
      ? {
        durability: "durable",
        reach: "cluster",
        minimumProtectionMs: deploymentProtectionMs,
      }
      : undefined
    : undefined;
  const adapter = writer && deployment
    ? createFixedBodyStoreAdapter(writer, deployment)
    : undefined;
  const readers = new Map<string, BodyStore>();
  if (writer) readers.set(writer.backendId, writer);
  for (const reader of options.readers ?? []) {
    readers.set(reader.backendId, reader);
  }
  return Object.freeze({
    ...(adapter ? { adapter } : {}),
    ...(writer ? { writer } : {}),
    readers,
    prefix,
    maxDatabaseBytes,
    readConcurrency: positiveInteger(
      options.readConcurrency,
      8,
      "assets.readConcurrency",
    ),
  });
}
