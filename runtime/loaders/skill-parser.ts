/**
 * Parser for SKILL.md files with YAML frontmatter.
 *
 * Expected format:
 * ```markdown
 * ---
 * name: create-agent
 * description: Scaffold a new Copilotz agent
 * allowed-tools: [read_file, write_file, list_directory]
 * tags: [framework, agent]
 * ---
 *
 * # Create Agent
 *
 * Step-by-step instructions...
 * ```
 *
 * @module
 */

import { parse as parseYaml } from "yaml";

export interface ParsedSkillMarkdown {
    frontmatter: Record<string, unknown>;
    body: string;
}

/**
 * Parse a SKILL.md file into frontmatter and body.
 *
 * Handles:
 * - Standard `---` delimited YAML frontmatter
 * - Missing frontmatter (entire file treated as body)
 * - Invalid YAML (warns to console, returns empty frontmatter)
 */
export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
    const trimmed = raw.trimStart();

    if (!trimmed.startsWith("---")) {
        return { frontmatter: {}, body: raw.trim() };
    }

    const endIndex = trimmed.indexOf("\n---", 3);
    if (endIndex === -1) {
        return { frontmatter: {}, body: raw.trim() };
    }

    const yamlBlock = trimmed.slice(3, endIndex).trim();
    const body = trimmed.slice(endIndex + 4).trim();

    try {
        const parsed = parseYaml(yamlBlock);
        const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
        return { frontmatter, body };
    } catch (err) {
        console.warn(`[copilotz] Failed to parse SKILL.md frontmatter: ${err}`);
        return { frontmatter: {}, body: raw.trim() };
    }
}
