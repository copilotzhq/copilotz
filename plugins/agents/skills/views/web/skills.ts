/**
 * Skills as their web front end says them: each one's page, what a search
 * finds, which file a path is (Markdown, or code), what a skill's files are
 * as an editor keeps them, and what files someone picks make: a SKILL.md
 * read for its name, purpose and instructions, and the rest as its files
 * (a folder's own top folder taken off; hidden, binary or oversized files,
 * and paths no skill may have, left out and said). Pure, so tested.
 */
import { LIMITS, pathProblem, SKILL_MD } from "../../shared/check.ts";
import { parseSkillMd, type SkillMd } from "../../shared/skill-md.ts";
import type { Shown } from "../../shared/skills.ts";

/** A skill's page, where the person is (`in`); `edit`, open to change it. */
export const skillPath = (id: string, space?: string, edit = false) => {
  const query = [
    ...(space ? [`in=${encodeURIComponent(space)}`] : []),
    ...(edit ? ["edit=1"] : []),
  ];
  return `/skill/${encodeURIComponent(id)}${query.length ? `?${query.join("&")}` : ""}`;
};

/** A space's Skills tab. */
export const skillsTab = (space: string) => `/space/${encodeURIComponent(space)}?tab=skills`;

/** Text as it's matched: any case, any accents. */
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Whether a skill has every word typed, in its name, purpose or files. */
export function matches(skill: Shown, typed: string): boolean {
  const words = fold(typed).split(/\s+/).filter(Boolean);
  const text = fold(
    `${skill.name} ${skill.description} ${skill.files.map((f) => f.path).join(" ")}`,
  );
  return words.every((w) => text.includes(w));
}

/** Whether a file reads as Markdown (a page), not as code or plain text. */
export const markdownish = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

/** A file, as an editor keeps it. */
export type DraftFile = { path: string; text: string };

/** A skill as it's being written. */
export type Draft = { name: string; description: string; instructions: string; files: DraftFile[] };

export const blank = (): Draft => ({ name: "", description: "", instructions: "", files: [] });

/** A file someone picked: its path (in a folder, from its top) and what it says. */
export type Picked = { path: string; text: string; binary?: boolean };

/** What picked files make: a SKILL.md's fields, the other files, and what was left out, and why. */
export type Imported = { md?: SkillMd; files: DraftFile[]; skipped: string[] };

export function fromPicked(picked: Picked[]): Imported {
  const parts = picked.map((p) => p.path.replace(/\\/g, "/").replace(/^\.?\//, "").split("/"));
  // A folder picked whole: its own name goes, so its files are the skill's.
  const top = parts.length && parts.every((p) => p.length > 1 && p[0] === parts[0][0]) ? 1 : 0;
  const files: DraftFile[] = [];
  const skipped: string[] = [];
  let md: SkillMd | undefined;
  picked.forEach((p, i) => {
    const path = parts[i].slice(top).join("/");
    const name = parts[i].at(-1) ?? "";
    if (name.startsWith(".") || parts[i].slice(top).some((part) => part.startsWith("."))) return;
    if (!md && path.toLowerCase() === SKILL_MD.toLowerCase()) {
      md = parseSkillMd(p.text);
      return;
    }
    if (p.binary) return void skipped.push(`${path} (not text)`);
    if (p.text.length > LIMITS.file) return void skipped.push(`${path} (too long)`);
    if (pathProblem(path)) return void skipped.push(`${path} (not a plain path)`);
    files.push({ path, text: p.text });
  });
  // A SKILL.md in a folder of its own, when none was at the top.
  if (!md) {
    const nested = picked.findIndex((_, i) => parts[i].at(-1)?.toLowerCase() === "skill.md");
    if (nested >= 0) {
      md = parseSkillMd(picked[nested].text);
      const at = files.findIndex((f) => f.path === parts[nested].slice(top).join("/"));
      if (at >= 0) files.splice(at, 1);
    }
  }
  return {
    ...(md ? { md } : {}),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    skipped,
  };
}

/** Files merged: those picked replace any of the same path; the rest are added. */
export const merged = (have: DraftFile[], added: DraftFile[]): DraftFile[] =>
  [...have.filter((f) => !added.some((a) => a.path === f.path)), ...added]
    .sort((a, b) => a.path.localeCompare(b.path));

/** A new file's path, free among those there: `notes.md`, `notes-2.md`. */
export function freePath(files: DraftFile[], base = "notes.md"): string {
  const [stem, ext] = /^(.*?)(\.[^.]+)?$/.exec(base)!.slice(1);
  for (let n = 1;; n++) {
    const path = n === 1 ? base : `${stem}-${n}${ext ?? ""}`;
    if (!files.some((f) => f.path === path)) return path;
  }
}

/** What changed between a skill as it was and as it's written, as `skill.update` takes it. */
export function changes(was: Draft, now: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (now.name.trim() !== was.name) out.name = now.name.trim();
  if (now.description.trim() !== was.description.trim()) out.description = now.description.trim();
  if (now.instructions !== was.instructions) out.instructions = now.instructions;
  const files = (d: Draft) => JSON.stringify(d.files.map((f) => [f.path, f.text]));
  if (files(now) !== files(was)) out.files = now.files.map((f) => ({ path: f.path, text: f.text }));
  return out;
}
