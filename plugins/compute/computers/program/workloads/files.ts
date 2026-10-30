/**
 * Files in a space's folder, and nowhere else: a path is relative, has no
 * `..`, and what it names (through any symlink) stays inside the folder.
 * Reads take 256 KiB unless asked for more, as UTF-8 text when it is text and
 * base64 when it isn't; writes replace a file whole; an edit replaces text
 * that occurs exactly once.
 */
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { Buffer } from "node:buffer";
import type {
  Entry,
  FilesEditInput,
  FilesListInput,
  FilesRead,
  FilesReadInput,
  FilesWriteInput,
  Written,
} from "../../shared/workloads.ts";
import { fail } from "./answer.ts";
import type { Spaces } from "./spaces.ts";

/** What a read takes unless asked for more, and the most it takes. */
const READ = 256 * 1024;
const MOST = 16 * 1024 * 1024;

/** A path's segments, refused if it's absolute or climbs out. */
export function segments(path: unknown, folderItself = false): string[] {
  if (path === undefined && folderItself) return [];
  if (typeof path !== "string" || path.includes("\0") || path.includes("\\")) {
    fail("path must be a relative path", "invalid_path");
  }
  if (path.startsWith("/")) {
    fail(`"${path}" is absolute: give a path inside the folder`, "invalid_path");
  }
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) fail(`"${path}" climbs out of the folder ("..")`, "invalid_path");
  if (!parts.length && !folderItself) fail("path must name a file", "invalid_path");
  return parts;
}

/** Whether `path` is the folder or inside it. */
const within = (folder: string, path: string) => path === folder || path.startsWith(folder + sep);
/** A path within a space's folder as the contract has it: "/" between its parts (Windows' too). */
const inside = (folder: string, path: string) => relative(folder, path).split(sep).join("/");

/** A Node error, as a failure the agent can act on. */
function explain(error: unknown, path: string): never {
  const code = (error as { code?: string })?.code;
  if (code === "ENOENT") fail(`No such file or folder: ${path}`, "not_found");
  if (code === "ENOTDIR") fail(`Not a folder on the way to ${path}`, "invalid_path");
  if (code === "EISDIR") fail(`${path} is a folder`, "invalid");
  if (code === "EACCES" || code === "EPERM") fail(`Not allowed: ${path}`, "denied");
  throw error;
}

/** What `parts` names, which must exist, as a real path inside the folder. */
export async function existing(folder: string, parts: string[], shown: string) {
  let real: string;
  try {
    real = await realpath(join(folder, ...parts));
  } catch (error) {
    explain(error, shown);
  }
  if (!within(folder, real)) fail(`${shown} leads outside the folder`, "invalid_path");
  return real;
}

/** Where a write of `parts` goes: the real file (through a symlink inside), or a new one. */
async function writable(folder: string, parts: string[], shown: string) {
  const target = join(folder, ...parts);
  const link = await lstat(target).catch(() => undefined);
  if (link) {
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      fail(`${shown} is a symlink to nowhere`, "invalid_path");
    }
    if (!within(folder, real)) fail(`${shown} leads outside the folder`, "invalid_path");
    return real;
  }
  // A new file: its nearest folder that's there must be inside, and so must what's made.
  let up = dirname(target);
  while (!(await lstat(up).catch(() => undefined))) up = dirname(up);
  const base = await realpath(up).catch((error) => explain(error, shown));
  if (!within(folder, base)) fail(`${shown} leads outside the folder`, "invalid_path");
  await mkdir(dirname(target), { recursive: true }).catch((error) => explain(error, shown));
  const parent = await realpath(dirname(target));
  if (!within(folder, parent)) fail(`${shown} leads outside the folder`, "invalid_path");
  return join(parent, basename(target));
}

/** Writes a file whole: a temporary file beside it, renamed over it, keeping its mode. */
async function replace(real: string, bytes: Uint8Array) {
  const mode = await stat(real).then((s) => s.mode & 0o7777, () => undefined);
  const temporary = join(dirname(real), `.${basename(real)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, real);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const strict = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 text without NULs, else undefined; a cut-off character at the end of a part read is left out. */
function text(bytes: Uint8Array, partial: boolean): string | undefined {
  if (bytes.includes(0)) return undefined;
  for (let cut = 0; cut <= (partial ? 3 : 0) && cut <= bytes.length; cut++) {
    try {
      return strict.decode(bytes.subarray(0, bytes.length - cut));
    } catch {
      // Try without the last byte or so: a character the read cut.
    }
  }
  return undefined;
}

/** The files of every space on this computer. */
export function createFiles(spaces: Spaces) {
  return {
    async list(input: FilesListInput): Promise<Entry[]> {
      const folder = await spaces.folder(input.scope);
      const parts = segments(input.path, true);
      const shown = parts.join("/") || ".";
      const dir = await existing(folder, parts, shown);
      const names = await readdir(dir).catch((error) => explain(error, shown));
      const entries = await Promise.all(names.map(async (name): Promise<Entry | undefined> => {
        const info = await lstat(join(dir, name)).catch(() => undefined);
        if (!info) return undefined;
        return {
          name,
          type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
          size: info.size,
          mtime: info.mtime.toISOString(),
        };
      }));
      return entries.filter((e) => e !== undefined).sort((a, b) => a.name.localeCompare(b.name));
    },

    async read(input: FilesReadInput): Promise<FilesRead> {
      const folder = await spaces.folder(input.scope);
      const parts = segments(input.path);
      const shown = parts.join("/");
      const offset = input.offset ?? 0;
      const length = input.length ?? READ;
      if (!Number.isInteger(offset) || offset < 0) fail("offset must be a whole number ≥ 0");
      if (!Number.isInteger(length) || length < 0 || length > MOST) {
        fail(`length must be a whole number from 0 to ${MOST}`);
      }
      const real = await existing(folder, parts, shown);
      const file = await open(real, "r").catch((error) => explain(error, shown));
      try {
        const info = await file.stat();
        if (!info.isFile()) fail(`${shown} isn't a file`);
        const bytes = Buffer.alloc(Math.max(0, Math.min(length, info.size - offset)));
        let read = 0;
        while (read < bytes.length) {
          const { bytesRead } = await file.read(bytes, read, bytes.length - read, offset + read);
          if (!bytesRead) break;
          read += bytesRead;
        }
        const got = bytes.subarray(0, read);
        const partial = offset + read < info.size;
        const decoded = text(got, partial);
        const used = decoded === undefined ? read : Buffer.byteLength(decoded);
        return decoded === undefined
          ? {
            content: got.toString("base64"),
            encoding: "base64",
            size: info.size,
            truncated: partial,
          }
          : {
            content: decoded,
            encoding: "utf8",
            size: info.size,
            truncated: offset + used < info.size,
          };
      } finally {
        await file.close();
      }
    },

    async write(input: FilesWriteInput): Promise<Written> {
      const folder = await spaces.folder(input.scope);
      const parts = segments(input.path);
      const shown = parts.join("/");
      if (typeof input.content !== "string") fail("content must be a string");
      const encoding = input.encoding ?? "utf8";
      if (encoding !== "utf8" && encoding !== "base64") fail('encoding is "utf8" or "base64"');
      const bytes = Buffer.from(input.content, encoding);
      const real = await writable(folder, parts, shown);
      if ((await stat(real).catch(() => undefined))?.isDirectory()) fail(`${shown} is a folder`);
      await replace(real, bytes).catch((error) => explain(error, shown));
      return { path: inside(folder, real), size: bytes.length };
    },

    async edit(input: FilesEditInput): Promise<Written> {
      const folder = await spaces.folder(input.scope);
      const parts = segments(input.path);
      const shown = parts.join("/");
      if (typeof input.old !== "string" || !input.old) fail("old must be the text to replace");
      if (typeof input.new !== "string") fail("new must be a string");
      const real = await existing(folder, parts, shown);
      const info = await stat(real);
      if (!info.isFile()) fail(`${shown} isn't a file`);
      const file = await open(real, "r");
      const content = text(await file.readFile().finally(() => file.close()), false);
      if (content === undefined) fail(`${shown} isn't a text file`);
      const at = content.indexOf(input.old);
      if (at < 0) fail(`The text to replace isn't in ${shown}`, "not_found");
      if (content.indexOf(input.old, at + 1) >= 0) {
        const times = content.split(input.old).length - 1;
        fail(
          `The text to replace occurs ${
            times > 1 ? `${times} times` : "more than once"
          } in ${shown}: ` +
            "give more of what's around it",
          "ambiguous",
        );
      }
      const bytes = Buffer.from(
        content.slice(0, at) + input.new + content.slice(at + input.old.length),
      );
      await replace(real, bytes);
      return { path: inside(folder, real), size: bytes.length };
    },
  };
}
