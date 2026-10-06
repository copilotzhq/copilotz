/** Optional host filesystem access and standard HTTP reads. No host imports. @module */
import type { SkillFile, SkillReadOptions } from "./contracts.ts";
import {
  normalizeSkillPath,
  skillFileMediaType,
} from "../resources/skill/index.ts";

type FileHandle = {
  stat(): Promise<{ size: number; isFile(): boolean }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};
type FileSystem = {
  constants: { O_RDONLY: number; O_NOFOLLOW?: number };
  promises: {
    realpath(path: string): Promise<string>;
    lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
    open(path: string, flags: number): Promise<FileHandle>;
  };
};
type PathApi = {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
};
type Host = {
  process?: { getBuiltinModule?(name: string): unknown; cwd?(): string };
};

export type SkillRootInput = Readonly<
  { root: string | URL; fetch?: typeof fetch }
>;

export function validateRoot(root: string | URL): string {
  const value = root instanceof URL ? root.href : root;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Skill root must be a non-empty path or URL.");
  }
  // Windows drive paths are paths, not URL schemes.
  if (
    /^[a-zA-Z]:[\\/]/.test(value) || !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
  ) return value;
  const url = new URL(value);
  if (!["http:", "https:", "file:"].includes(url.protocol)) {
    throw new TypeError(
      "Skill roots support filesystem paths, file: URLs, and HTTP(S) URLs.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      "Skill root URLs cannot contain credentials, queries, or fragments; configure fetch for authenticated reads.",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function inside(root: URL, target: URL): boolean {
  return target.origin === root.origin &&
    target.pathname.startsWith(root.pathname) && !target.username &&
    !target.password;
}

async function httpRead(
  root: URL,
  path: string,
  fetcher: typeof fetch,
  options: SkillReadOptions,
): Promise<SkillFile> {
  let target = new URL(path.split("/").map(encodeURIComponent).join("/"), root);
  for (let redirects = 0; redirects <= 5; redirects++) {
    options.signal?.throwIfAborted();
    if (!inside(root, target)) {
      throw new TypeError(
        "Skill redirects must remain inside the declared root.",
      );
    }
    const response = await fetcher(target, {
      signal: options.signal,
      redirect: "manual",
    });
    if (response.type === "opaqueredirect") {
      throw new Error(
        "Skill redirects cannot be inspected in this runtime; use a direct file URL.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Skill redirect has no readable location.");
      }
      target = new URL(location, target);
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Skill file '${path}' could not be read (HTTP ${response.status}).`,
      );
    }
    if (response.url && !inside(root, new URL(response.url))) {
      void response.body?.cancel().catch(() => undefined);
      throw new TypeError(
        "Skill response must remain inside the declared root.",
      );
    }
    return {
      path,
      mediaType: skillFileMediaType(path),
      body: response.body ?? new Uint8Array(),
    };
  }
  throw new Error("Skill file exceeded the redirect limit.");
}

/** Pins relative filesystem roots per application scope on first access. */
export function rootReader(
  input: SkillRootInput,
): (path: string, options?: SkillReadOptions) => Promise<SkillFile> {
  const root = validateRoot(input.root);
  const pinnedRoots = new WeakMap<object, string>();
  const directScope = {};
  return async (requested, options = {}) => {
    options.signal?.throwIfAborted();
    const path = normalizeSkillPath(requested);
    if (/^https?:/.test(root)) {
      return await httpRead(new URL(root), path, input.fetch ?? fetch, options);
    }
    const host = (globalThis as typeof globalThis & Host).process;
    const fs = host?.getBuiltinModule?.("fs") as FileSystem | undefined;
    const paths = host?.getBuiltinModule?.("path") as PathApi | undefined;
    const urls = host?.getBuiltinModule?.("url") as {
      fileURLToPath(url: URL): string;
    } | undefined;
    if (!fs?.promises?.open || !paths || !urls) {
      throw new Error(
        "This runtime does not provide filesystem skill reads; use an HTTP(S) root.",
      );
    }
    const scope = options.scope ?? directScope;
    let absoluteRoot = pinnedRoots.get(scope);
    if (!absoluteRoot) {
      absoluteRoot = root.startsWith("file:")
        ? urls.fileURLToPath(new URL(root))
        : paths.resolve(root);
      absoluteRoot = await fs.promises.realpath(absoluteRoot);
      pinnedRoots.set(scope, absoluteRoot);
    }
    const target = paths.resolve(absoluteRoot, ...path.split("/"));
    const contained = (candidate: string) => {
      const relative = paths.relative(absoluteRoot!, candidate);
      return relative !== ".." && !relative.startsWith(`..${paths.sep}`) &&
        !paths.isAbsolute(relative);
    };
    if (!contained(target)) {
      throw new TypeError("Skill file must remain inside the declared root.");
    }
    let component = absoluteRoot;
    for (const part of path.split("/")) {
      component = paths.resolve(component, part);
      if ((await fs.promises.lstat(component)).isSymbolicLink()) {
        throw new TypeError("Skill files cannot traverse symlinks.");
      }
    }
    if (!contained(await fs.promises.realpath(target))) {
      throw new TypeError("Skill file must remain inside the declared root.");
    }
    options.signal?.throwIfAborted();
    const file = await fs.promises.open(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new TypeError("Skill resources must be regular files.");
      }
      const maximum = 1_000_000;
      if (stat.size > maximum) {
        throw new RangeError(`Skill file '${path}' exceeds the text limit.`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        options.signal?.throwIfAborted();
        const buffer = new Uint8Array(Math.min(65_536, maximum + 1 - size));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > maximum) {
          throw new RangeError(`Skill file '${path}' exceeds the text limit.`);
        }
        chunks.push(buffer.subarray(0, bytesRead));
      }
      options.signal?.throwIfAborted();
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      return { path, mediaType: skillFileMediaType(path), body };
    } finally {
      await file.close();
    }
  };
}
