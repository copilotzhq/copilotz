/**
 * What `FileInput` decides about files, as plain functions: whether a file
 * is one its `accept` takes (as the browser's own file field reads it:
 * extensions, exact types, `image/*`), and which of the files dropped on it
 * it keeps.
 *
 * ```ts
 * accepts({ name: "clientes.CSV", type: "" }, ".csv,text/csv"); // true
 * accepts({ name: "foto.png", type: "image/png" }, "image/*"); // true
 * ```
 */

/** What of a file these read: its name and its type. */
export type FileLike = { name: string; type: string };

/** Whether `accept` (the file field's: `.csv,text/csv`, `image/*`) takes a file; any, without one. */
export function accepts(file: FileLike, accept?: string): boolean {
  const wanted = (accept ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return wanted.some((want) => {
    if (want.startsWith(".")) return name.endsWith(want);
    if (want.endsWith("/*")) return type.startsWith(want.slice(0, -1));
    return type === want;
  });
}

/** The files a field keeps of those dropped on it: those it accepts, and only the first of them unless `multiple`. */
export function keptOf<F extends FileLike>(
  files: readonly F[],
  accept?: string,
  multiple?: boolean,
): F[] {
  const taken = files.filter((file) => accepts(file, accept));
  return multiple ? taken : taken.slice(0, 1);
}
