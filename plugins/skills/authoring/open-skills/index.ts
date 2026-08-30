/**
 * Builds portable Open Skills plugins from filesystem directories.
 *
 * @module
 */

import {
  fromFileUrl,
  join,
  relative,
  resolve,
} from "../../../../dependencies/std-path.ts";
import {
  parseSkillMarkdown,
  skillFileMediaType,
} from "../../resources/skill/index.ts";
import type {
  SkillFileDescriptor,
  SkillManifest,
} from "../../internal/contracts.ts";

const DEFAULT_RUNTIME_IMPORT = "jsr:@copilotz/copilotz@^0.63.7/skills";

export type BuildOpenSkillsPluginOptions = Readonly<{
  /** Directory whose immediate children are Agent Skills directories. */
  root: string | URL;
  /** Generated portable module directory. Keep it outside canonical skills. */
  output: string | URL;
  id: string;
  version: string;
  /** Override for monorepo tests or non-JSR package aliases. */
  runtimeImport?: string;
}>;

export type OpenSkillsPluginBuild = Readonly<{
  output: string;
  pluginModule: string;
  skillNames: readonly string[];
  generatedFiles: readonly string[];
}>;

type PackedFile = Readonly<{
  descriptor: SkillFileDescriptor;
  body: Uint8Array;
}>;

type PackedSkill = Readonly<{
  manifest: SkillManifest;
  files: readonly PackedFile[];
}>;

function localPath(value: string | URL): string {
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      throw new TypeError("Open Skill build paths must use file URLs.");
    }
    return fromFileUrl(value);
  }
  if (!value.trim()) throw new TypeError("Open Skill build path is required.");
  return resolve(value);
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

async function descriptor(
  path: string,
  body: Uint8Array,
): Promise<SkillFileDescriptor> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    body.slice().buffer as ArrayBuffer,
  );
  return Object.freeze({
    path,
    mediaType: skillFileMediaType(path),
    size: body.byteLength,
    digest: `sha256:${hex(digest)}`,
  });
}

async function collectFiles(
  directory: string,
  prefix = "",
): Promise<readonly PackedFile[]> {
  const result: PackedFile[] = [];
  const entries = [];
  for await (const entry of Deno.readDir(directory)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymlink) {
      throw new TypeError(
        `Open Skill packages cannot contain symlink '${entry.name}'.`,
      );
    }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory) {
      result.push(...await collectFiles(absolute, path));
    } else if (entry.isFile) {
      const body = await Deno.readFile(absolute);
      result.push(Object.freeze({
        descriptor: await descriptor(path, body),
        body,
      }));
    }
  }
  return Object.freeze(result);
}

async function collectSkills(root: string): Promise<readonly PackedSkill[]> {
  const entries = [];
  for await (const entry of Deno.readDir(root)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const skills: PackedSkill[] = [];
  for (const entry of entries) {
    if (entry.isSymlink) {
      throw new TypeError(
        `Open Skill roots cannot contain symlink '${entry.name}'.`,
      );
    }
    if (!entry.isDirectory) continue;
    const files = await collectFiles(join(root, entry.name));
    const markdown = files.find((file) => file.descriptor.path === "SKILL.md");
    if (!markdown) {
      throw new TypeError(
        `Skill directory '${entry.name}' is missing SKILL.md.`,
      );
    }
    const parsed = parseSkillMarkdown(new TextDecoder().decode(markdown.body), {
      directoryName: entry.name,
    });
    skills.push(Object.freeze({ manifest: parsed.manifest, files }));
  }
  if (!skills.length) {
    throw new TypeError(
      "Open Skill root does not contain any skill directories.",
    );
  }
  return Object.freeze(skills);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function isText(descriptor: SkillFileDescriptor): boolean {
  return descriptor.mediaType.startsWith("text/") ||
    descriptor.mediaType.startsWith("application/json") ||
    descriptor.mediaType.startsWith("application/yaml") ||
    descriptor.mediaType.includes("javascript") ||
    descriptor.mediaType.includes("xml") ||
    descriptor.mediaType === "image/svg+xml";
}

function skillChunk(skill: PackedSkill): string {
  const entries = skill.files.map((file) => {
    const body = isText(file.descriptor)
      ? JSON.stringify(new TextDecoder().decode(file.body))
      : `decodeBase64(${JSON.stringify(base64(file.body))})`;
    return `  ${JSON.stringify(file.descriptor.path)}: () => ${body},`;
  }).join("\n");
  return `const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const files: Readonly<Record<string, () => string | Uint8Array>> = Object.freeze({
${entries}
});

export function read(path: string): string | Uint8Array {
  const load = files[path];
  if (!load) throw new Error(\`Skill file '\${path}' was not packed.\`);
  return load();
}
`;
}

function pluginModule(
  options: Readonly<{
    id: string;
    version: string;
    runtimeImport: string;
    skills: readonly PackedSkill[];
  }>,
): string {
  const definitions = options.skills.map((skill) => {
    const descriptors = skill.files.map((file) => file.descriptor);
    return `  defineSkill({
    manifest: ${JSON.stringify(skill.manifest, null, 2)},
    files: ${JSON.stringify(descriptors, null, 2)},
    read: async (path) =>
      await import(${JSON.stringify(`./skills/${skill.manifest.name}.ts`)})
        .then((module) => module.read(path)),
  }),`;
  }).join("\n");
  return `import {
  createSkillsPlugin,
  defineSkill,
} from ${JSON.stringify(options.runtimeImport)};

export const skills = Object.freeze([
${definitions}
]);

export default createSkillsPlugin({
  id: ${JSON.stringify(options.id)},
  version: ${JSON.stringify(options.version)},
  skills,
});
`;
}

/**
 * Validates standard Agent Skills directories and emits a portable, lazy
 * Copilotz plugin. This Deno-only filesystem step never enters app runtime.
 */
export async function buildOpenSkillsPlugin(
  options: BuildOpenSkillsPluginOptions,
): Promise<OpenSkillsPluginBuild> {
  const root = localPath(options.root);
  const output = localPath(options.output);
  const outputFromRoot = relative(root, output).replaceAll("\\", "/");
  if (
    outputFromRoot === "" ||
    (outputFromRoot !== ".." && !outputFromRoot.startsWith("../"))
  ) {
    throw new TypeError(
      "Generated skill plugin output must remain outside canonical skill source.",
    );
  }
  const id = requiredText(options.id, "Plugin id");
  const version = requiredText(options.version, "Plugin version");
  const runtimeImport = requiredText(
    options.runtimeImport ?? DEFAULT_RUNTIME_IMPORT,
    "Runtime import",
  );
  const skills = await collectSkills(root);
  const chunks = join(output, "skills");
  await Deno.mkdir(chunks, { recursive: true });
  const generatedFiles: string[] = [];
  for (const skill of skills) {
    const path = join(chunks, `${skill.manifest.name}.ts`);
    await Deno.writeTextFile(path, skillChunk(skill));
    generatedFiles.push(path);
  }
  const modulePath = join(output, "plugin.ts");
  await Deno.writeTextFile(
    modulePath,
    pluginModule({
      id,
      version,
      runtimeImport,
      skills,
    }),
  );
  generatedFiles.unshift(modulePath);
  return Object.freeze({
    output,
    pluginModule: modulePath,
    skillNames: Object.freeze(skills.map((skill) => skill.manifest.name)),
    generatedFiles: Object.freeze(generatedFiles),
  });
}
