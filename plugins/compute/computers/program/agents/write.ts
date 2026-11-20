/** Files engines read, written whole: a reader never sees half of one. */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Writes `text` to `path` whole (with `mode`), unless it's there already. */
export async function writeWhole(path: string, text: string, mode = 0o644): Promise<void> {
  if (await readFile(path, "utf8").then((was) => was === text, () => false)) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
}
