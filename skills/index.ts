/**
 * Barrel module for bundled skills.
 *
 * Uses fetch() with import.meta.resolve() so skills are loaded
 * from both local filesystems and JSR HTTPS URLs.
 *
 * @module
 */

import { parseSkillMarkdown } from "@/utils/loaders/skill-parser.ts";
import type { Skill } from "@/utils/loaders/skill-types.ts";

const BUNDLED_SKILL_DIRS = [
  "add-api-integration",
  "add-processor",
  "configure-mcp",
  "configure-rag",
  "create-agent",
  "create-tool",
  "multi-agent-setup",
  "setup-collection",
];
let bundledSkillsPromise: Promise<Skill[]> | undefined;

function parseRawSkill(dirName: string, raw: string): Skill {
  const { frontmatter, body } = parseSkillMarkdown(raw);
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : dirName,
    description: typeof frontmatter.description === "string"
      ? frontmatter.description
      : "",
    content: body,
    allowedTools: Array.isArray(frontmatter["allowed-tools"])
      ? (frontmatter["allowed-tools"] as unknown[]).filter((t): t is string =>
        typeof t === "string"
      )
      : undefined,
    tags: Array.isArray(frontmatter.tags)
      ? (frontmatter.tags as unknown[]).filter((t): t is string =>
        typeof t === "string"
      )
      : undefined,
    source: "bundled",
    sourcePath: dirName,
    hasReferences: false,
  };
}

/** Load all bundled skills via fetch (works for both file:// and https:// URLs). */
export async function loadBundledSkills(): Promise<Skill[]> {
  if (!bundledSkillsPromise) {
    bundledSkillsPromise = Promise.all(
      BUNDLED_SKILL_DIRS.map(async (dir): Promise<Skill | null> => {
        try {
          const url = new URL(`./${dir}/SKILL.md`, import.meta.url).href;
          const res = await fetch(url);
          if (!res.ok) return null;
          const raw = await res.text();
          return parseRawSkill(dir, raw);
        } catch {
          return null;
        }
      }),
    )
      .then((skills) =>
        skills.filter((skill): skill is Skill => skill !== null)
      )
      .catch((error) => {
        bundledSkillsPromise = undefined;
        throw error;
      });
  }

  return await bundledSkillsPromise;
}
