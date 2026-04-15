/**
 * Skill loader for file-based and remote skills.
 *
 * Loads skills from directories (project, user home, bundled) and remote URLs.
 * Supports the Agent Skills standard SKILL.md format with YAML frontmatter.
 *
 * @module
 */

import type { Skill } from "./skill-types.ts";
import type { Agent } from "@/types/index.ts";
import { parseSkillMarkdown } from "./skill-parser.ts";

/**
 * Load all skills from a directory.
 *
 * Each subdirectory must contain a `SKILL.md` file.
 * Optionally a `references/` subdirectory with supporting files.
 *
 * @param dirPath - Absolute path to the skills directory
 * @param source - Where this directory is located
 */
export async function loadSkillsFromDirectory(
    dirPath: string,
    source: "project" | "user" | "bundled",
): Promise<Skill[]> {
    const skills: Skill[] = [];

    // Check directory exists before iterating (readDir is lazy and throws during iteration)
    try {
        const stat = await Deno.stat(dirPath);
        if (!stat.isDirectory) return skills;
    } catch {
        return skills;
    }

    for await (const entry of Deno.readDir(dirPath)) {
        if (!entry.isDirectory) continue;

        const skillDir = dirPath.endsWith("/") ? dirPath + entry.name : dirPath + "/" + entry.name;
        const skillMdPath = skillDir + "/SKILL.md";

        let raw: string;
        try {
            raw = await Deno.readTextFile(skillMdPath);
        } catch {
            // No SKILL.md — skip
            continue;
        }

        const { frontmatter, body } = parseSkillMarkdown(raw);

        const name = typeof frontmatter.name === "string"
            ? frontmatter.name
            : entry.name;

        const description = typeof frontmatter.description === "string"
            ? frontmatter.description
            : "";

        const allowedTools = Array.isArray(frontmatter["allowed-tools"])
            ? (frontmatter["allowed-tools"] as unknown[]).filter((t): t is string => typeof t === "string")
            : undefined;

        const tags = Array.isArray(frontmatter.tags)
            ? (frontmatter.tags as unknown[]).filter((t): t is string => typeof t === "string")
            : undefined;

        let hasReferences = false;
        try {
            const stat = await Deno.stat(skillDir + "/references");
            hasReferences = stat.isDirectory;
        } catch {
            // No references/ directory
        }

        // Extract known frontmatter keys, keep the rest as metadata
        const { name: _n, description: _d, "allowed-tools": _at, tags: _t, ...metadata } = frontmatter;

        skills.push({
            name,
            description,
            content: body,
            allowedTools,
            tags,
            source,
            sourcePath: skillDir,
            hasReferences,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
    }

    return skills;
}

/**
 * Load a single SKILL.md from an HTTPS URL.
 *
 * The skill name is derived from the URL path or frontmatter.
 * Remote skills cannot have `references/` (filesystem access not possible).
 */
export async function loadSkillFromUrl(url: string): Promise<Skill> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch skill from ${url}: ${response.status} ${response.statusText}`);
    }
    const raw = await response.text();
    const { frontmatter, body } = parseSkillMarkdown(raw);

    // Derive name from frontmatter or URL path
    const name = typeof frontmatter.name === "string"
        ? frontmatter.name
        : url.split("/").filter(Boolean).pop()?.replace(/\.md$/i, "") ?? "unnamed";

    const description = typeof frontmatter.description === "string"
        ? frontmatter.description
        : "";

    const allowedTools = Array.isArray(frontmatter["allowed-tools"])
        ? (frontmatter["allowed-tools"] as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined;

    const tags = Array.isArray(frontmatter.tags)
        ? (frontmatter.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined;

    const { name: _n, description: _d, "allowed-tools": _at, tags: _t, ...metadata } = frontmatter;

    return {
        name,
        description,
        content: body,
        allowedTools,
        tags,
        source: "remote",
        sourcePath: url,
        hasReferences: false,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
}

/**
 * Merge multiple skill arrays with precedence.
 *
 * Earlier arrays take priority on name collision.
 * Usage: `mergeSkills(project, explicit, user, bundled)` — project wins.
 */
export function mergeSkills(...layers: Skill[][]): Skill[] {
    const seen = new Set<string>();
    const result: Skill[] = [];

    for (const layer of layers) {
        for (const skill of layer) {
            if (!seen.has(skill.name)) {
                seen.add(skill.name);
                result.push(skill);
            }
        }
    }

    return result;
}

/**
 * Filter skills based on an agent's `allowedSkills` config.
 *
 * - `undefined` (default): all skills allowed
 * - `null`: no skills allowed
 * - `string[]`: only named skills allowed
 */
export function filterSkillsForAgent(skills: Skill[], agent?: Agent | null): Skill[] {
    if (!agent) return skills;
    if (agent.allowedSkills === null) return [];
    if (Array.isArray(agent.allowedSkills)) {
        return skills.filter((s) => (agent.allowedSkills as string[]).includes(s.name));
    }
    return skills;
}
