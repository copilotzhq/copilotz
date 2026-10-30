/**
 * Where people download the computer program from (the `downloads`
 * resource): a release (`scripts/computer/build.ts` makes one: its install
 * scripts, a binary per platform, `manifest.json`), and its manifest. The
 * connect flow shows the install command and the binaries from it; a
 * computer older than it updates itself to it (`computer.ready`).
 *
 * `computerDownloads` gives an app both, as a plugin: a release folder of its
 * own, served from its origin at `/computer/download/` (a `routes` entry of
 * the web host: only the release's files, as they are), or one at a URL (a
 * GitHub release, a bucket), whose manifest it reads once, as it starts.
 *
 * ```ts
 * plugins: [...plugins, await computerDownloads({ dir: "dist/computer/1.0.0-rc.1" })]
 * plugins: [...plugins, await computerDownloads({ url: "https://github.com/…/releases/download/…/" })]
 * ```
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { definePlugin, type Plugin } from "../../../../runtime/mod.ts";
import { DOWNLOADS, type Manifest } from "../program/release.ts";

/**
 * What the resource says: where the release is (absolute, or on the app's
 * origin), and what's in it. The plugin's Actions read it by type alone, so
 * they never load this file's own (its Node built-ins).
 */
export type Downloads = { base: string; manifest: Manifest };

/** A manifest, checked for what everything reading it relies on. */
function checked(value: unknown, from: string): Manifest {
  const manifest = value as Manifest;
  const sound = typeof manifest?.version === "string" && Array.isArray(manifest.binaries) &&
    manifest.binaries.every((b) =>
      typeof b?.os === "string" && typeof b.arch === "string" &&
      /^[\w.-]+$/.test(b.file ?? "") && Number.isSafeInteger(b.size) &&
      /^[0-9a-f]{64}$/.test(b.sha256 ?? "")
    );
  if (!sound) throw new Error(`computerDownloads: ${from} isn't a computer release's manifest`);
  return manifest;
}

/** Serves the release in `dir`: its manifest, install scripts and binaries, nothing else. */
function serveRelease(dir: string, manifest: Manifest) {
  const binary = { type: "application/octet-stream", download: true };
  const text = { type: "text/plain; charset=utf-8", download: false };
  const files = new Map<string, { type: string; download: boolean; tag?: string }>([
    ["manifest.json", { type: "application/json", download: false }],
    ["install.sh", text],
    ["install.ps1", text],
    ...manifest.binaries.map((b) => [b.file, { ...binary, tag: `"${b.sha256}"` }] as const),
  ]);
  return async (request: Request): Promise<Response> => {
    const name = new URL(request.url).pathname.slice(DOWNLOADS.length);
    const file = files.get(name);
    const path = join(dir, name);
    const size = file && await stat(path).then((s) => s.size, () => undefined);
    if (!file || size === undefined) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    // Binaries are known by their hash; the rest is small, and asked for again each time.
    const headers: Record<string, string> = {
      "content-type": file.type,
      "content-length": String(size),
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      ...(file.tag ? { etag: file.tag } : {}),
      ...(file.download ? { "content-disposition": `attachment; filename="${name}"` } : {}),
    };
    if (file.tag && request.headers.get("if-none-match") === file.tag) {
      return new Response(null, { status: 304, headers });
    }
    const body = request.method === "HEAD"
      ? null
      : Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    return new Response(body, { headers });
  };
}

/** The app's downloads (see above), from a release folder of its own or at a URL. */
export async function computerDownloads(from: { dir: string } | { url: string }): Promise<Plugin> {
  if ("url" in from) {
    const base = from.url.endsWith("/") ? from.url : `${from.url}/`;
    const response = await fetch(new URL("manifest.json", base));
    if (!response.ok) {
      throw new Error(`computerDownloads: couldn't read ${base}manifest.json (${response.status})`);
    }
    const manifest = checked(await response.json(), `${base}manifest.json`);
    return definePlugin({
      name: "computer-downloads",
      requires: ["computers"],
      resources: { downloads: { base, manifest } satisfies Downloads },
    });
  }
  const dir = resolve(from.dir);
  const path = join(dir, "manifest.json");
  const manifest = checked(JSON.parse(await readFile(path, "utf8")), path);
  return definePlugin({
    name: "computer-downloads",
    requires: ["computers"],
    resources: {
      downloads: { base: DOWNLOADS, manifest } satisfies Downloads,
      routes: {
        "computer.downloads": {
          path: DOWNLOADS,
          methods: ["GET", "HEAD"],
          serve: serveRelease(dir, manifest),
        },
      },
    },
  });
}
