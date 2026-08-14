import {
  createFilesystemAssetBodyStore,
  createMemoryAssetBodyStore,
  DEFAULT_MAX_DATABASE_ASSET_BYTES,
} from "./body-store.ts";
import type {
  AssetBodyStore,
  AssetStorageOptions,
  AssetStorageRuntime,
} from "./body-store.ts";
import { createS3AssetBodyStore } from "./s3-body-store.ts";

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
export function createAssetStorageRuntime(
  options: AssetStorageOptions = {},
): AssetStorageRuntime {
  const config = options.storage ?? {
    type: "database" as const,
    config: { maxBytes: DEFAULT_MAX_DATABASE_ASSET_BYTES },
  };
  let writer: AssetBodyStore | undefined;
  let prefix = "";
  let maxDatabaseBytes = DEFAULT_MAX_DATABASE_ASSET_BYTES;
  if (config.type === "database") {
    maxDatabaseBytes = positiveInteger(
      config.config?.maxBytes,
      DEFAULT_MAX_DATABASE_ASSET_BYTES,
      "assets.storage.config.maxBytes",
    );
  } else if (config.type === "memory") {
    writer = createMemoryAssetBodyStore({
      backendId: config.config?.backendId,
    });
    prefix = config.config?.prefix ?? "";
  } else if (config.type === "filesystem") {
    writer = createFilesystemAssetBodyStore(config.config);
    prefix = config.config.prefix ?? "";
  } else if (config.type === "s3") {
    writer = createS3AssetBodyStore(config.config);
    prefix = config.config.prefix ?? "";
  } else {
    writer = config.config.store;
    prefix = config.config.prefix ?? "";
  }
  const readers = new Map<string, AssetBodyStore>();
  if (writer) readers.set(writer.backendId, writer);
  for (const reader of options.readers ?? []) {
    readers.set(reader.backendId, reader);
  }
  return Object.freeze({
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
