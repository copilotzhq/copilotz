/**
 * The computer's files: listed, read, written and edited in a space's folder,
 * and nowhere else (no `..`, no absolute paths, no symlinks leading out). A
 * file put from bytes streamed in (an upload): written as they come, never
 * left half-written. A large file written whole, as an agent's `save_file`
 * sends one (base64 in one JSON value), through the connection as it is.
 */
import { assert, assertEquals } from "@std/assert";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import process from "node:process";
import { join } from "node:path";
import { tempDir, test } from "../../../testing/mod.ts";
import {
  type Entry,
  type FilesPutHead,
  type FilesRead,
  MOST_PUT,
  type Scope,
  WORK,
} from "../computers/shared/workloads.ts";
import { headed } from "../computers/shared/streams.ts";
import { type Setup, setup } from "./program-setup.ts";

const scope = (folder = "alpha"): Scope => ({ space: `space-${folder}`, folder, who: "agent:a" });
type Failed = { error: { code: string; message: string } };

test("files are written, listed, read and edited in the space's folder", async () => {
  await setup(async ({ work, root }) => {
    // The folder is made the first time it's used.
    assertEquals(await work(WORK.filesList, { scope: scope() }), []);
    assert(existsSync(join(root, "alpha")));

    const written = await work(WORK.filesWrite, {
      scope: scope(),
      path: "notes/today.txt",
      content: "hello world, héllo\n",
    });
    assertEquals(written, { path: "notes/today.txt", size: 20 });
    const top = await work<Entry[]>(WORK.filesList, { scope: scope() });
    assertEquals(top.map((e) => [e.name, e.type]), [["notes", "directory"]]);
    const notes = await work<Entry[]>(WORK.filesList, { scope: scope(), path: "./notes" });
    assertEquals(notes.map((e) => [e.name, e.type, e.size]), [["today.txt", "file", 20]]);
    assert(!Number.isNaN(Date.parse(notes[0].mtime)));

    const read = await work<FilesRead>(WORK.filesRead, { scope: scope(), path: "notes/today.txt" });
    assertEquals(read, {
      content: "hello world, héllo\n",
      encoding: "utf8",
      size: 20,
      truncated: false,
    });
    // A part, cut where a character is split: the character is left for the next part.
    const part = await work<FilesRead>(WORK.filesRead, {
      scope: scope(),
      path: "notes/today.txt",
      offset: 6,
      length: 9,
    });
    assertEquals([part.content, part.truncated], ["world, h", true]);

    // Bytes that aren't text come as base64.
    await work(WORK.filesWrite, {
      scope: scope(),
      path: "bin/data",
      content: btoa(String.fromCharCode(0, 1, 2, 255)),
      encoding: "base64",
    });
    const bytes = await work<FilesRead>(WORK.filesRead, { scope: scope(), path: "bin/data" });
    assertEquals([bytes.encoding, bytes.content, bytes.size], ["base64", "AAEC/w==", 4]);

    // An edit replaces text that's there exactly once, keeping the file's mode.
    writeFileSync(join(root, "alpha", "run.sh"), "echo one\necho two\necho two\n", { mode: 0o755 });
    const edited = await work(WORK.filesEdit, {
      scope: scope(),
      path: "run.sh",
      old: "one",
      new: "1",
    });
    assertEquals(edited, { path: "run.sh", size: 25 });
    // It keeps its mode (POSIX's: Windows has none such).
    if (process.platform !== "win32") {
      assertEquals(statSync(join(root, "alpha", "run.sh")).mode & 0o777, 0o755);
    }
    const twice = await work<Failed>(WORK.filesEdit, {
      scope: scope(),
      path: "run.sh",
      old: "echo two",
      new: "x",
    });
    assertEquals(twice.error.code, "ambiguous");
    const missing = await work<Failed>(WORK.filesEdit, {
      scope: scope(),
      path: "run.sh",
      old: "three",
      new: "x",
    });
    assertEquals(missing.error.code, "not_found");
    const after = await work<FilesRead>(WORK.filesRead, { scope: scope(), path: "run.sh" });
    assertEquals(after.content, "echo 1\necho two\necho two\n");

    // Reads take 256 KiB unless asked for more.
    await work(WORK.filesWrite, { scope: scope(), path: "big.txt", content: "x".repeat(300_000) });
    const big = await work<FilesRead>(WORK.filesRead, { scope: scope(), path: "big.txt" });
    assertEquals([big.content.length, big.size, big.truncated], [256 * 1024, 300_000, true]);
    const gone = await work<Failed>(WORK.filesRead, { scope: scope(), path: "nope.txt" });
    assertEquals(gone.error.code, "not_found");
    // Another space doesn't see it.
    assertEquals(await work(WORK.filesList, { scope: scope("beta") }), []);
  });
});

test("paths that leave the space's folder are refused", async () => {
  await setup(async ({ work, root }) => {
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "not yours");
    await work(WORK.filesWrite, { scope: scope(), path: "inside.txt", content: "mine" });
    mkdirSync(join(root, "beta"), { recursive: true });
    writeFileSync(join(root, "beta", "theirs.txt"), "another space's");
    symlinkSync(outside, join(root, "alpha", "out"));
    symlinkSync(join(outside, "secret.txt"), join(root, "alpha", "secret-link"));
    symlinkSync(join(root, "alpha", "inside.txt"), join(root, "alpha", "inside-link"));
    symlinkSync(join(outside, "nothing-yet"), join(root, "alpha", "dangling"));

    const refused = async (workload: string, input: Record<string, unknown>) => {
      const answer = await work<Failed>(workload, { scope: scope(), ...input });
      assertEquals(answer.error?.code, "invalid_path", `${workload} ${JSON.stringify(input)}`);
    };
    await refused(WORK.filesRead, { path: "../beta/theirs.txt" });
    await refused(WORK.filesRead, { path: join(outside, "secret.txt") });
    await refused(WORK.filesRead, { path: "/etc/hosts" });
    await refused(WORK.filesRead, { path: "out/secret.txt" });
    await refused(WORK.filesRead, { path: "secret-link" });
    await refused(WORK.filesList, { path: "out" });
    await refused(WORK.filesList, { path: ".." });
    await refused(WORK.filesWrite, { path: "../escape.txt", content: "x" });
    await refused(WORK.filesWrite, { path: "out/new.txt", content: "x" });
    await refused(WORK.filesWrite, { path: "secret-link", content: "x" });
    await refused(WORK.filesWrite, { path: "dangling", content: "x" });
    await refused(WORK.filesEdit, { path: "out/secret.txt", old: "not", new: "now" });
    assert(!existsSync(join(outside, "new.txt")) && !existsSync(join(outside, "nothing-yet")));
    assert(!existsSync(join(root, "escape.txt")));
    // A symlink that stays inside is followed.
    const linked = await work<FilesRead>(WORK.filesRead, { scope: scope(), path: "inside-link" });
    assertEquals(linked.content, "mine");
    // A folder that isn't one plain name is refused too.
    for (const folder of ["..", ".copilotz", "a/b"]) {
      const answer = await work<Failed>(WORK.filesList, { scope: { ...scope(), folder } });
      assertEquals(answer.error.code, "invalid", folder);
    }
  });
});

/** Puts `chunks` on computer c1 as an upload sends them: its answer. */
async function put(
  rt: Setup["rt"],
  head: Omit<FilesPutHead, "scope">,
  chunks: Uint8Array[],
): Promise<Partial<{ path: string; size: number; received: number }> & Partial<Failed>> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const job = await rt.workers.dispatch(
    "computer",
    "c1",
    WORK.filesPut,
    headed({ scope: scope(), ...head }, body),
  );
  const [text] = await Promise.all([new Response(job.output).text(), job.done]);
  return JSON.parse(text) as { path: string; size: number } & Partial<Failed>;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("a file put from bytes streamed in: written as they come, kept unless replaced, never half", async () => {
  await setup(async ({ rt, root }) => {
    const bytes = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
    const chunks = [
      bytes.subarray(0, 1000),
      bytes.subarray(1000, 2_000_000),
      bytes.subarray(2_000_000),
    ];
    const written = await put(rt, { path: "uploads/data.zip", size: bytes.length }, chunks);
    assertEquals(written, { path: "uploads/data.zip", size: bytes.length });
    const file = join(root, "alpha", "uploads", "data.zip");
    assertEquals(sha(readFileSync(file)), sha(bytes));

    // There already: kept, unless replaced.
    const again = await put(rt, { path: "uploads/data.zip", size: 3 }, [new Uint8Array([1, 2, 3])]);
    assertEquals(again.error?.code, "exists");
    assertEquals(sha(readFileSync(file)), sha(bytes));
    const replaced = await put(rt, { path: "uploads/data.zip", size: 3, replace: true }, [
      new Uint8Array([1, 2, 3]),
    ]);
    assertEquals(replaced, { path: "uploads/data.zip", size: 3 });
    assertEquals([...readFileSync(file)], [1, 2, 3]);

    // Fewer bytes than it said, or more: refused, and what was there stays as it was.
    const short = await put(rt, { path: "uploads/data.zip", size: 10, replace: true }, [
      new Uint8Array([9, 9]),
    ]);
    assertEquals(short.error?.code, "invalid");
    const long = await put(rt, { path: "uploads/data.zip", size: 1, replace: true }, [
      new Uint8Array([9, 9]),
    ]);
    assertEquals(long.error?.code, "invalid");
    assertEquals([...readFileSync(file)], [1, 2, 3]);
    // No temporary file is left beside it.
    assertEquals(readdirSync(join(root, "alpha", "uploads")), ["data.zip"]);

    // A folder there is never replaced; a path out of the folder, or too large, is refused.
    const folder = await put(rt, { path: "uploads", size: 1, replace: true }, [new Uint8Array(1)]);
    assertEquals(folder.error?.code, "exists");
    const out = await put(rt, { path: "../beta/x", size: 1 }, [new Uint8Array(1)]);
    assertEquals(out.error?.code, "invalid_path");
    const large = await put(rt, { path: "big.bin", size: MOST_PUT + 1 }, [new Uint8Array(1)]);
    assertEquals(large.error?.code, "too_large");
    assert(!existsSync(join(root, "alpha", "big.bin")));

    // An empty file is a file.
    assertEquals(await put(rt, { path: "empty", size: 0 }, []), { path: "empty", size: 0 });
  });
});

test("a large file written whole, as an agent saves one sent in a chat, arrives whole", async () => {
  await setup(async ({ work, root }) => {
    // About a chat file's most: 10 MB, as base64 in one JSON value.
    const bytes = new Uint8Array(randomBytes(10 * 1000 * 1000));
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const written = await work(WORK.filesWrite, {
      scope: scope(),
      path: "big.zip",
      content: btoa(text),
      encoding: "base64",
    });
    assertEquals(written, { path: "big.zip", size: bytes.length });
    assertEquals(sha(readFileSync(join(root, "alpha", "big.zip"))), sha(bytes));
  });
});

test("a file too large for one request comes in parts, in order, and is in place only at the last", async () => {
  await setup(async ({ rt, root }) => {
    const bytes = new Uint8Array(randomBytes(2_500_000));
    const id = "upload-0001";
    const part = (offset: number, end: number, more: Partial<FilesPutHead> = {}) =>
      put(rt, {
        path: "in/parts.bin",
        size: end - offset,
        upload: { id, offset, total: bytes.length },
        ...more,
      }, [bytes.subarray(offset, end)]);
    assertEquals(await part(0, 1_000_000), { received: 1_000_000 });
    // Nothing in the folder until the last part: the parts are kept apart.
    assert(!existsSync(join(root, "alpha", "in", "parts.bin")));
    assertEquals(readdirSync(join(root, ".copilotz", "uploads")), [`alpha.${id}`]);
    assertEquals(await part(1_000_000, 2_000_000), { received: 2_000_000 });
    assertEquals(await part(2_000_000, bytes.length), { path: "in/parts.bin", size: bytes.length });
    assertEquals(sha(readFileSync(join(root, "alpha", "in", "parts.bin"))), sha(bytes));
    assertEquals(readdirSync(join(root, ".copilotz", "uploads")), []);

    // A part out of order: the upload lost its way, and starts again; what it had goes.
    const other = { id: "upload-0002", total: 10 };
    const nine = new Uint8Array(9);
    const sent = await put(rt, { path: "x.bin", size: 4, upload: { ...other, offset: 0 } }, [
      nine.subarray(0, 4),
    ]);
    assertEquals(sent, { received: 4 });
    const skipped = await put(rt, { path: "x.bin", size: 2, upload: { ...other, offset: 8 } }, [
      nine.subarray(0, 2),
    ]);
    assertEquals(skipped.error?.code, "invalid");
    assertEquals(readdirSync(join(root, ".copilotz", "uploads")), []);

    // A file that came while its parts did is kept, unless replaced: asked again at the last.
    const late = { id: "upload-0003", total: 4 };
    await put(rt, { path: "late.txt", size: 2, upload: { ...late, offset: 0 } }, [
      new Uint8Array([1, 2]),
    ]);
    writeFileSync(join(root, "alpha", "late.txt"), "came first");
    const refused = await put(rt, { path: "late.txt", size: 2, upload: { ...late, offset: 2 } }, [
      new Uint8Array([3, 4]),
    ]);
    assertEquals(refused.error?.code, "exists");
    assertEquals(readFileSync(join(root, "alpha", "late.txt"), "utf8"), "came first");

    // Parts nobody finished go after a day, when the next upload starts.
    const stale = join(root, ".copilotz", "uploads", "alpha.upload-old");
    writeFileSync(stale, "abandoned");
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    utimesSync(stale, old, old);
    await put(rt, { path: "y.bin", size: 1, upload: { id: "upload-0004", offset: 0, total: 2 } }, [
      new Uint8Array([1]),
    ]);
    assert(!existsSync(stale));

    // An id that isn't one is refused before anything is kept.
    const odd = await put(rt, { path: "z", size: 1, upload: { id: "../x", offset: 0, total: 1 } }, [
      new Uint8Array([1]),
    ]);
    assertEquals(odd.error?.code, "invalid");
  });
});
