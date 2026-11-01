/**
 * Refusals, as everything throws and answers them: a message people read, and
 * a code callers act on. `people` and `inPerson` are what most Actions `allow`.
 */
import type { Actor } from "./store.ts";

export const failure = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });
export const forbidden = (message: string): Error & { code: string } =>
  failure("forbidden", message);
export const invalid = (message: string): Error & { code: string } => failure("invalid", message);

/** People, and keys acting for them. */
export const people = (actor: Actor): boolean => actor.kind === "person";
/** A person themselves: not a key, for what only they decide. */
export const inPerson = (actor: Actor): boolean => actor.kind === "person" && !actor.key;
