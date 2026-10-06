/** Bounded, app-scoped completed manifest snapshots. No shared pending I/O. @module */
import type { ParsedSkillMarkdown } from "./parser.ts";
import type { Skill, SkillReadOptions } from "./contracts.ts";
import { parseSkillMarkdown } from "./parser.ts";
import { readSkillFileText } from "../resources/skill/index.ts";
import { rootReader, type SkillRootInput } from "./root-reader.ts";

type Snapshot = {
  parsed: ParsedSkillMarkdown;
  markdown: string;
  bytes: number;
  markdownBytes: number;
  expiresAt: number;
};
const scopes = new WeakMap<object, Map<Skill, Snapshot>>();
const freshnessMs = 5 * 60_000;
const maximumEntries = 64;
const maximumBytes = 4 * 1024 * 1024;

export function createRootSkill(name: string, input: SkillRootInput): Skill {
  const read = rootReader(input);
  const snapshot = async (
    options: SkillReadOptions = {},
  ): Promise<Snapshot> => {
    options.signal?.throwIfAborted();
    const cache = options.scope
      ? scopes.get(options.scope) ?? new Map<Skill, Snapshot>()
      : undefined;
    if (options.scope && cache) scopes.set(options.scope, cache);
    const cached = cache?.get(skill);
    if (cached && cached.expiresAt > Date.now()) {
      cache!.delete(skill);
      cache!.set(skill, cached);
      return cached;
    }
    cache?.delete(skill);
    const markdown = await readSkillFileText(
      await read("SKILL.md", options),
      1_000_000,
      options.signal,
    );
    const loaded = parseSkillMarkdown(markdown);
    const parsed = Object.freeze({
      body: loaded.body,
      manifest: Object.freeze({
        ...loaded.manifest,
        ...(loaded.manifest.metadata
          ? { metadata: Object.freeze({ ...loaded.manifest.metadata }) }
          : {}),
      }),
    });
    if (parsed.manifest.name !== name) {
      throw new Error(
        `Skill '${name}' has a different name in SKILL.md ('${parsed.manifest.name}').`,
      );
    }
    const encoder = new TextEncoder();
    const markdownBytes = encoder.encode(markdown).length;
    const result = {
      parsed,
      markdown,
      markdownBytes,
      bytes: markdownBytes + encoder.encode(parsed.body).length +
        encoder.encode(JSON.stringify(parsed.manifest)).length,
      expiresAt: Date.now() + freshnessMs,
    };
    if (cache) {
      cache.set(skill, result);
      let bytes = [...cache.values()].reduce(
        (total, value) => total + value.bytes,
        0,
      );
      while (cache.size > maximumEntries || bytes > maximumBytes) {
        const oldest = cache.keys().next().value!;
        bytes -= cache.get(oldest)!.bytes;
        cache.delete(oldest);
      }
    }
    return result;
  };
  const skill: Skill = Object.freeze({
    name,
    files: [],
    dynamicFiles: true,
    async load(options) {
      const value = await snapshot(options);
      if (
        value.markdownBytes >
          (options?.maximumTextBytes ?? 1_000_000)
      ) throw new RangeError(`Skill '${name}' exceeds the text limit.`);
      return value.parsed;
    },
    async read(path, options) {
      return path === "SKILL.md"
        ? {
          path,
          mediaType: "text/markdown;charset=utf-8",
          body: (await snapshot(options)).markdown,
        }
        : await read(path, options);
    },
  });
  return skill;
}

export async function skillManifest(
  skill: Skill,
  options: SkillReadOptions = {},
) {
  if (skill.dynamicFiles) return (await skill.load(options)).manifest;
  return {
    name: skill.name,
    description: skill.description!,
    compatibility: skill.compatibility,
    allowedTools: skill.allowedTools,
  };
}

/** Four independent readers at a time; caller authorization precedes this operation. */
export async function mapSkills<T>(
  skills: readonly Skill[],
  read: (skill: Skill) => Promise<T>,
): Promise<T[]> {
  const values: T[] = [];
  for (let offset = 0; offset < skills.length; offset += 4) {
    values.push(
      ...await Promise.all(skills.slice(offset, offset + 4).map(read)),
    );
  }
  return values;
}
