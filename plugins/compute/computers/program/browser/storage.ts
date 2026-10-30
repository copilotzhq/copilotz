/**
 * Uploads and downloads go through the space's folder: a path there is
 * relative, has no `..`, and passes through real folders only (no symlinks).
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { browserError } from "./async.ts";

/** A real directory, made (private) if it isn't there. */
export async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Browser state must be a real directory");
  }
}

/** `relative` under `root`: refused if it climbs out or passes a symlink; folders made to write it. */
export async function workspacePath(root: string, relative: string, write = false) {
  if (
    typeof relative !== "string" || !relative || relative.length > 1000 ||
    relative.includes("\\") || relative.includes("\0") || relative.startsWith("/")
  ) {
    throw browserError("invalid_path", "Expected a path relative to the space's folder");
  }
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw browserError("invalid_path", "Paths can't climb out of the space's folder");
  }
  let path = root;
  for (let i = 0; i < parts.length; i++) {
    path += `/${parts[i]}`;
    const last = i === parts.length - 1;
    const info = await lstat(path).catch((error) => {
      if (error?.code !== "ENOENT" || !write) throw error;
      return undefined;
    });
    if (!info) {
      if (!last) await directory(path);
      continue;
    }
    if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) {
      throw browserError("invalid_path", "Transfers need regular files and real folders");
    }
  }
  return path;
}

/** A copy of a file to upload, staged outside the space's folder. */
export async function stageUpload(root: string, relative: string, staging: string) {
  const source = await workspacePath(root, relative);
  const folder = `${staging}/${randomUUID()}`;
  await directory(folder);
  const destination = `${folder}/${relative.split("/").at(-1)}`;
  await copyFile(source, destination);
  await workspacePath(root, relative);
  return destination;
}

/** Moves a finished download into the space's folder. */
export async function commitDownload(root: string, relative: string, source: string) {
  const destination = await workspacePath(root, relative, true);
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    // Made new, so a symlink there isn't followed.
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await workspacePath(root, relative, true);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
