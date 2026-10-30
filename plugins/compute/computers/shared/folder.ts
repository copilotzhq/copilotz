/** A space's folder name on a computer: its name, plain (one segment, lowercase), kept apart from the others'. */
export function folderFor(name: string, taken: string[]): string {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "space";
  let folder = base;
  for (let n = 2; taken.includes(folder); n++) folder = `${base}-${n}`;
  return folder;
}
