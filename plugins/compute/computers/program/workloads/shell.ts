/**
 * The shell agents' commands run in: bash on macOS and Linux; on Windows,
 * PowerShell (7, `pwsh`, when it's on the PATH, else Windows PowerShell 5.1).
 * `computer.info` says which, so agents write commands for it.
 *
 * The terminal's shell is a loop reading command ids, one per line, and
 * running each one's script (`<directory>/<id>.sh` or `.ps1`) in its own
 * scope, so working directory, environment, variables and functions stay,
 * and a command reading stdin reads what's sent to it, not the next command.
 * After each, it prints a marker on stdout (with its exit code and working
 * directory) and on stderr, so both are drained before it's done:
 * `\x1e<token>:<id>:<code>:<cwd>\x1f`.
 */
import { Buffer } from "node:buffer";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";

export type Shell = { kind: "bash" | "powershell"; path: string };

/** Whether a file is there and can be run. */
const runnable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);

/** The first of `names` on the PATH. */
async function onPath(names: string[], env: Record<string, string | undefined>) {
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) if (await runnable(join(dir, name))) return join(dir, name);
  }
}

/** This computer's shell (see above). */
export async function findShell(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): Promise<Shell> {
  if (platform !== "win32") {
    return { kind: "bash", path: await onPath(["bash"], env) ?? "/bin/bash" };
  }
  const windows = join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
  return {
    kind: "powershell",
    path: await onPath(["pwsh.exe"], env) ?? join(windows, "powershell.exe"),
  };
}

/** Single quotes, for bash or PowerShell. */
const quote = (shell: Shell, text: string) =>
  shell.kind === "bash" ? `'${text.replaceAll("'", `'\\''`)}'` : `'${text.replaceAll("'", "''")}'`;

/** PowerShell's arguments for a script: given whole, so no quoting rule of Windows' touches it. */
const encoded = (script: string) => [
  "-NoLogo",
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(script, "utf16le").toString("base64"),
];

/** Every PowerShell's start: UTF-8 out, no progress bars. */
const PRELUDE = [
  "$ProgressPreference = 'SilentlyContinue'",
  "try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}",
  "$OutputEncoding = [Text.UTF8Encoding]::new($false)",
];

/**
 * Runs PowerShell `text` (an expression) as a script block in the shell's
 * own scope (no script file, so no execution policy applies), noting how its
 * last statement went for `CODE`.
 */
const run = (text: string) =>
  `$global:LASTEXITCODE = 0; $global:__copilotz_ok = $false
. ([ScriptBlock]::Create(${text} + "\`n\`$global:__copilotz_ok = \`$?"))`;

/** Its exit code: 0, a program's own when it was the one that failed, else 1. */
const CODE =
  "$(if ($global:__copilotz_ok) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 })";

/** The extension of its command scripts. */
export const scriptExtension = (shell: Shell): string => shell.kind === "bash" ? ".sh" : ".ps1";

/** How a command runs on its own in the shell (a job). */
export const commandArgs = (shell: Shell, command: string): string[] =>
  shell.kind === "bash"
    ? ["--noprofile", "--norc", "-c", command]
    : encoded([...PRELUDE, run(quote(shell, command)), `exit ${CODE}`].join("\n"));

/** How the terminal's shell starts: the loop running each command it's sent (see above). */
export function shellArgs(shell: Shell, directory: string, token: string): string[] {
  if (shell.kind === "bash") {
    return [
      "--noprofile",
      "--norc",
      "-c",
      [
        // Signals stop the command, not the shell (SIGKILL, after a grace, stops both).
        "trap ':' INT TERM",
        "while IFS= read -r __copilotz_id; do",
        "  case \"$__copilotz_id\" in *[!0-9a-f-]*|'') continue ;; esac",
        `  if source ${quote(shell, directory)}/"$__copilotz_id.sh"; then __copilotz_code=0; ` +
        "else __copilotz_code=$?; fi",
        "  set +e +u; set +o pipefail",
        `  builtin printf '\\036%s:%s:%d:%s\\037' ${token} "$__copilotz_id" "$__copilotz_code" "$PWD"`,
        `  builtin printf '\\036%s:%s:%d:\\037' ${token} "$__copilotz_id" "$__copilotz_code" >&2`,
        "done",
      ].join("\n"),
    ];
  }
  // Each command's output is formatted as it comes, wide, then its markers.
  return encoded([
    ...PRELUDE,
    `$__copilotz_dir = ${quote(shell, directory)}`,
    "while ($null -ne ($__copilotz_id = [Console]::In.ReadLine())) {",
    "  if ($__copilotz_id -notmatch '^[0-9a-f-]+$') { continue }",
    "  try {",
    '    $__copilotz_text = [IO.File]::ReadAllText((Join-Path $__copilotz_dir "$__copilotz_id.ps1"))',
    `    ${run("$__copilotz_text")} |`,
    "      Out-String -Stream -Width 200 | ForEach-Object { [Console]::Out.WriteLine($_) }",
    "  } catch {",
    "    [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())",
    "  }",
    `  $__copilotz_code = ${CODE}`,
    "  $__copilotz_cwd = (Get-Location).ProviderPath",
    "  try { [Environment]::CurrentDirectory = $__copilotz_cwd } catch {}",
    `  [Console]::Out.Write("$([char]30)${token}:$($__copilotz_id):$($__copilotz_code):$($__copilotz_cwd)$([char]31)")`,
    `  [Console]::Error.Write("$([char]30)${token}:$($__copilotz_id):$($__copilotz_code):$([char]31)")`,
    "}",
  ].join("\n"));
}
