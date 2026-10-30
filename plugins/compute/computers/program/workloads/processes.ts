/**
 * What every child process shares: the person's environment (minus the
 * program's own `COPILOTZ_*` settings), a tree of its own that stopping
 * reaches whole, and an exit code even when a signal ended it.
 *
 * On macOS and Linux a child leads its own process group (spawned detached),
 * and signals go to the group. Windows has neither groups nor signals: a
 * child gets no window of its own; SIGINT and SIGTERM end what it started
 * (so a shell outlives its command there too), and SIGKILL its whole tree
 * (`taskkill /T /F`).
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import process from "node:process";

/** Whether this is Windows. */
export const WINDOWS = process.platform === "win32";

/** How every child is spawned: its own process group, or (on Windows) no window of its own. */
export const OWN: { detached?: boolean; windowsHide?: boolean } = WINDOWS
  ? { windowsHide: true }
  : { detached: true };

/** The environment children inherit: the person's, without `COPILOTZ_*`. */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("COPILOTZ_")) env[key] = value;
  }
  return env;
}

/** Whether process `pid` is running. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string })?.code === "EPERM";
  }
}

/** Runs a Windows command to stop processes, and forgets it. */
const quietly = (command: string, args: string[]) =>
  spawn(command, args, { stdio: "ignore", windowsHide: true }).on("error", () => {});

/** Sends `signal` to the tree a child leads (on Windows, as above); false if it's gone. */
export function signalGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  if (!WINDOWS) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  if (!alive(pid)) return false;
  if (signal === "SIGKILL") quietly("taskkill.exe", ["/T", "/F", "/PID", String(pid)]);
  else {
    // Its children (the programs its command runs), each with theirs.
    quietly("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ` +
      `Where-Object { $_.Name -ne 'conhost.exe' } | ` +
      `ForEach-Object { taskkill.exe /T /F /PID $_.ProcessId | Out-Null }`,
    ]);
  }
  return true;
}

/** An exit code, as a shell reports it: 128 + the signal's number when one ended it. */
export function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return 128 + ((signal && constants.signals[signal]) || 0);
}
