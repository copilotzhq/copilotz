/**
 * Work a computer couldn't do answers `{ error: { message, code } }` (see
 * workloads.ts): as an Error with that code, for whoever called; else
 * undefined.
 */
import type { Failed } from "./workloads.ts";

export function failed(answer: unknown): (Error & { code: string }) | undefined {
  const error = (answer as Partial<Failed> | null)?.error;
  if (!error || typeof error !== "object" || typeof error.message !== "string") return undefined;
  return Object.assign(new Error(error.message), { code: String(error.code ?? "failed") });
}
