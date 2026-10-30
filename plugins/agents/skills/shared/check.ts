/**
 * What a skill may be: its name (what agents call it by: lowercase words
 * joined by dashes, as SKILL.md files name theirs), what it's for, its
 * instructions and its files (paths inside the skill, never outside it).
 * Pure, so the browser's editor says the same as the Actions.
 */

/** The longest a name, a description, instructions, a file and a path may be, and how many files. */
export const LIMITS = {
  name: 64,
  description: 1024,
  instructions: 100_000,
  file: 500_000,
  path: 200,
  files: 50,
} as const;

/** The file holding a skill's instructions: never one of its other files. */
export const SKILL_MD = "SKILL.md";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What a name for a skill would be, from any words: "Weekly report!" is `weekly-report`. */
export const nameOf = (words: string): string =>
  words.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, LIMITS.name).replace(/-+$/, "");

/** What's wrong with a skill's name, if anything. */
export function nameProblem(name: string): string | undefined {
  if (!name) return "Give it a name.";
  if (name.length > LIMITS.name) return `A name has at most ${LIMITS.name} characters.`;
  if (!NAME.test(name)) {
    return "A name is lowercase letters and digits, words joined by dashes: weekly-report.";
  }
  return undefined;
}

/** What's wrong with a file's path, if anything: relative, inside the skill, plain characters. */
export function pathProblem(path: string): string | undefined {
  if (!path.trim()) return "Give the file a name.";
  if (path.length > LIMITS.path) return `A file's path has at most ${LIMITS.path} characters.`;
  if (path === SKILL_MD) return `${SKILL_MD} holds the instructions: name the file otherwise.`;
  if (!/^[\w .()+@-]+(?:\/[\w .()+@-]+)*$/.test(path) || path.startsWith(" ")) {
    return `"${path}" isn't a plain path inside the skill (folders/name.md).`;
  }
  if (path.split("/").some((part) => part === "." || part === ".." || part.trim() !== part)) {
    return `"${path}" isn't a plain path inside the skill (folders/name.md).`;
  }
  return undefined;
}

/** A skill as it's written: what's checked before it's kept. */
export type Written = {
  name?: string;
  description?: string;
  instructions?: string;
  files?: { path: string; text: string }[];
};

/** Everything wrong with what's written, by field (`files.2` for a file), or none. */
export function problems(skill: Written): Record<string, string> {
  const found: Record<string, string> = {};
  if (skill.name !== undefined) {
    const wrong = nameProblem(skill.name);
    if (wrong) found.name = wrong;
  }
  if (skill.description !== undefined) {
    if (!skill.description.trim()) found.description = "Say when it's for: agents decide by it.";
    else if (skill.description.length > LIMITS.description) {
      found.description = `At most ${LIMITS.description} characters.`;
    }
  }
  if (skill.instructions !== undefined) {
    if (!skill.instructions.trim()) found.instructions = "Write what to do.";
    else if (skill.instructions.length > LIMITS.instructions) {
      found.instructions = `At most ${LIMITS.instructions.toLocaleString("en")} characters.`;
    }
  }
  const files = skill.files ?? [];
  if (files.length > LIMITS.files) found.files = `At most ${LIMITS.files} files.`;
  const seen = new Set<string>();
  files.forEach((file, i) => {
    const wrong = pathProblem(file.path) ??
      (seen.has(file.path) ? `Two files are called "${file.path}".` : undefined) ??
      (file.text.length > LIMITS.file
        ? `"${file.path}" is too long: at most ${LIMITS.file.toLocaleString("en")} characters.`
        : undefined);
    seen.add(file.path);
    if (wrong) found[`files.${i}`] = wrong;
  });
  return found;
}

/** Throws `invalid` with the first problem, if there is one. */
export function checked(skill: Written): void {
  const [problem] = Object.values(problems(skill));
  if (problem) throw Object.assign(new Error(problem), { code: "invalid" });
}
