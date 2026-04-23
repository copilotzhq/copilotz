const LEGACY_RUNTIME_KEYS = new Set([
  "participantTargets",
  "agentTurnCount",
  "maxAgentTurns",
  "pendingToolBatches",
]);

const LEGACY_MEMORY_KEYS = new Set([
  "userExternalId",
]);

export interface RuntimeThreadMetadata {
  participantTargets?: Record<string, string>;
  agentTurnCount?: number;
  maxAgentTurns?: number;
  pendingToolBatches?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MemoryThreadMetadata {
  identity?: {
    userExternalId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SystemThreadMetadata {
  runtime?: RuntimeThreadMetadata;
  memory?: MemoryThreadMetadata;
  channels?: Record<string, Record<string, unknown>>;
  routing?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StructuredThreadMetadata {
  public?: Record<string, unknown>;
  system?: SystemThreadMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function removeUndefinedKeys<T extends Record<string, unknown>>(value: T): T {
  const cleaned = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
  return cleaned as T;
}

function mergeRecord(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export function normalizeThreadMetadata(
  raw: unknown,
): StructuredThreadMetadata {
  if (!isRecord(raw)) {
    return {
      public: {},
      system: { runtime: {}, memory: {}, channels: {}, routing: {} },
    };
  }

  const topLevel = { ...raw };
  const publicMetadata = cloneRecord(topLevel.public);
  const systemMetadata = cloneRecord(topLevel.system);
  const runtimeMetadata = cloneRecord(systemMetadata.runtime);
  const memoryMetadata = cloneRecord(systemMetadata.memory);
  const memoryIdentity = cloneRecord(memoryMetadata.identity);
  const channelMetadata = cloneRecord(systemMetadata.channels);
  const routingMetadata = cloneRecord(systemMetadata.routing);

  for (const [key, value] of Object.entries(topLevel)) {
    if (key === "public" || key === "system") continue;
    if (LEGACY_RUNTIME_KEYS.has(key)) {
      runtimeMetadata[key] = value;
      continue;
    }
    if (LEGACY_MEMORY_KEYS.has(key)) {
      memoryIdentity[key] = value;
      continue;
    }
    publicMetadata[key] = value;
  }

  const legacyRuntimeUserExternalId = runtimeMetadata.userExternalId;
  if (
    typeof legacyRuntimeUserExternalId === "string" &&
    typeof memoryIdentity.userExternalId !== "string"
  ) {
    memoryIdentity.userExternalId = legacyRuntimeUserExternalId;
  }
  delete runtimeMetadata.userExternalId;

  const normalizedChannels = Object.fromEntries(
    Object.entries(channelMetadata).map(([channel, value]) => [
      channel,
      cloneRecord(value),
    ]),
  );

  return {
    public: removeUndefinedKeys(publicMetadata),
    system: removeUndefinedKeys({
      ...Object.fromEntries(
        Object.entries(systemMetadata).filter(([key]) =>
          key !== "runtime" && key !== "memory" && key !== "channels" &&
          key !== "routing"
        ),
      ),
      runtime: removeUndefinedKeys(runtimeMetadata),
      memory: removeUndefinedKeys({
        ...memoryMetadata,
        identity: removeUndefinedKeys(memoryIdentity),
      }),
      channels: removeUndefinedKeys(normalizedChannels),
      routing: removeUndefinedKeys(routingMetadata),
    }),
  };
}

export function mergeThreadMetadata(
  base: unknown,
  patch: unknown,
): StructuredThreadMetadata {
  const normalizedBase = normalizeThreadMetadata(base);
  const normalizedPatch = normalizeThreadMetadata(patch);
  const mergedSystem = {
    ...cloneRecord(normalizedBase.system),
    ...cloneRecord(normalizedPatch.system),
    runtime: mergeRecord(
      cloneRecord(normalizedBase.system?.runtime),
      cloneRecord(normalizedPatch.system?.runtime),
    ),
    memory: (() => {
      const baseMemory = cloneRecord(normalizedBase.system?.memory);
      const patchMemory = cloneRecord(normalizedPatch.system?.memory);
      return removeUndefinedKeys({
        ...mergeRecord(baseMemory, patchMemory),
        identity: mergeRecord(
          cloneRecord(baseMemory.identity),
          cloneRecord(patchMemory.identity),
        ),
      });
    })(),
    channels: (() => {
      const baseChannels = cloneRecord(normalizedBase.system?.channels);
      const patchChannels = cloneRecord(normalizedPatch.system?.channels);
      const mergedChannels: Record<string, Record<string, unknown>> = {};
      const names = new Set([
        ...Object.keys(baseChannels),
        ...Object.keys(patchChannels),
      ]);
      for (const name of names) {
        mergedChannels[name] = mergeRecord(
          cloneRecord(baseChannels[name]),
          cloneRecord(patchChannels[name]),
        );
      }
      return removeUndefinedKeys(mergedChannels);
    })(),
    routing: mergeRecord(
      cloneRecord(normalizedBase.system?.routing),
      cloneRecord(normalizedPatch.system?.routing),
    ),
  };

  return {
    public: mergeRecord(
      cloneRecord(normalizedBase.public),
      cloneRecord(normalizedPatch.public),
    ),
    system: removeUndefinedKeys(mergedSystem),
  };
}

export function getPublicThreadMetadata(
  raw: unknown,
): Record<string, unknown> {
  return cloneRecord(normalizeThreadMetadata(raw).public);
}

export function getRuntimeThreadMetadata(
  raw: unknown,
): RuntimeThreadMetadata {
  return cloneRecord(normalizeThreadMetadata(raw).system?.runtime) as RuntimeThreadMetadata;
}

export function getMemoryThreadMetadata(
  raw: unknown,
): MemoryThreadMetadata {
  return cloneRecord(normalizeThreadMetadata(raw).system?.memory) as MemoryThreadMetadata;
}

export function setRuntimeThreadMetadata(
  raw: unknown,
  patch: Partial<RuntimeThreadMetadata>,
): StructuredThreadMetadata {
  const normalized = normalizeThreadMetadata(raw);
  return mergeThreadMetadata(normalized, {
    system: {
      runtime: patch,
    },
  });
}

export function setMemoryThreadMetadata(
  raw: unknown,
  patch: Partial<MemoryThreadMetadata>,
): StructuredThreadMetadata {
  const normalized = normalizeThreadMetadata(raw);
  return mergeThreadMetadata(normalized, {
    system: {
      memory: patch,
    },
  });
}

export function getChannelContext(
  raw: unknown,
  channel: string,
): Record<string, unknown> | undefined {
  const channels = cloneRecord(normalizeThreadMetadata(raw).system?.channels);
  const context = channels[channel];
  return isRecord(context) ? { ...context } : undefined;
}

export function setChannelContext(
  raw: unknown,
  channel: string,
  patch: Record<string, unknown>,
): StructuredThreadMetadata {
  return mergeThreadMetadata(raw, {
    system: {
      channels: {
        [channel]: patch,
      },
    },
  });
}

export function getSerializableThreadMetadata(
  raw: unknown,
): Record<string, unknown> | null {
  const normalized = normalizeThreadMetadata(raw);
  const hasPublic = Object.keys(normalized.public ?? {}).length > 0;
  const hasRuntime = Object.keys(normalized.system?.runtime ?? {}).length > 0;
  const hasMemory = Object.keys(normalized.system?.memory ?? {}).length > 0;
  const hasChannels = Object.keys(normalized.system?.channels ?? {}).length > 0;
  const hasRouting = Object.keys(normalized.system?.routing ?? {}).length > 0;
  const hasOtherSystemKeys = Object.keys(
    removeUndefinedKeys({
      ...cloneRecord(normalized.system),
      runtime: undefined,
      memory: undefined,
      channels: undefined,
      routing: undefined,
    }),
  ).length > 0;

  if (!hasPublic && !hasRuntime && !hasMemory && !hasChannels && !hasRouting &&
    !hasOtherSystemKeys) {
    return null;
  }

  return removeUndefinedKeys({
    public: hasPublic ? normalized.public : undefined,
    system: hasRuntime || hasMemory || hasChannels || hasRouting ||
        hasOtherSystemKeys
      ? removeUndefinedKeys(normalized.system ?? {})
      : undefined,
  });
}
