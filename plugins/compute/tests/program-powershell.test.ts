/**
 * The terminal and jobs in PowerShell, as a Windows computer runs them, with
 * bash's contract: an answer within about a second, stdout and stderr apart
 * and drained, the working directory and environment kept, exit codes as
 * they are. Run wherever PowerShell 7 (`pwsh`) is on the PATH (Windows,
 * and CI's macOS and Linux); skipped elsewhere.
 */
import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";
import { tempDir, test } from "../../../testing/mod.ts";
import { createSpaces } from "../computers/program/workloads/spaces.ts";
import { commandArgs, newlines, type Shell } from "../computers/program/workloads/shell.ts";
import { createShells } from "../computers/program/workloads/terminal.ts";
import type { Scope, TerminalResult } from "../computers/shared/workloads.ts";

/** pwsh on the PATH, if it's there. */
async function findPwsh(): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["pwsh", "pwsh.exe"]) {
      const path = join(dir, name);
      if (await access(path).then(() => true, () => false)) return path;
    }
  }
}

const pwsh = await findPwsh();
const shell: Shell = { kind: "powershell", path: pwsh ?? "pwsh" };
const scope: Scope = { space: "s", folder: "alpha", who: "agent:a" };

/** Shells in PowerShell, stopped after `fn`. */
async function shells(fn: (run: (stdin: string) => Promise<TerminalResult>) => Promise<void>) {
  const all = createShells(createSpaces(tempDir()), shell);
  const run = async (stdin: string) => {
    let result = await all.submit({ scope, stdin });
    let { stdout, stderr } = result;
    // Polled until done, its output gathered.
    while (result.state === "running") {
      result = await all.submit({ scope, stdin: "", commandId: result.commandId });
      stdout += result.stdout;
      stderr += result.stderr;
    }
    return { ...result, stdout, stderr };
  };
  try {
    await fn(run);
  } finally {
    await all.stopAll();
  }
}

test({
  name:
    "PowerShell keeps the working directory, environment and variables; stdout and stderr apart",
  ignore: !pwsh,
  fn: () =>
    shells(async (run) => {
      const first = await run(
        "New-Item -ItemType Directory sub | Out-Null; Set-Location sub; $env:X_SECRET = 'one'; " +
          "$kept = 41; 'set'",
      );
      assertEquals([first.stdout, first.exitCode, first.cwd], ["set\n", 0, "sub"]);
      const again = await run('"x=$env:X_SECRET kept=$($kept + 1)"; (Get-Location).Path');
      assertMatch(again.stdout, /^x=one kept=42\n.*alpha.sub\n$/);
      assertEquals(again.cwd, "sub");
      const both = await run("'out'; Write-Error 'err' -ErrorAction Continue");
      assertEquals(both.stdout, "out\n");
      assertStringIncludes(both.stderr, "err");
      assertEquals(both.exitCode, 1);
      // Output of objects is formatted, as it is at a prompt; non-ASCII stays itself.
      const items = await run("1..3; 'café'");
      assertEquals(items.stdout, "1\n2\n3\ncafé\n");
    }),
});

test({
  name:
    "PowerShell exit codes: a program's own, 1 when a command fails or throws, a shell that exits ends",
  ignore: !pwsh,
  fn: () =>
    shells(async (run) => {
      const program = await run(`& '${shell.path}' -NoProfile -Command 'exit 4'`);
      assertEquals(program.exitCode, 4);
      // A program failing earlier doesn't fail what comes after it.
      const after = await run(`& '${shell.path}' -NoProfile -Command 'exit 4'; 'fine'`);
      assertEquals([after.stdout, after.exitCode], ["fine\n", 0]);
      const thrown = await run("throw 'nope'");
      assertEquals(thrown.exitCode, 1);
      assertStringIncludes(thrown.stderr, "nope");
      const parse = await run("if (");
      assertEquals(parse.exitCode, 1);
      const exited = await run("exit 3");
      assertEquals(exited.exitCode, 3);
      // Its shell ended; the next command gets a new one, at the space's folder.
      assertEquals((await run("'back'")).cwd, ".");
    }),
});

test({
  name: "PowerShell: a long command answers while it runs, then polls to completion",
  ignore: !pwsh,
  fn: async () => {
    const all = createShells(createSpaces(tempDir()), shell);
    try {
      const started = await all.submit({ scope, stdin: "'starting'; Start-Sleep 2; 'finished'" });
      assertEquals([started.state, started.stdout], ["running", "starting\n"]);
      let result = started;
      while (result.state === "running") {
        result = await all.submit({ scope, stdin: "", commandId: started.commandId });
      }
      assertEquals([result.stdout, result.exitCode], ["finished\n", 0]);
    } finally {
      await all.stopAll();
    }
  },
});

test({
  name: "a PowerShell job runs a command whole, with its exit code",
  ignore: !pwsh,
  fn: async () => {
    const child = spawn(shell.path, commandArgs(shell, `"it's $(1 + 1)"; exit 5`), {
      cwd: tempDir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Its lines as the program reads them (Windows' end "\r\n").
    let out = "";
    const lines = newlines(shell);
    child.stdout!.setEncoding("utf8").on("data", (text: string) => out += lines.text(text));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assertEquals([out + lines.end(), code], ["it's 2\n", 5]);
  },
});
