/**
 * What every child process shares: the person's environment (minus the
 * program's own `COPILOTZ_*` settings), its own process group, so a signal
 * reaches everything it started, and an exit code even when a signal ended it.
 */
import { constants } from "node:os";
import process from "node:process";

/** The environment children inherit: the person's, without `COPILOTZ_*`. */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("COPILOTZ_")) env[key] = value;
  }
  return env;
}

/** Sends `signal` to a process group (a child spawned detached leads its own); false if it's gone. */
export function signalGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** An exit code, as a shell reports it: 128 + the signal's number when one ended it. */
export function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return 128 + ((signal && constants.signals[signal]) || 0);
}
