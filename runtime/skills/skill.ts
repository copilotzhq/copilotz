import type {
  Skill,
  SkillFile,
  SkillFileBody,
  SkillFileDescriptor,
  SkillManifest,
  SkillReadOptions,
} from "../resources/index.ts";
import { parseSkillMarkdown, validateSkillManifest } from "./parser.ts";

export type SkillFileLoader = (
  options?: SkillReadOptions,
) => SkillFileBody | Promise<SkillFileBody>;

export type DefineSkillInput = Readonly<{
  manifest: SkillManifest;
  files: readonly SkillFileDescriptor[];
  read(
    path: string,
    options?: SkillReadOptions,
  ): SkillFileBody | Promise<SkillFileBody>;
}>;

export type InlineSkillFile =
  | SkillFileBody
  | Readonly<{
    mediaType?: string;
    size?: number;
    digest?: string;
    load: SkillFileLoader;
  }>;

export type DefineInlineSkillInput = Readonly<{
  markdown: string;
  directoryName?: string;
  files?: Readonly<Record<string, InlineSkillFile>>;
}>;

function abort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Cancelled", "AbortError");
  }
}

function manifestInput(manifest: SkillManifest): Record<string, unknown> {
  return {
    name: manifest.name,
    description: manifest.description,
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(manifest.compatibility
      ? { compatibility: manifest.compatibility }
      : {}),
    ...(manifest.metadata ? { metadata: manifest.metadata } : {}),
    ...(manifest.allowedTools
      ? { "allowed-tools": manifest.allowedTools }
      : {}),
  };
}

/** Normalizes a path while preventing traversal outside the skill root. */
export function normalizeSkillPath(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Skill file path must be a non-empty string.");
  }
  const input = value.trim().replaceAll("\\", "/");
  if (
    input.startsWith("/") ||
    input.split("/").some((part) => part === "..")
  ) {
    throw new TypeError("Skill file path must remain inside the skill root.");
  }
  const normalized = input.split("/").filter((part) => part && part !== ".")
    .join("/");
  if (!normalized) {
    throw new TypeError("Skill file path must be a non-empty string.");
  }
  return normalized;
}

export function skillFileMediaType(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".md")) return "text/markdown;charset=utf-8";
  if (normalized.endsWith(".txt")) return "text/plain;charset=utf-8";
  if (normalized.endsWith(".json")) return "application/json";
  if (normalized.endsWith(".yaml") || normalized.endsWith(".yml")) {
    return "application/yaml";
  }
  if (normalized.endsWith(".js") || normalized.endsWith(".mjs")) {
    return "text/javascript;charset=utf-8";
  }
  if (normalized.endsWith(".ts")) {
    return "text/typescript;charset=utf-8";
  }
  if (normalized.endsWith(".py")) return "text/x-python;charset=utf-8";
  if (normalized.endsWith(".sh")) return "text/x-shellscript;charset=utf-8";
  if (normalized.endsWith(".html")) return "text/html;charset=utf-8";
  if (normalized.endsWith(".css")) return "text/css;charset=utf-8";
  if (normalized.endsWith(".svg")) return "image/svg+xml";
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function descriptor(value: SkillFileDescriptor): SkillFileDescriptor {
  const path = normalizeSkillPath(value.path);
  if (typeof value.mediaType !== "string" || !value.mediaType.trim()) {
    throw new TypeError(`Skill file '${path}' requires a media type.`);
  }
  if (
    value.size !== undefined &&
    (!Number.isSafeInteger(value.size) || value.size < 0)
  ) {
    throw new TypeError(`Skill file '${path}' has an invalid size.`);
  }
  if (
    value.digest !== undefined &&
    (typeof value.digest !== "string" || !value.digest.trim())
  ) {
    throw new TypeError(`Skill file '${path}' has an invalid digest.`);
  }
  return Object.freeze({
    path,
    mediaType: value.mediaType.trim(),
    ...(value.size !== undefined ? { size: value.size } : {}),
    ...(value.digest ? { digest: value.digest.trim() } : {}),
  });
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(
    value && typeof value === "object" &&
      typeof (value as { getReader?: unknown }).getReader === "function",
  );
}

function fileBody(value: unknown, path: string): SkillFileBody {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return value.slice();
  if (isReadableStream(value)) return value;
  throw new TypeError(
    `Skill file '${path}' must load text, bytes, or a Web ReadableStream.`,
  );
}

/** Defines the portable runtime representation emitted by skill packagers. */
export function defineSkill(input: DefineSkillInput): Skill {
  const manifest = validateSkillManifest(manifestInput(input.manifest));
  if (!Array.isArray(input.files)) {
    throw new TypeError(`Skill '${manifest.name}' files must be an array.`);
  }
  const files = Object.freeze(input.files.map(descriptor));
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    throw new TypeError(
      `Skill '${manifest.name}' contains duplicate file paths.`,
    );
  }
  if (!paths.includes("SKILL.md")) {
    throw new TypeError(`Skill '${manifest.name}' must provide SKILL.md.`);
  }
  if (typeof input.read !== "function") {
    throw new TypeError(`Skill '${manifest.name}' requires a file reader.`);
  }
  const descriptors = new Map(files.map((file) => [file.path, file]));

  const read = async (
    requestedPath: string,
    options: SkillReadOptions = {},
  ): Promise<SkillFile> => {
    abort(options.signal);
    const path = normalizeSkillPath(requestedPath);
    const file = descriptors.get(path);
    if (!file) {
      throw new Error(`Skill '${manifest.name}' does not provide '${path}'.`);
    }
    const body = fileBody(await input.read(path, options), path);
    abort(options.signal);
    return Object.freeze({ ...file, body });
  };

  return Object.freeze({ ...manifest, files, read });
}

function byteSize(value: SkillFileBody): number | undefined {
  if (typeof value === "string") return new TextEncoder().encode(value).length;
  if (value instanceof Uint8Array) return value.byteLength;
  return undefined;
}

function inlineFile(
  path: string,
  value: InlineSkillFile,
): Readonly<{ descriptor: SkillFileDescriptor; load: SkillFileLoader }> {
  if (
    value && typeof value === "object" &&
    !(value instanceof Uint8Array) && !isReadableStream(value) &&
    "load" in value
  ) {
    const configured = value as Exclude<
      InlineSkillFile,
      SkillFileBody
    >;
    if (typeof configured.load !== "function") {
      throw new TypeError(`Skill file '${path}' requires a loader.`);
    }
    return Object.freeze({
      descriptor: Object.freeze({
        path,
        mediaType: configured.mediaType ?? skillFileMediaType(path),
        ...(configured.size !== undefined ? { size: configured.size } : {}),
        ...(configured.digest ? { digest: configured.digest } : {}),
      }),
      load: configured.load,
    });
  }
  const body = value as SkillFileBody;
  return Object.freeze({
    descriptor: Object.freeze({
      path,
      mediaType: skillFileMediaType(path),
      ...(byteSize(body) !== undefined ? { size: byteSize(body) } : {}),
    }),
    load: () => body,
  });
}

/** Defines a small portable skill directly from standard Markdown and files. */
export function defineInlineSkill(input: DefineInlineSkillInput): Skill {
  const parsed = parseSkillMarkdown(input.markdown, {
    directoryName: input.directoryName,
  });
  if (Object.hasOwn(input.files ?? {}, "SKILL.md")) {
    throw new TypeError("defineInlineSkill adds SKILL.md automatically.");
  }
  const configured = Object.entries(input.files ?? {}).map(([rawPath, value]) =>
    inlineFile(normalizeSkillPath(rawPath), value)
  );
  const skillMarkdown = inlineFile("SKILL.md", input.markdown);
  const all = [skillMarkdown, ...configured].sort((left, right) =>
    left.descriptor.path.localeCompare(right.descriptor.path)
  );
  const loaders = new Map(all.map((file) => [file.descriptor.path, file.load]));
  return defineSkill({
    manifest: parsed.manifest,
    files: all.map((file) => file.descriptor),
    async read(path, options) {
      const load = loaders.get(path);
      if (!load) throw new Error(`Skill file '${path}' was not found.`);
      return await load(options);
    },
  });
}

/** Reads one skill file as bounded UTF-8 text. */
export async function readSkillFileText(
  file: SkillFile,
  maximumBytes = 1_000_000,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer.");
  }
  if (typeof file.body === "string") {
    if (new TextEncoder().encode(file.body).length > maximumBytes) {
      throw new RangeError(`Skill file '${file.path}' exceeds the text limit.`);
    }
    return file.body;
  }
  if (file.body instanceof Uint8Array) {
    if (file.body.byteLength > maximumBytes) {
      throw new RangeError(`Skill file '${file.path}' exceeds the text limit.`);
    }
    return new TextDecoder().decode(file.body);
  }

  const reader = file.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("skill_file_text_limit");
        throw new RangeError(
          `Skill file '${file.path}' exceeds the text limit.`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
