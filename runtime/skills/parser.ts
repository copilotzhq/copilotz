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

export interface ParsedSkillMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseScalar(value: string): unknown {
  const normalized = value.trim();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    const inner = normalized.slice(1, -1).trim();
    return inner
      ? inner.split(",").map((item) => item.trim()).filter(Boolean).map((
        item,
      ) => parseScalar(item))
      : [];
  }
  if (normalized.startsWith("[") || normalized.endsWith("]")) {
    throw new TypeError("Malformed frontmatter array.");
  }
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return normalized.slice(1, -1);
  }
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (normalized === "null") return null;
  if (/^-?(?:\d+|\d*\.\d+)$/.test(normalized)) return Number(normalized);
  return normalized;
}

/** Parse the deliberately small, portable frontmatter subset skills use. */
function parseFrontmatter(value: string): Record<string, unknown> {
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  const result: Record<string, unknown> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!match) throw new TypeError(`Malformed frontmatter line '${line}'.`);
    const key = match[1];
    let raw = match[2] ?? "";
    if (raw.startsWith("[") && !raw.includes("]")) {
      while (++index < lines.length) {
        raw += ` ${lines[index].trim()}`;
        if (raw.includes("]")) break;
      }
      if (!raw.endsWith("]")) {
        throw new TypeError(`Unclosed frontmatter array '${key}'.`);
      }
    }
    result[key] = parseScalar(raw);
  }
  return result;
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
    return { frontmatter: parseFrontmatter(yamlBlock), body };
  } catch (err) {
    console.warn(`[copilotz] Failed to parse SKILL.md frontmatter: ${err}`);
    return { frontmatter: {}, body: raw.trim() };
  }
}
