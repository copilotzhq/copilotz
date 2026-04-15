import { resolve } from "node:path";

export interface AgentsFileConfig {
  enabled?: boolean;
  fileName?: string;
}

export interface AgentsFileInstructions {
  path: string;
  cwd: string;
  content: string;
  fileName: string;
  mtimeMs: number | null;
}

type CachedEntry = {
  mtimeMs: number | null;
  content: string;
  path: string;
  cwd: string;
  fileName: string;
} | null;

type DenoLike = {
  cwd?: () => string;
  stat?: (path: string) => Promise<{ mtime?: Date | null }>;
  readTextFile?: (path: string) => Promise<string>;
  errors?: {
    NotFound?: { new (...args: unknown[]): Error };
  };
};

const GLOBAL_CACHE_KEY = "__copilotz_agents_file_cache__";

function getDeno(): DenoLike {
  const denoNs = (globalThis as unknown as { Deno?: DenoLike }).Deno;
  if (!denoNs?.cwd || !denoNs?.stat || !denoNs?.readTextFile) {
    return {};
  }
  return denoNs;
}

function getCache(): Map<string, CachedEntry> {
  const globalRecord = globalThis as Record<string, unknown>;
  const existing = globalRecord[GLOBAL_CACHE_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, CachedEntry>;
  }
  const created = new Map<string, CachedEntry>();
  globalRecord[GLOBAL_CACHE_KEY] = created;
  return created;
}

function toMtimeMs(date: Date | null | undefined): number | null {
  return date instanceof Date ? date.getTime() : null;
}

export async function loadAgentsFileInstructions(
  config: AgentsFileConfig | boolean | undefined,
): Promise<AgentsFileInstructions | null> {
  const normalizedConfig: AgentsFileConfig = typeof config === "boolean"
    ? { enabled: config }
    : (config ?? {});
  const enabled = normalizedConfig.enabled ?? true;
  if (!enabled) return null;

  const denoNs = getDeno();
  if (!denoNs.cwd || !denoNs.stat || !denoNs.readTextFile) {
    return null;
  }
  const cwd = denoNs.cwd!();
  const fileName = normalizedConfig.fileName ?? "AGENTS.md";
  const path = resolve(cwd, fileName);
  const cacheKey = `${cwd}:${fileName}`;

  let stat: { mtime?: Date | null };
  try {
    stat = await denoNs.stat!(path);
  } catch (error) {
    const notFound = denoNs.errors?.NotFound;
    if (notFound && error instanceof notFound) {
      getCache().set(cacheKey, null);
      return null;
    }
    throw error;
  }

  const mtimeMs = toMtimeMs(stat.mtime);
  const cached = getCache().get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs) {
    return {
      path: cached.path,
      cwd: cached.cwd,
      content: cached.content,
      fileName: cached.fileName,
      mtimeMs: cached.mtimeMs,
    };
  }

  const content = await denoNs.readTextFile!(path);
  const next: CachedEntry = {
    path,
    cwd,
    content,
    fileName,
    mtimeMs,
  };
  getCache().set(cacheKey, next);

  return {
    path,
    cwd,
    content,
    fileName,
    mtimeMs,
  };
}
