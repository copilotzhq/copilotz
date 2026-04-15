import {
  applyWorkspacePatch,
  getWorkspaceFileDiff,
  readWorkspaceFile,
  restoreWorkspaceFileVersion,
  searchWorkspaceCode,
  writeWorkspaceFile,
} from "./fs-utils.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `Assertion failed.\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("fs-utils supports ranged reads, patch snapshots, diffs, and restore", async () => {
  const previousCwd = Deno.cwd();
  const tempDir = await Deno.makeTempDir();

  try {
    Deno.chdir(tempDir);
    await Deno.writeTextFile(
      `${tempDir}/example.ts`,
      "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n",
    );

    const ranged = await readWorkspaceFile("example.ts", {
      startLine: 2,
      endLine: 3,
      includeLineNumbers: true,
    });
    assertEquals(
      ranged.content,
      "2: const b = 2;\n3: console.log(a + b);",
    );

    const patched = await applyWorkspacePatch("example.ts", [{
      type: "replace",
      oldText: "const b = 2;",
      newText: "const b = 3;",
    }]);

    assert(typeof patched.snapshotId === "string", "expected snapshot id");

    const diff = await getWorkspaceFileDiff("example.ts");
    assertEquals(diff.changed, true);
    assert(diff.hunks.length > 0, "expected at least one diff hunk");

    const restored = await restoreWorkspaceFileVersion(
      "example.ts",
      patched.snapshotId ?? undefined,
    );
    assertEquals(restored.restoredFromSnapshotId, patched.snapshotId);

    const finalContent = await Deno.readTextFile(`${tempDir}/example.ts`);
    assertEquals(
      finalContent,
      "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n",
    );
  } finally {
    Deno.chdir(previousCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("searchWorkspaceCode returns line-level matches", async () => {
  const previousCwd = Deno.cwd();
  const tempDir = await Deno.makeTempDir();

  try {
    Deno.chdir(tempDir);
    await writeWorkspaceFile(
      "src/example.ts",
      "export const message = 'hello';\nconsole.log(message);\n",
      { createDirs: true },
    );

    const results = await searchWorkspaceCode({
      query: "message",
      directory: ".",
      filePattern: "*.ts",
    });

    assertEquals(results.results.length, 1);
    assertEquals(results.results[0]?.matches[0]?.line, 1);
  } finally {
    Deno.chdir(previousCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});
