import type {
  BodyFilesystemAccess,
  BodyHead,
  PutBodyInput,
} from "../../content/index.ts";

function safePath(root: string, key: string): string {
  const normalizedRoot = root.replace(/\/$/, "");
  if (!normalizedRoot) {
    throw new TypeError("Filesystem asset root must be non-empty.");
  }
  if (key.startsWith("/") || key.split("/").some((part) => part === "..")) {
    throw new TypeError(
      "Filesystem asset key must be relative and cannot traverse parents.",
    );
  }
  return `${normalizedRoot}/${key}`;
}

function metadataPath(path: string): string {
  return `${path}.copilotz.json`;
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await file.write(bytes.subarray(offset));
  }
}

/** Deno host capability for declarative filesystem asset storage. */
export function denoAssetFilesystem(
  root: string,
): BodyFilesystemAccess {
  const readHead = async (path: string): Promise<BodyHead | null> => {
    try {
      const [stat, metadata] = await Promise.all([
        Deno.stat(path),
        Deno.readTextFile(metadataPath(path)).then(JSON.parse) as Promise<
          Record<string, unknown>
        >,
      ]);
      return Object.freeze({
        bodyId: String(metadata.bodyId),
        state: "ready" as const,
        byteLength: stat.size,
        mediaType: String(metadata.mediaType),
        digest: String(metadata.digest) as `sha256:${string}`,
        maintenanceVersion: typeof metadata.maintenanceVersion === "number"
          ? metadata.maintenanceVersion
          : 1,
        ...(typeof metadata.protectedUntil === "string"
          ? { protectedUntil: metadata.protectedUntil }
          : {}),
        ...(typeof metadata.etag === "string" ? { etag: metadata.etag } : {}),
        ...(stat.mtime ? { lastModified: stat.mtime.toISOString() } : {}),
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
  const access: BodyFilesystemAccess = {
    async writeExclusive(input: PutBodyInput) {
      const path = safePath(root, input.bodyId);
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
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
        await Deno.remove(path).catch(() => undefined);
        throw error;
      } finally {
        file.close();
      }
      try {
        await Deno.writeTextFile(
          metadataPath(path),
          JSON.stringify({
            bodyId: input.bodyId,
            mediaType: input.mediaType,
            digest: input.digest,
            maintenanceVersion: 1,
            protectedUntil: input.protectedUntil ?? new Date().toISOString(),
            etag: input.digest.slice("sha256:".length),
          }),
          { createNew: true },
        );
      } catch (error) {
        await Deno.remove(path).catch(() => undefined);
        throw error;
      }
      return "created";
    },
    async writeReplace(input) {
      const path = safePath(root, input.bodyId);
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeFile(path, input.bytes);
    },
    async append(input) {
      const path = safePath(root, input.bodyId);
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
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
      }
    },
    stat: (key) => readHead(safePath(root, key)),
    read: (key) => Deno.readFile(safePath(root, key)),
    async open(key) {
      const file = await Deno.open(safePath(root, key), { read: true });
      return file.readable;
    },
    async openFrom(key, offset) {
      const file = await Deno.open(safePath(root, key), { read: true });
      if (offset > 0) await file.seek(offset, Deno.SeekMode.Start);
      return file.readable;
    },
    async delete(key) {
      const path = safePath(root, key);
      await Promise.all([
        Deno.remove(path).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }),
        Deno.remove(metadataPath(path)).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }),
      ]);
    },
    async *list(prefix) {
      const rootPath = safePath(root, prefix);
      const walk = async function* (
        directory: string,
      ): AsyncGenerator<BodyHead> {
        let entries: Deno.DirEntry[];
        try {
          entries = [];
          for await (const entry of Deno.readDir(directory)) {
            entries.push(entry);
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return;
          throw error;
        }
        for (const entry of entries) {
          const path = `${directory}/${entry.name}`;
          if (entry.isDirectory) yield* walk(path);
          else if (entry.isFile && !entry.name.endsWith(".copilotz.json")) {
            const head = await readHead(path);
            if (head) yield head;
          }
        }
      };
      yield* walk(rootPath);
    },
  };
  return Object.freeze(access);
}
