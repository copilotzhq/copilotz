/**
 * Refusals, as everything throws and answers them: a message people read, and
 * a code callers act on. `people` and `inPerson` are what most Actions `allow`;
 * the few that contacts may call too say `peopleOrContacts`.
 *
 * A failure made `public` says its message to whoever called, wherever they
 * are: also to a model outside the app (over MCP), which no other error's
 * words reach (a driver's, a stack's, the runtime's about its insides, a
 * store's about a document). A tool's refusal meant for the model that
 * called it is public: "Search trips first."
 */
import type { Actor } from "./store.ts";

/** What a failure says about itself beyond its code: whether its message is for any caller. */
export type FailureOptions = { public?: boolean };

export const failure = (
  code: string,
  message: string,
  options: FailureOptions = {},
): Error & { code: string; public?: true } =>
  Object.assign(new Error(message), { code }, options.public ? { public: true as const } : {});

/** Whether an error's message is for any caller (`failure(code, message, { public: true })`). */
export const isPublic = (error: unknown): boolean =>
  (error as { public?: unknown } | null)?.public === true;
export const forbidden = (message: string): Error & { code: string } =>
  failure("forbidden", message);
export const invalid = (message: string): Error & { code: string } => failure("invalid", message);

/** People, and keys acting for them. */
export const people = (actor: Actor): boolean => actor.kind === "person";
/** A person themselves: not a key, for what only they decide. */
export const inPerson = (actor: Actor): boolean => actor.kind === "person" && !actor.key;
/** A contact: someone outside the org talking to an app's agents (a WhatsApp customer). */
export const contacts = (actor: Actor): boolean => actor.kind === "contact";
/** People, and contacts: what an Action opened to contacts allows. */
export const peopleOrContacts = (actor: Actor): boolean => people(actor) || contacts(actor);
