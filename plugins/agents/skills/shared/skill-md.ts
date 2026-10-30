/**
 * SKILL.md, as skills are written to share: a front matter with the skill's
 * `name` and `description` (YAML, between `---` lines), then its
 * instructions in Markdown. Reading one takes the two fields it knows
 * (plain, quoted, or a folded `>` / literal `|` block) and leaves any other
 * (a license, metadata) aside; writing one gives them back. Pure, for the
 * browser (pasting or uploading one) and the server alike.
 */

/** What a SKILL.md says. */
export type SkillMd = { name?: string; description?: string; instructions: string };

const unquote = (value: string): string => {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length > 1) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
};

/** Reads a SKILL.md; without a front matter, it's all instructions. */
export function parseSkillMd(source: string): SkillMd {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const head = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!head) return { instructions: text.trim() };
  const fields: Record<string, string> = {};
  const lines = head[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, rest] = m;
    const block = /^([>|])[+-]?\s*$/.exec(rest);
    if (block || rest === "") {
      // A block: the lines indented under it, folded (`>`) or as they are (`|`).
      const taken: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === "")) {
        taken.push(lines[++i]);
      }
      const indent = Math.min(
        ...taken.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
      );
      const body = taken.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      fields[key] = block?.[1] === "|"
        ? body.join("\n").trim()
        : body.join("\n").trim().replace(/\n(?!\n)/g, " ").replace(/\n\n+/g, "\n");
    } else fields[key] = unquote(rest);
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    instructions: text.slice(head[0].length).trim(),
  };
}

/** A value as YAML writes it safely: plain when it can be, else double-quoted. */
const yaml = (value: string): string =>
  /^[\w(][^:#\n"']*$/.test(value) && !/\s$/.test(value) ? value : JSON.stringify(value);

/** Writes a SKILL.md: its front matter, then its instructions. */
export const formatSkillMd = (skill: Required<SkillMd>): string =>
  `---\nname: ${yaml(skill.name)}\ndescription: ${yaml(skill.description.replace(/\s+/g, " "))}` +
  `\n---\n\n${skill.instructions.trim()}\n`;
