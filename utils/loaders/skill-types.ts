/**
 * Type definitions for the Copilotz Skills system.
 *
 * Skills are markdown files (SKILL.md) with YAML frontmatter that teach
 * agents how to perform specific tasks. They follow a progressive disclosure
 * model: only names and descriptions are loaded into the system prompt,
 * while full content is loaded on-demand via native tools.
 *
 * @module
 */

/**
 * A loaded skill with parsed frontmatter and full content.
 */
export interface Skill {
    /** Unique name derived from directory name or frontmatter `name` field. */
    name: string;
    /** Short description from YAML frontmatter. */
    description: string;
    /** Full markdown body (loaded but not injected into system prompt). */
    content: string;
    /** Tools the skill recommends or requires (from frontmatter `allowed-tools`). */
    allowedTools?: string[];
    /** Tags for categorization (from frontmatter). */
    tags?: string[];
    /** Where this skill was loaded from. */
    source: "project" | "user" | "bundled" | "remote";
    /** Absolute path to the skill directory, or URL for remote skills. */
    sourcePath: string;
    /** Whether the skill has a `references/` subdirectory with supporting files. */
    hasReferences: boolean;
    /** Arbitrary extra frontmatter fields. */
    metadata?: Record<string, unknown>;
}

/**
 * Compact index entry injected into the system prompt.
 * Approximately 15-30 tokens per entry.
 */
export interface SkillIndexEntry {
    name: string;
    description: string;
    tags?: string[];
}
