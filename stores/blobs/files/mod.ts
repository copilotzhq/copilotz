/**
 * Blobs as files in a directory, sharded by the first two hex digits of the
 * hash. Uses `node:fs`, which Node, Deno and Bun all provide.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { Blobs } from "../../../runtime/mod.ts";

const missing = (error: unknown) => (error as { code?: string }).code === "ENOENT";

export function fileBlobs(options: { dir: string }): Blobs {
  const path = (id: string) => `${options.dir}/${id.slice(7, 9)}/${id}`;
  return {
    async put({ id, data }) {
      const file = path(id);
      try {
        await stat(file);
        return; // Content-addressed: already there.
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      // Write then rename, so a reader never sees a partial file.
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, data);
      await rename(temp, file);
    },
    async get(id) {
      try {
        return { data: new Uint8Array(await readFile(path(id))) };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
  };
}
