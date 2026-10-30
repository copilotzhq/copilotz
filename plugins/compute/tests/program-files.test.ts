/**
 * The computer's files: listed, read, written and edited in a space's folder,
 * and nowhere else (no `..`, no absolute paths, no symlinks leading out).
 */
import { assert, assertEquals } from "@std/assert";
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, test } from "../../../testing/mod.ts";
import { type Entry, type FilesRead, type Scope, WORK } from "../computers/shared/workloads.ts";
import { setup } from "./program-setup.ts";

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
    assertEquals(statSync(join(root, "alpha", "run.sh")).mode & 0o777, 0o755);
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
