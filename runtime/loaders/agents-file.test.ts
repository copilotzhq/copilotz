import {
  loadAgentsFileInstructions,
} from "./agents-file.ts";

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

Deno.test("loadAgentsFileInstructions reads AGENTS.md from current working directory", async () => {
  const previousCwd = Deno.cwd();
  const tempDir = await Deno.makeTempDir();

  try {
    await Deno.writeTextFile(`${tempDir}/AGENTS.md`, "# Local instructions\nBe careful.");
    Deno.chdir(tempDir);

    const loaded = await loadAgentsFileInstructions(undefined);

    assert(loaded !== null, "expected AGENTS instructions to load");
    assertEquals(loaded?.fileName, "AGENTS.md");
    assert(
      typeof loaded?.cwd === "string" &&
        (loaded.cwd === tempDir || loaded.cwd.endsWith(tempDir)),
      `expected cwd to resolve to ${tempDir}, received ${loaded?.cwd}`,
    );
    assertEquals(loaded?.content, "# Local instructions\nBe careful.");
  } finally {
    Deno.chdir(previousCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadAgentsFileInstructions returns null when disabled or missing", async () => {
  const previousCwd = Deno.cwd();
  const tempDir = await Deno.makeTempDir();

  try {
    Deno.chdir(tempDir);

    const disabled = await loadAgentsFileInstructions(false);
    const missing = await loadAgentsFileInstructions(true);

    assertEquals(disabled, null);
    assertEquals(missing, null);
  } finally {
    Deno.chdir(previousCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});
