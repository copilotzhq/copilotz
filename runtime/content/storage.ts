import {
  createFixedBodyStoreAdapter,
  createMemoryBodyStore,
  DEFAULT_MAX_DATABASE_ASSET_BYTES,
} from "./body-store.ts";
import type {
  BodyStorageOptions,
  BodyStorageRuntime,
  BodyStore,
  BodyStoreAdapter,
  BodyStoreDeployment,
} from "./body-store.ts";
import {
  createS3BodyStore,
  s3BodyStoreReadyGarbageCollection,
} from "./s3-body-store.ts";

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

function deploymentContract(
  input: BodyStoreDeployment,
): BodyStoreDeployment {
  if (
    (input.durability !== "ephemeral" && input.durability !== "durable") ||
    (input.reach !== "process" && input.reach !== "cluster") ||
    typeof input.readyGarbageCollection !== "boolean"
  ) {
    throw new TypeError("BodyStore deployment capability is invalid.");
  }
  return ({ ...input } as const);
}

function withoutReadyGarbageCollection(store: BodyStore): BodyStore {
  return ({
    ...store,
    maintenance: {
      ...store.maintenance,
      delete(input: Parameters<BodyStore["maintenance"]["delete"]>[0]) {
        return input.expectedState === "ready"
          ? Promise.resolve(false)
          : store.maintenance.delete(input);
      },
    } as const,
  } as const);
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
  let deployment: BodyStoreDeployment | undefined;
  let scopedAdapter: BodyStoreAdapter | undefined;
  if (config.type === "database") {
    maxDatabaseBytes = positiveInteger(
      config.config?.maxBytes,
      DEFAULT_MAX_DATABASE_ASSET_BYTES,
      "assets.storage.config.maxBytes",
    );
  } else if (config.type === "memory") {
    writer = createMemoryBodyStore({
      backendId: config.config?.backendId,
    });
    prefix = config.config?.prefix ?? "";
    deployment = {
      durability: "ephemeral",
      reach: "process",
      readyGarbageCollection: true,
    };
  } else if (config.type === "s3") {
    writer = createS3BodyStore(config.config);
    prefix = config.config.prefix ?? "";
    const readyGarbageCollection = s3BodyStoreReadyGarbageCollection(
      config.config,
    );
    deployment = {
      durability: "durable",
      reach: "cluster",
      readyGarbageCollection,
    };
  } else if (config.type === "custom") {
    writer = config.config.store;
    prefix = config.config.prefix ?? "";
    deployment = config.config.deployment ?? {
      durability: "ephemeral",
      reach: "process",
      readyGarbageCollection: false,
    };
    if (!deployment.readyGarbageCollection) {
      writer = withoutReadyGarbageCollection(writer);
    }
  } else {
    scopedAdapter = config.config.adapter;
    prefix = config.config.prefix ?? "";
    deploymentContract(scopedAdapter.deployment);
  }
  const adapter = scopedAdapter ??
    (writer && deployment
      ? createFixedBodyStoreAdapter(writer, deploymentContract(deployment))
      : undefined);
  const readers = new Map<string, BodyStore>();
  if (writer) readers.set(writer.backendId, writer);
  for (const reader of options.readers ?? []) {
    readers.set(reader.backendId, reader);
  }
  return ({
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
  } as const);
}
