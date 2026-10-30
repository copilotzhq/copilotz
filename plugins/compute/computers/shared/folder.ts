/** A name as a folder's: plain (one segment, lowercase), or `fallback` when nothing's left. */
export function plainName(name: string, fallback = "space"): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback;
}

/** A space's folder name on a computer: its name, plain, kept apart from the others'. */
export function folderFor(name: string, taken: string[]): string {
  const base = plainName(name);
  let folder = base;
  for (let n = 2; taken.includes(folder); n++) folder = `${base}-${n}`;
  return folder;
}
