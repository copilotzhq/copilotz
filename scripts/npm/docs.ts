/** The two reading lists must work offline, from the root of an installed package. */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function checkDocLinks(root: string, file: string): void {
  const source = readFileSync(resolve(root, file), "utf8");
  const headings = new Map<string, Set<string>>();
  for (const [, href] of source.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(?:https?:|mailto:)/i.test(href)) continue;
    const [path, fragment] = href.split("#");
    const target = resolve(root, decodeURIComponent(path || file));
    const local = relative(root, target);
    if (
      local === ".." || local.startsWith(".." + sep) || isAbsolute(local) || isAbsolute(path) ||
      !statSync(target, { throwIfNoEntry: false })?.isFile()
    ) {
      throw new Error(`${file}: missing or outside the package: ${href}`);
    }
    if (!fragment) continue;
    if (!headings.has(target)) {
      const markdown = readFileSync(target, "utf8").replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
      const ids = new Set<string>();
      for (const [, title] of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
        const slug = title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(
          / /g,
          "-",
        );
        let id = slug;
        for (let i = 1; ids.has(id); i++) id = `${slug}-${i}`;
        ids.add(id);
      }
      headings.set(target, ids);
    }
    if (!headings.get(target)!.has(decodeURIComponent(fragment))) {
      throw new Error(`${file}: no such heading: ${href}`);
    }
  }
}
