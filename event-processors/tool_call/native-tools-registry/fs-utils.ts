import { basename, dirname, relative, resolve } from "node:path";

export interface ResolvedWorkspacePath {
  cwd: string;
  inputPath: string;
  resolvedPath: string;
  relativePath: string;
}

export interface FileSnapshot {
  id: string;
  path: string;
  relativePath: string;
  createdAt: string;
  label?: string;
  content: string;
}

export interface ReadFileRangeOptions {
  startLine?: number;
  endLine?: number;
  includeLineNumbers?: boolean;
}

export interface ReadFileResult {
  path: string;
  relativePath: string;
  content: string;
  size: number;
  encoding: "utf8";
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export interface SearchCodeResult {
  path: string;
  relativePath: string;
  matches: Array<{
    line: number;
    column: number;
    text: string;
    match: string;
  }>;
}

export interface DiffHunk {
  type: "insert" | "delete" | "replace";
  startLineBefore: number;
  endLineBefore: number;
  startLineAfter: number;
  endLineAfter: number;
  before: string[];
  after: string[];
}

type DenoLike = {
  cwd?: () => string;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, content: string) => Promise<void>;
  mkdir?: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readDir?: (
    path: string,
  ) => AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }>;
  stat?: (path: string) => Promise<{
    isFile?: boolean;
    isDirectory?: boolean;
    size?: number;
    mtime?: Date | null;
  }>;
  remove?: (path: string) => Promise<void>;
  errors?: {
    NotFound?: { new (...args: unknown[]): Error };
    PermissionDenied?: { new (...args: unknown[]): Error };
  };
};

type FileVersionStore = Map<string, FileSnapshot[]>;

const GLOBAL_SNAPSHOT_KEY = "__copilotz_file_snapshots__";
const MAX_SNAPSHOTS_PER_FILE = 20;
const BINARY_BYTE_LIMIT = 200_000;

function getDeno(): DenoLike {
  const denoNs = (globalThis as unknown as { Deno?: DenoLike }).Deno;
  if (!denoNs?.cwd || !denoNs?.readTextFile || !denoNs?.writeTextFile) {
    throw new Error("This tool requires the Deno runtime");
  }
  return denoNs;
}

function getSnapshotStore(): FileVersionStore {
  const globalRecord = globalThis as Record<string, unknown>;
  const existing = globalRecord[GLOBAL_SNAPSHOT_KEY];
  if (existing instanceof Map) {
    return existing as FileVersionStore;
  }
  const created: FileVersionStore = new Map();
  globalRecord[GLOBAL_SNAPSHOT_KEY] = created;
  return created;
}

function normalizeWorkspaceRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isOutsideWorkspace(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.includes("/../");
}

export function resolveWorkspacePath(inputPath: string): ResolvedWorkspacePath {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new Error("A non-empty path is required");
  }
  if (inputPath.includes("~")) {
    throw new Error("Home-directory expansion is not supported");
  }

  const denoNs = getDeno();
  const cwd = denoNs.cwd!();
  const resolvedPath = resolve(cwd, inputPath);
  const relativePath = normalizeWorkspaceRelativePath(relative(cwd, resolvedPath));

  if (relativePath === "" || relativePath === ".") {
    return {
      cwd,
      inputPath,
      resolvedPath,
      relativePath: ".",
    };
  }

  if (isOutsideWorkspace(relativePath)) {
    throw new Error(
      `Path must stay inside the current workspace (${cwd})`,
    );
  }

  return {
    cwd,
    inputPath,
    resolvedPath,
    relativePath,
  };
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
}

function clampLine(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

export async function readWorkspaceFile(
  inputPath: string,
  options: ReadFileRangeOptions = {},
): Promise<ReadFileResult> {
  const denoNs = getDeno();
  const file = resolveWorkspacePath(inputPath);
  const content = await denoNs.readTextFile!(file.resolvedPath);
  const lines = content.split(/\r?\n/);
  const totalLines = countLines(content);
  const startLine = clampLine(options.startLine ?? 1, 1);
  const resolvedEndLine = options.endLine ?? totalLines ?? 1;
  const endLine = clampLine(resolvedEndLine, totalLines || 1);
  const safeStart = Math.min(startLine, totalLines || 1);
  const safeEnd = Math.max(safeStart, Math.min(endLine, totalLines || safeStart));
  const sliced = totalLines === 0
    ? []
    : lines.slice(safeStart - 1, safeEnd);
  const output = options.includeLineNumbers
    ? sliced.map((line, index) => `${safeStart + index}: ${line}`).join("\n")
    : sliced.join("\n");

  return {
    path: file.resolvedPath,
    relativePath: file.relativePath,
    content: output,
    size: content.length,
    encoding: "utf8",
    totalLines,
    startLine: safeStart,
    endLine: safeEnd,
    truncated: safeStart !== 1 || safeEnd !== (totalLines || safeEnd),
  };
}

export async function ensureSnapshot(
  inputPath: string,
  label?: string,
): Promise<FileSnapshot | null> {
  const denoNs = getDeno();
  const file = resolveWorkspacePath(inputPath);
  const store = getSnapshotStore();

  let content: string;
  try {
    content = await denoNs.readTextFile!(file.resolvedPath);
  } catch (error) {
    const notFound = denoNs.errors?.NotFound;
    if (notFound && error instanceof notFound) {
      return null;
    }
    throw error;
  }

  const snapshots = store.get(file.resolvedPath) ?? [];
  const latest = snapshots.at(-1);
  if (latest?.content === content) {
    return latest;
  }

  const snapshot: FileSnapshot = {
    id: crypto.randomUUID(),
    path: file.resolvedPath,
    relativePath: file.relativePath,
    createdAt: new Date().toISOString(),
    label,
    content,
  };

  snapshots.push(snapshot);
  if (snapshots.length > MAX_SNAPSHOTS_PER_FILE) {
    snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS_PER_FILE);
  }
  store.set(file.resolvedPath, snapshots);
  return snapshot;
}

export function listSnapshots(inputPath: string): FileSnapshot[] {
  const file = resolveWorkspacePath(inputPath);
  return [...(getSnapshotStore().get(file.resolvedPath) ?? [])];
}

export async function writeWorkspaceFile(
  inputPath: string,
  content: string,
  options: { createDirs?: boolean; snapshotLabel?: string } = {},
): Promise<{
  path: string;
  relativePath: string;
  size: number;
  snapshotId: string | null;
}> {
  const denoNs = getDeno();
  const file = resolveWorkspacePath(inputPath);
  const snapshot = await ensureSnapshot(inputPath, options.snapshotLabel);

  if (options.createDirs) {
    const folder = dirname(file.resolvedPath);
    if (folder && folder !== file.resolvedPath) {
      await denoNs.mkdir!(folder, { recursive: true });
    }
  }

  await denoNs.writeTextFile!(file.resolvedPath, content);
  return {
    path: file.resolvedPath,
    relativePath: file.relativePath,
    size: content.length,
    snapshotId: snapshot?.id ?? null,
  };
}

function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((segment) => segment.split("?").map(escapeRegex).join("."))
    .join(".*");
  return new RegExp(`^${source}$`, "i");
}

export async function listWorkspaceDirectory(
  inputPath = ".",
  options: { recursive?: boolean; showHidden?: boolean; maxDepth?: number } = {},
): Promise<{
  path: string;
  relativePath: string;
  entries: Array<{
    name: string;
    path: string;
    relativePath: string;
    type: "file" | "directory";
    size?: number;
  }>;
}> {
  const denoNs = getDeno();
  const root = resolveWorkspacePath(inputPath);
  const entries: Array<{
    name: string;
    path: string;
    relativePath: string;
    type: "file" | "directory";
    size?: number;
  }> = [];
  const maxDepth = Math.max(0, options.maxDepth ?? 3);

  const visit = async (absolutePath: string, depth: number): Promise<void> => {
    for await (const entry of denoNs.readDir!(absolutePath)) {
      if (!options.showHidden && entry.name.startsWith(".")) continue;
      const childPath = resolve(absolutePath, entry.name);
      const child = resolveWorkspacePath(childPath);
      const type = entry.isDirectory ? "directory" : "file";
      let size: number | undefined;

      if (type === "file" && denoNs.stat) {
        try {
          const stat = await denoNs.stat(child.resolvedPath);
          size = stat.size;
        } catch {
          size = undefined;
        }
      }

      entries.push({
        name: entry.name,
        path: child.resolvedPath,
        relativePath: child.relativePath,
        type,
        size,
      });

      if (entry.isDirectory && options.recursive && depth < maxDepth) {
        await visit(child.resolvedPath, depth + 1);
      }
    }
  };

  await visit(root.resolvedPath, 0);
  entries.sort((a, b) =>
    a.type === b.type
      ? a.relativePath.localeCompare(b.relativePath)
      : a.type === "directory"
      ? -1
      : 1
  );

  return {
    path: root.resolvedPath,
    relativePath: root.relativePath,
    entries,
  };
}

async function maybeReadSearchableText(path: string): Promise<string | null> {
  const denoNs = getDeno();
  const stat = denoNs.stat ? await denoNs.stat(path) : null;
  if (stat?.size && stat.size > BINARY_BYTE_LIMIT) {
    return null;
  }
  const content = await denoNs.readTextFile!(path);
  if (content.includes("\u0000")) {
    return null;
  }
  return content;
}

export async function searchWorkspaceCode(options: {
  query: string;
  directory?: string;
  filePattern?: string;
  caseSensitive?: boolean;
  isRegex?: boolean;
  includeHidden?: boolean;
  maxResults?: number;
  maxMatchesPerFile?: number;
}): Promise<{
  directory: string;
  query: string;
  regex: string;
  results: SearchCodeResult[];
}> {
  const denoNs = getDeno();
  const directory = resolveWorkspacePath(options.directory ?? ".");
  const regex = options.isRegex
    ? new RegExp(
      options.query,
      options.caseSensitive ? "g" : "gi",
    )
    : new RegExp(
      escapeRegex(options.query),
      options.caseSensitive ? "g" : "gi",
    );
  const filePattern = options.filePattern
    ? globToRegex(options.filePattern)
    : null;
  const maxResults = Math.max(1, options.maxResults ?? 25);
  const maxMatchesPerFile = Math.max(1, options.maxMatchesPerFile ?? 20);
  const results: SearchCodeResult[] = [];

  const visit = async (absolutePath: string): Promise<void> => {
    if (results.length >= maxResults) return;
    for await (const entry of denoNs.readDir!(absolutePath)) {
      if (!options.includeHidden && entry.name.startsWith(".")) continue;
      const childPath = resolve(absolutePath, entry.name);
      const child = resolveWorkspacePath(childPath);
      if (entry.isDirectory) {
        await visit(child.resolvedPath);
        if (results.length >= maxResults) return;
        continue;
      }
      if (filePattern && !filePattern.test(entry.name)) continue;

      let content: string | null = null;
      try {
        content = await maybeReadSearchableText(child.resolvedPath);
      } catch {
        content = null;
      }
      if (content == null) continue;

      const lines = content.split(/\r?\n/);
      const matches: SearchCodeResult["matches"] = [];
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
          matches.push({
            line: index + 1,
            column: match.index + 1,
            text: line,
            match: match[0] ?? "",
          });
          if (matches.length >= maxMatchesPerFile) break;
          if (match.index === regex.lastIndex) {
            regex.lastIndex += 1;
          }
        }
        if (matches.length >= maxMatchesPerFile) break;
      }

      if (matches.length > 0) {
        results.push({
          path: child.resolvedPath,
          relativePath: child.relativePath,
          matches,
        });
      }
      if (results.length >= maxResults) return;
    }
  };

  await visit(directory.resolvedPath);

  return {
    directory: directory.resolvedPath,
    query: options.query,
    regex: regex.source,
    results,
  };
}

function ensureAnchorOnce(
  content: string,
  anchor: string,
  operationName: string,
): number {
  const first = content.indexOf(anchor);
  if (first === -1) {
    throw new Error(`${operationName}: anchor not found`);
  }
  const second = content.indexOf(anchor, first + anchor.length);
  if (second !== -1) {
    throw new Error(`${operationName}: anchor matched more than once`);
  }
  return first;
}

function applyLineReplace(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string,
): string {
  const lines = content.split(/\r?\n/);
  const safeStart = clampLine(startLine, 1);
  const safeEnd = Math.max(safeStart, clampLine(endLine, safeStart));
  const before = lines.slice(0, safeStart - 1);
  const after = lines.slice(safeEnd);
  const replacementLines = replacement.split(/\r?\n/);
  return [...before, ...replacementLines, ...after].join("\n");
}

export type PatchOperation =
  | {
    type: "replace";
    oldText: string;
    newText: string;
    replaceAll?: boolean;
  }
  | {
    type: "insert_before";
    anchor: string;
    content: string;
  }
  | {
    type: "insert_after";
    anchor: string;
    content: string;
  }
  | {
    type: "replace_lines";
    startLine: number;
    endLine: number;
    content: string;
  }
  | {
    type: "delete_lines";
    startLine: number;
    endLine: number;
  };

export async function applyWorkspacePatch(
  inputPath: string,
  operations: PatchOperation[],
  snapshotLabel = "apply_patch",
): Promise<{
  path: string;
  relativePath: string;
  snapshotId: string | null;
  applied: number;
  size: number;
}> {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("At least one patch operation is required");
  }

  const current = await readWorkspaceFile(inputPath);
  let content = current.content;
  const snapshot = await ensureSnapshot(inputPath, snapshotLabel);

  for (const operation of operations) {
    switch (operation.type) {
      case "replace": {
        const count = content.split(operation.oldText).length - 1;
        if (count === 0) {
          throw new Error("replace: target text not found");
        }
        if (!operation.replaceAll && count > 1) {
          throw new Error("replace: target text matched more than once");
        }
        content = operation.replaceAll
          ? content.split(operation.oldText).join(operation.newText)
          : content.replace(operation.oldText, operation.newText);
        break;
      }
      case "insert_before": {
        const index = ensureAnchorOnce(content, operation.anchor, "insert_before");
        content = `${content.slice(0, index)}${operation.content}${content.slice(index)}`;
        break;
      }
      case "insert_after": {
        const index = ensureAnchorOnce(content, operation.anchor, "insert_after");
        const insertAt = index + operation.anchor.length;
        content = `${content.slice(0, insertAt)}${operation.content}${content.slice(insertAt)}`;
        break;
      }
      case "replace_lines": {
        content = applyLineReplace(
          content,
          operation.startLine,
          operation.endLine,
          operation.content,
        );
        break;
      }
      case "delete_lines": {
        content = applyLineReplace(
          content,
          operation.startLine,
          operation.endLine,
          "",
        );
        break;
      }
      default:
        throw new Error(`Unsupported patch operation: ${(operation as { type: string }).type}`);
    }
  }

  const written = await writeWorkspaceFile(inputPath, content, {
    snapshotLabel,
    createDirs: false,
  });

  return {
    path: written.path,
    relativePath: written.relativePath,
    snapshotId: written.snapshotId ?? snapshot?.id ?? null,
    applied: operations.length,
    size: written.size,
  };
}

type DiffOp =
  | { kind: "equal"; line: string }
  | { kind: "insert"; line: string }
  | { kind: "delete"; line: string };

function diffLines(before: string[], after: string[]): DiffOp[] {
  const total = before.length * after.length;
  if (total > 160_000) {
    const prefix: DiffOp[] = [];
    let start = 0;
    while (
      start < before.length &&
      start < after.length &&
      before[start] === after[start]
    ) {
      prefix.push({ kind: "equal", line: before[start] ?? "" });
      start++;
    }

    const suffix: DiffOp[] = [];
    let beforeEnd = before.length - 1;
    let afterEnd = after.length - 1;
    while (
      beforeEnd >= start &&
      afterEnd >= start &&
      before[beforeEnd] === after[afterEnd]
    ) {
      suffix.unshift({ kind: "equal", line: before[beforeEnd] ?? "" });
      beforeEnd--;
      afterEnd--;
    }

    const middle: DiffOp[] = [];
    for (let i = start; i <= beforeEnd; i++) {
      middle.push({ kind: "delete", line: before[i] ?? "" });
    }
    for (let i = start; i <= afterEnd; i++) {
      middle.push({ kind: "insert", line: after[i] ?? "" });
    }
    return [...prefix, ...middle, ...suffix];
  }

  const dp: number[][] = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0)
  );

  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: "equal", line: before[i] ?? "" });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "delete", line: before[i] ?? "" });
      i++;
    } else {
      ops.push({ kind: "insert", line: after[j] ?? "" });
      j++;
    }
  }
  while (i < before.length) {
    ops.push({ kind: "delete", line: before[i] ?? "" });
    i++;
  }
  while (j < after.length) {
    ops.push({ kind: "insert", line: after[j] ?? "" });
    j++;
  }
  return ops;
}

function buildDiffHunks(beforeText: string, afterText: string): DiffHunk[] {
  const before = beforeText.split(/\r?\n/);
  const after = afterText.split(/\r?\n/);
  const ops = diffLines(before, after);
  const hunks: DiffHunk[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let current: DiffHunk | null = null;

  const flush = () => {
    if (!current) return;
    if (current.before.length === 0 && current.after.length > 0) {
      current.type = "insert";
      current.endLineBefore = current.startLineBefore - 1;
    } else if (current.before.length > 0 && current.after.length === 0) {
      current.type = "delete";
      current.endLineAfter = current.startLineAfter - 1;
    } else {
      current.type = "replace";
    }
    hunks.push(current);
    current = null;
  };

  for (const op of ops) {
    if (op.kind === "equal") {
      flush();
      beforeLine += 1;
      afterLine += 1;
      continue;
    }

    if (!current) {
      current = {
        type: "replace",
        startLineBefore: beforeLine,
        endLineBefore: beforeLine,
        startLineAfter: afterLine,
        endLineAfter: afterLine,
        before: [],
        after: [],
      };
    }

    if (op.kind === "delete") {
      current.before.push(op.line);
      current.endLineBefore = beforeLine;
      beforeLine += 1;
    } else {
      current.after.push(op.line);
      current.endLineAfter = afterLine;
      afterLine += 1;
    }
  }

  flush();
  return hunks;
}

export async function getWorkspaceFileDiff(
  inputPath: string,
  snapshotId?: string,
): Promise<{
  path: string;
  relativePath: string;
  snapshotId: string;
  changed: boolean;
  beforeLabel: string;
  afterLabel: string;
  hunks: DiffHunk[];
}> {
  const file = resolveWorkspacePath(inputPath);
  const snapshots = listSnapshots(inputPath);
  if (snapshots.length === 0) {
    throw new Error(`No snapshots available for ${file.relativePath}`);
  }

  const snapshot = snapshotId
    ? snapshots.find((entry) => entry.id === snapshotId)
    : snapshots.at(-1);
  if (!snapshot) {
    throw new Error(`Snapshot not found for ${file.relativePath}`);
  }

  const current = await readWorkspaceFile(inputPath);
  const hunks = buildDiffHunks(snapshot.content, current.content);

  return {
    path: file.resolvedPath,
    relativePath: file.relativePath,
    snapshotId: snapshot.id,
    changed: snapshot.content !== current.content,
    beforeLabel: snapshot.label ?? `snapshot ${snapshot.id}`,
    afterLabel: "current",
    hunks,
  };
}

export async function restoreWorkspaceFileVersion(
  inputPath: string,
  snapshotId?: string,
): Promise<{
  path: string;
  relativePath: string;
  restoredFromSnapshotId: string;
  size: number;
}> {
  const file = resolveWorkspacePath(inputPath);
  const snapshots = listSnapshots(inputPath);
  if (snapshots.length === 0) {
    throw new Error(`No snapshots available for ${file.relativePath}`);
  }
  const snapshot = snapshotId
    ? snapshots.find((entry) => entry.id === snapshotId)
    : snapshots.at(-1);
  if (!snapshot) {
    throw new Error(`Snapshot not found for ${file.relativePath}`);
  }

  await writeWorkspaceFile(inputPath, snapshot.content, {
    snapshotLabel: `restore:${snapshot.id}`,
  });

  return {
    path: file.resolvedPath,
    relativePath: file.relativePath,
    restoredFromSnapshotId: snapshot.id,
    size: snapshot.content.length,
  };
}

export function summarizePatchOperations(operations: PatchOperation[]): string {
  return operations.map((operation) => {
    switch (operation.type) {
      case "replace":
        return `replace "${operation.oldText.slice(0, 40)}"`;
      case "insert_before":
        return `insert before "${operation.anchor.slice(0, 40)}"`;
      case "insert_after":
        return `insert after "${operation.anchor.slice(0, 40)}"`;
      case "replace_lines":
        return `replace lines ${operation.startLine}-${operation.endLine}`;
      case "delete_lines":
        return `delete lines ${operation.startLine}-${operation.endLine}`;
      default:
        return "unknown operation";
    }
  }).join(", ");
}

export function describeWorkspacePath(inputPath: string): {
  path: string;
  relativePath: string;
  cwd: string;
  fileName: string;
} {
  const file = resolveWorkspacePath(inputPath);
  return {
    path: file.resolvedPath,
    relativePath: file.relativePath,
    cwd: file.cwd,
    fileName: basename(file.resolvedPath),
  };
}
