import type {
  BodyFilesystemAccess,
  BodyMaintenanceDeleteInput,
  PutBodyInput,
  ReadyBodyHead,
} from "../../content/index.ts";
import {
  bodyHasBeenIdle,
  bodyProtectionRemainingMs,
  latestBodyProtectionUntil,
} from "../../content/body-store.ts";
import { createContentError } from "../../content/errors.ts";

/** Process-wide fence matching the filesystem deployment's declared reach. */
const readyBodyLocks = new Map<string, Promise<void>>();

const READY_ROOT = ".copilotz-ready-v1";
const READY_STATE = "state.json";
const READY_PROTOCOL = 1;

type ReadyBodyFaultPoint =
  | "create:data-synced"
  | "create:manifest-staged"
  | "create:manifest-published"
  | "renew:manifest-staged"
  | "renew:manifest-published"
  | "delete:tombstone-staged"
  | "delete:tombstone-published"
  | "delete:data-removed"
  | "delete:tombstone-removed";

type DenoAssetFilesystemOptions = Readonly<{
  /** @internal Deterministic process-stop injection for protocol tests. */
  fault?: (
    point: ReadyBodyFaultPoint,
    bodyId: string,
  ) => void | Promise<void>;
}>;

type ReadyManifest = Readonly<{
  protocol: typeof READY_PROTOCOL;
  state: "ready";
  bodyId: string;
  dataId: string;
  byteLength: number;
  mediaType: string;
  digest: `sha256:${string}`;
  maintenanceVersion: number;
  protectedUntil?: string;
  etag?: string;
  lastModified?: string;
}>;

type DeleteManifest = Readonly<{
  protocol: typeof READY_PROTOCOL;
  state: "deleting";
  bodyId: string;
  dataId: string;
}>;

type ReadyBodyManifest = ReadyManifest | DeleteManifest;

type ReadyBodyState = Readonly<{
  directory: string;
  dataPath: string;
  manifest: ReadyManifest;
  head: ReadyBodyHead;
}>;

async function withReadyBodyLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = readyBodyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  readyBodyLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (readyBodyLocks.get(key) === current) readyBodyLocks.delete(key);
  }
}

function normalizeRoot(root: string): string {
  const normalized = root.replace(/\/+$/, "");
  if (!normalized) {
    throw new TypeError("Filesystem asset root must be non-empty.");
  }
  return normalized;
}

function validateKey(key: string): void {
  if (
    !key || key.startsWith("/") ||
    key.split("/").some((part) => part === "..")
  ) {
    throw new TypeError(
      "Filesystem asset key must be non-empty, relative, and cannot traverse parents.",
    );
  }
}

function safePath(root: string, key: string): string {
  const normalizedRoot = normalizeRoot(root);
  validateKey(key);
  return `${normalizedRoot}/${key}`;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : ".";
}

function stateRoot(root: string): string {
  return `${normalizeRoot(root)}/${READY_ROOT}`;
}

async function readyDirectory(root: string, bodyId: string): Promise<string> {
  validateKey(bodyId);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyId)),
  );
  const key = [...digest].map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${stateRoot(root)}/${key}`;
}

function statePath(directory: string): string {
  return `${directory}/${READY_STATE}`;
}

function dataPath(directory: string, dataId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(dataId)) {
    throw createContentError(
      "asset_corrupted",
      "Filesystem body manifest contains an invalid data generation.",
    );
  }
  return `${directory}/data-${dataId}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function removeIfPresent(
  path: string,
  options?: Deno.RemoveOptions,
): Promise<void> {
  await Deno.remove(path, options).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await Deno.open(path, { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const parent = parentPath(path);
  await Deno.mkdir(path, { recursive: true });
  await syncDirectory(path);
  if (await pathExists(parent)) await syncDirectory(parent);
}

async function removeReadyDirectory(directory: string): Promise<void> {
  const parent = parentPath(directory);
  await removeIfPresent(directory, { recursive: true });
  if (await pathExists(parent)) await syncDirectory(parent);
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await file.write(bytes.subarray(offset));
  }
}

async function writeRawFileAtomically(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(temporary, { createNew: true, write: true });
    await writeAll(file, bytes);
    await file.sync();
    file.close();
    file = undefined;
    await syncDirectory(parentPath(path));
    await Deno.rename(temporary, path);
    await syncDirectory(parentPath(path));
  } finally {
    file?.close();
    await removeIfPresent(temporary);
  }
}

function parseManifest(value: string): ReadyBodyManifest {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw createContentError(
      "asset_corrupted",
      "Filesystem body manifest is not valid JSON.",
    );
  }
  if (
    parsed.protocol !== READY_PROTOCOL ||
    (parsed.state !== "ready" && parsed.state !== "deleting") ||
    typeof parsed.bodyId !== "string" || !parsed.bodyId ||
    typeof parsed.dataId !== "string"
  ) {
    throw createContentError(
      "asset_corrupted",
      "Filesystem body manifest has an invalid protocol state.",
    );
  }
  dataPath(".", parsed.dataId);
  if (parsed.state === "deleting") {
    return Object.freeze({
      protocol: READY_PROTOCOL,
      state: "deleting",
      bodyId: parsed.bodyId,
      dataId: parsed.dataId,
    });
  }
  if (
    !Number.isSafeInteger(parsed.byteLength) ||
    (parsed.byteLength as number) < 0 ||
    typeof parsed.mediaType !== "string" || !parsed.mediaType ||
    typeof parsed.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(parsed.digest) ||
    !Number.isSafeInteger(parsed.maintenanceVersion) ||
    (parsed.maintenanceVersion as number) < 1 ||
    (parsed.protectedUntil !== undefined &&
      (typeof parsed.protectedUntil !== "string" ||
        !Number.isFinite(Date.parse(parsed.protectedUntil)))) ||
    (parsed.lastModified !== undefined &&
      (typeof parsed.lastModified !== "string" ||
        !Number.isFinite(Date.parse(parsed.lastModified))))
  ) {
    throw createContentError(
      "asset_corrupted",
      "Filesystem Ready Body manifest has invalid canonical metadata.",
    );
  }
  return Object.freeze({
    protocol: READY_PROTOCOL,
    state: "ready",
    bodyId: parsed.bodyId,
    dataId: parsed.dataId,
    byteLength: parsed.byteLength as number,
    mediaType: parsed.mediaType,
    digest: parsed.digest as `sha256:${string}`,
    maintenanceVersion: parsed.maintenanceVersion as number,
    ...(typeof parsed.protectedUntil === "string"
      ? { protectedUntil: parsed.protectedUntil }
      : {}),
    ...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}),
    ...(typeof parsed.lastModified === "string"
      ? { lastModified: parsed.lastModified }
      : {}),
  });
}

async function readManifest(
  directory: string,
): Promise<ReadyBodyManifest | null> {
  try {
    return parseManifest(await Deno.readTextFile(statePath(directory)));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function encodeManifest(manifest: ReadyBodyManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

async function publishManifest(
  directory: string,
  manifest: ReadyBodyManifest,
  staged: ReadyBodyFaultPoint,
  published: ReadyBodyFaultPoint,
  options: DenoAssetFilesystemOptions,
): Promise<void> {
  const temporary = `${directory}/state-${crypto.randomUUID()}.tmp`;
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(temporary, { createNew: true, write: true });
    await writeAll(file, encodeManifest(manifest));
    await file.sync();
  } finally {
    file?.close();
  }
  await syncDirectory(directory);
  await options.fault?.(staged, manifest.bodyId);
  await Deno.rename(temporary, statePath(directory));
  await syncDirectory(directory);
  await options.fault?.(published, manifest.bodyId);
}

async function cleanupReadyDirectory(
  directory: string,
  keepDataId: string,
): Promise<void> {
  const keep = new Set([READY_STATE, `data-${keepDataId}`]);
  for await (const entry of Deno.readDir(directory)) {
    if (!keep.has(entry.name)) {
      await removeIfPresent(`${directory}/${entry.name}`, {
        recursive: entry.isDirectory,
      });
    }
  }
  await syncDirectory(directory);
}

async function recoverReadyBody(
  root: string,
  directory: string,
  expectedBodyId?: string,
): Promise<ReadyBodyState | null> {
  const manifest = await readManifest(directory);
  if (!manifest) {
    await removeReadyDirectory(directory);
    return null;
  }
  const canonicalDirectory = await readyDirectory(root, manifest.bodyId);
  if (
    canonicalDirectory !== directory ||
    (expectedBodyId !== undefined && manifest.bodyId !== expectedBodyId)
  ) {
    throw createContentError(
      "asset_corrupted",
      "Filesystem body manifest does not match its canonical storage key.",
    );
  }
  if (manifest.state === "deleting") {
    await removeReadyDirectory(directory);
    return null;
  }
  const path = dataPath(directory, manifest.dataId);
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    throw createContentError(
      "asset_corrupted",
      "Filesystem Ready Body manifest references missing bytes.",
    );
  }
  if (!stat.isFile || stat.size !== manifest.byteLength) {
    throw createContentError(
      "asset_corrupted",
      "Filesystem Ready Body bytes do not match the canonical manifest.",
    );
  }
  await cleanupReadyDirectory(directory, manifest.dataId);
  const head = Object.freeze({
    bodyId: manifest.bodyId,
    state: "ready" as const,
    byteLength: manifest.byteLength,
    mediaType: manifest.mediaType,
    digest: manifest.digest,
    maintenanceVersion: manifest.maintenanceVersion,
    ...(manifest.protectedUntil
      ? { protectedUntil: manifest.protectedUntil }
      : {}),
    ...(manifest.etag ? { etag: manifest.etag } : {}),
    ...(manifest.lastModified ? { lastModified: manifest.lastModified } : {}),
  });
  return Object.freeze({ directory, dataPath: path, manifest, head });
}

async function writeReadyData(
  directory: string,
  dataId: string,
  bytes: Uint8Array,
): Promise<void> {
  const path = dataPath(directory, dataId);
  const file = await Deno.open(path, { createNew: true, write: true });
  try {
    await writeAll(file, bytes);
    await file.sync();
  } finally {
    file.close();
  }
  await syncDirectory(directory);
}

function createDenoAssetFilesystem(
  root: string,
  options: DenoAssetFilesystemOptions = {},
): BodyFilesystemAccess {
  const normalizedRoot = normalizeRoot(root);
  const acquireReady = async (
    input: PutBodyInput & Readonly<{ protectedUntil: string }>,
  ): Promise<ReadyBodyHead> => {
    const directory = await readyDirectory(normalizedRoot, input.bodyId);
    await ensureDirectory(stateRoot(normalizedRoot));
    return await withReadyBodyLock(directory, async () => {
      const existing = await recoverReadyBody(
        normalizedRoot,
        directory,
        input.bodyId,
      );
      if (existing) {
        if (
          existing.head.byteLength !== input.bytes.byteLength ||
          existing.head.mediaType !== input.mediaType ||
          existing.head.digest !== input.digest
        ) {
          throw createContentError(
            "asset_conflict",
            "Stored filesystem body conflicts with the canonical metadata.",
          );
        }
        const now = new Date().toISOString();
        const renewed: ReadyManifest = Object.freeze({
          ...existing.manifest,
          maintenanceVersion: existing.head.maintenanceVersion + 1,
          protectedUntil: latestBodyProtectionUntil(
            existing.head.protectedUntil,
            input.protectedUntil,
          ),
          lastModified: now,
        });
        await publishManifest(
          directory,
          renewed,
          "renew:manifest-staged",
          "renew:manifest-published",
          options,
        );
        return (await recoverReadyBody(
          normalizedRoot,
          directory,
          input.bodyId,
        ))!.head;
      }

      await ensureDirectory(directory);
      const dataId = crypto.randomUUID();
      const now = new Date().toISOString();
      const created: ReadyManifest = Object.freeze({
        protocol: READY_PROTOCOL,
        state: "ready",
        bodyId: input.bodyId,
        dataId,
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        digest: input.digest,
        maintenanceVersion: 1,
        protectedUntil: input.protectedUntil,
        etag: input.digest.slice("sha256:".length),
        lastModified: now,
      });
      await writeReadyData(directory, dataId, input.bytes);
      await options.fault?.("create:data-synced", input.bodyId);
      await publishManifest(
        directory,
        created,
        "create:manifest-staged",
        "create:manifest-published",
        options,
      );
      return (await recoverReadyBody(
        normalizedRoot,
        directory,
        input.bodyId,
      ))!.head;
    });
  };

  const readReady = async (bodyId: string): Promise<ReadyBodyState | null> => {
    const directory = await readyDirectory(normalizedRoot, bodyId);
    return await withReadyBodyLock(
      directory,
      () => recoverReadyBody(normalizedRoot, directory, bodyId),
    );
  };

  const openReady = async (
    bodyId: string,
    offset = 0,
  ): Promise<ReadableStream<Uint8Array>> => {
    const directory = await readyDirectory(normalizedRoot, bodyId);
    return await withReadyBodyLock(directory, async () => {
      const ready = await recoverReadyBody(
        normalizedRoot,
        directory,
        bodyId,
      );
      if (!ready) {
        throw createContentError(
          "asset_not_found",
          "Body was not found in the configured filesystem backend.",
        );
      }
      const file = await Deno.open(ready.dataPath, { read: true });
      if (offset > 0) await file.seek(offset, Deno.SeekMode.Start);
      return file.readable;
    });
  };

  const access: BodyFilesystemAccess = {
    acquireReady,
    async deleteReady(input: BodyMaintenanceDeleteInput) {
      if (input.expectedState !== "ready") return false;
      const directory = await readyDirectory(normalizedRoot, input.bodyId);
      return await withReadyBodyLock(directory, async () => {
        const ready = await recoverReadyBody(
          normalizedRoot,
          directory,
          input.bodyId,
        );
        if (
          !ready ||
          ready.head.maintenanceVersion !==
            input.expectedMaintenanceVersion ||
          bodyProtectionRemainingMs(ready.head.protectedUntil) > 0 ||
          !bodyHasBeenIdle(ready.head.lastModified, input.idleForMs)
        ) {
          return false;
        }
        const tombstone: DeleteManifest = Object.freeze({
          protocol: READY_PROTOCOL,
          state: "deleting",
          bodyId: input.bodyId,
          dataId: ready.manifest.dataId,
        });
        await publishManifest(
          directory,
          tombstone,
          "delete:tombstone-staged",
          "delete:tombstone-published",
          options,
        );
        await removeIfPresent(ready.dataPath);
        await syncDirectory(directory);
        await options.fault?.("delete:data-removed", input.bodyId);
        await removeIfPresent(statePath(directory));
        await syncDirectory(directory);
        await options.fault?.("delete:tombstone-removed", input.bodyId);
        await removeReadyDirectory(directory);
        return true;
      });
    },
    async writeExclusive(input: PutBodyInput) {
      const path = safePath(normalizedRoot, input.bodyId);
      await ensureDirectory(parentPath(path));
      let file: Deno.FsFile;
      try {
        file = await Deno.open(path, { createNew: true, write: true });
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) return "exists";
        throw error;
      }
      try {
        await writeAll(file, input.bytes);
        await file.sync();
      } catch (error) {
        await removeIfPresent(path);
        throw error;
      } finally {
        file.close();
      }
      await syncDirectory(parentPath(path));
      return "created";
    },
    async writeReplace(input) {
      const path = safePath(normalizedRoot, input.bodyId);
      await ensureDirectory(parentPath(path));
      await writeRawFileAtomically(path, input.bytes);
    },
    async append(input) {
      const path = safePath(normalizedRoot, input.bodyId);
      await ensureDirectory(parentPath(path));
      const file = await Deno.open(path, {
        create: true,
        write: true,
        append: true,
      });
      try {
        await writeAll(file, input.bytes);
        await file.sync();
        return (await file.stat()).size;
      } finally {
        file.close();
        await syncDirectory(parentPath(path));
      }
    },
    async stat(key) {
      return (await readReady(key))?.head ?? null;
    },
    read: (key) => Deno.readFile(safePath(normalizedRoot, key)),
    open: async (key) => {
      const file = await Deno.open(safePath(normalizedRoot, key), {
        read: true,
      });
      return file.readable;
    },
    async openFrom(key, offset) {
      const file = await Deno.open(safePath(normalizedRoot, key), {
        read: true,
      });
      if (offset > 0) await file.seek(offset, Deno.SeekMode.Start);
      return file.readable;
    },
    openReady: (key) => openReady(key),
    openReadyFrom: (key, offset) => openReady(key, offset),
    async delete(key) {
      const path = safePath(normalizedRoot, key);
      await removeIfPresent(path);
      if (await pathExists(parentPath(path))) {
        await syncDirectory(parentPath(path));
      }
    },
    async *listProgressive() {
      const entries: { bodyId: string; lastModified?: string }[] = [];
      const walk = async (
        directory: string,
        relative: string,
      ): Promise<void> => {
        const children: Deno.DirEntry[] = [];
        try {
          for await (const child of Deno.readDir(directory)) {
            children.push(child);
          }
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          if (!relative && child.name === READY_ROOT) continue;
          const childRelative = relative
            ? `${relative}/${child.name}`
            : child.name;
          const path = `${directory}/${child.name}`;
          if (child.isDirectory) {
            await walk(path, childRelative);
            continue;
          }
          if (!child.isFile || !childRelative.endsWith(".progressive.json")) {
            continue;
          }
          const bodyId = childRelative.slice(
            0,
            -".progressive.json".length,
          );
          if (!bodyId) continue;
          let stat: Deno.FileInfo;
          try {
            stat = await Deno.stat(path);
          } catch (error) {
            if (isNotFound(error)) continue;
            throw error;
          }
          entries.push({
            bodyId,
            ...(stat.mtime ? { lastModified: stat.mtime.toISOString() } : {}),
          });
        }
      };
      await walk(normalizedRoot, "");
      entries.sort((left, right) => left.bodyId.localeCompare(right.bodyId));
      for (const entry of entries) yield Object.freeze(entry);
    },
    async cleanupProgressive(bodyId) {
      const data = safePath(normalizedRoot, `${bodyId}.progressive`);
      const metadata = safePath(normalizedRoot, `${bodyId}.progressive.json`);
      const directory = parentPath(metadata);
      await removeIfPresent(data);
      if (await pathExists(directory)) {
        const temporaryPrefix = `${metadata.slice(directory.length + 1)}.`;
        try {
          for await (const entry of Deno.readDir(directory)) {
            if (
              entry.isFile && entry.name.startsWith(temporaryPrefix) &&
              entry.name.endsWith(".tmp")
            ) {
              await removeIfPresent(`${directory}/${entry.name}`);
            }
          }
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      // Metadata is the visibility authority and is deliberately removed last.
      await removeIfPresent(metadata);
      if (await pathExists(directory)) await syncDirectory(directory);
    },
    async *list(prefix) {
      const rootPath = stateRoot(normalizedRoot);
      let entries: Deno.DirEntry[];
      try {
        entries = [];
        for await (const entry of Deno.readDir(rootPath)) entries.push(entry);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const directory = `${rootPath}/${entry.name}`;
        if (!entry.isDirectory || !/^[0-9a-f]{64}$/.test(entry.name)) {
          continue;
        }
        const ready = await withReadyBodyLock(
          directory,
          () => recoverReadyBody(normalizedRoot, directory),
        );
        if (ready?.head.bodyId.startsWith(prefix)) yield ready.head;
      }
    },
  };
  return Object.freeze(access);
}

/** Deno host capability for declarative filesystem asset storage. */
export function denoAssetFilesystem(root: string): BodyFilesystemAccess {
  return createDenoAssetFilesystem(root);
}

/** @internal Deterministic process-stop injection used only by protocol tests. */
export const denoAssetFilesystemTesting = Object.freeze({
  create(
    root: string,
    fault: NonNullable<DenoAssetFilesystemOptions["fault"]>,
  ): BodyFilesystemAccess {
    return createDenoAssetFilesystem(root, { fault });
  },
});
